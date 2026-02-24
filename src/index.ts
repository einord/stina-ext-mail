/**
 * Mail Reader Extension for Stina
 *
 * Reads incoming emails from configured accounts and notifies Stina.
 * Uses the Extension Storage API for data persistence and Secrets API for credentials.
 */

import {
  initializeExtension,
  type ExtensionContext,
  type ExecutionContext,
  type Disposable,
  type BackgroundWorkersAPI,
  type StorageAPI,
  type SecretsAPI,
} from '@stina/extension-api/runtime'
import { ExtensionRepository } from './db/repository.js'
import { ProviderRegistry, type ProviderConfig } from './providers/index.js'
import { IdleManager } from './imap/idle.js'
import {
  createListAccountsTool,
  createAddAccountTool,
  createUpdateAccountTool,
  createDeleteAccountTool,
  createTestAccountTool,
  createListRecentTool,
  createGetMailTool,
  createGetSettingsTool,
  createUpdateSettingsTool,
} from './tools/index.js'
import { registerActions } from './actions/index.js'
import { handleNewEmail, createPollingScheduler, persistKnownUser } from './polling.js'
import { createIdleWorkerManager } from './idle-worker.js'
import { clearAllEditStates } from './edit-state.js'

type EventsApi = { emit: (name: string, payload?: Record<string, unknown>) => Promise<void> }

type ActionsApi = {
  register: (action: {
    id: string
    execute: (
      params: Record<string, unknown>,
      execContext: ExecutionContext
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  }) => { dispose: () => void }
}

type SettingsApi = {
  get: <T = string>(key: string) => Promise<T | undefined>
}

type ChatAPI = {
  appendInstruction: (message: {
    text: string
    conversationId?: string
    userId?: string
  }) => Promise<void>
}

type SchedulerAPI = {
  schedule: (job: {
    id: string
    schedule: { type: 'at'; at: string } | { type: 'interval'; everyMs: number } | { type: 'cron'; cron: string; timezone?: string }
    payload?: Record<string, unknown>
    userId: string
  }) => Promise<void>
  cancel: (jobId: string) => Promise<void>
  onFire: (
    callback: (payload: { id: string; payload?: Record<string, unknown>; userId: string }, execContext: ExecutionContext) => void
  ) => Disposable
}

type UserProfile = {
  firstName?: string
  nickname?: string
  language?: string
  timezone?: string
}

type UserAPI = {
  getProfile: (userId?: string) => Promise<UserProfile>
  listIds?: () => Promise<string[]>
}

function activate(context: ExtensionContext): Disposable {
  context.log.info('Activating Mail Reader extension')

  // Check for required permissions
  if (!context.storage) {
    context.log.warn('Storage permission missing; Mail Reader disabled')
    return { dispose: () => undefined }
  }

  if (!context.secrets) {
    context.log.warn('Secrets permission missing; Mail Reader disabled')
    return { dispose: () => undefined }
  }

  // Extension-scoped repository for tracking users across the system
  const extensionRepo = new ExtensionRepository(context.storage)

  const providers = new ProviderRegistry()
  const eventsApi = (context as ExtensionContext & { events?: EventsApi }).events
  const actionsApi = (context as ExtensionContext & { actions?: ActionsApi }).actions
  const settingsApi = (context as ExtensionContext & { settings?: SettingsApi }).settings
  const chat = (context as ExtensionContext & { chat?: ChatAPI }).chat
  if (!chat) {
    context.log.warn('Chat API not available — email notifications will be disabled')
  } else {
    context.log.info('Chat API available — email notifications enabled')
  }
  const scheduler = (context as ExtensionContext & { scheduler?: SchedulerAPI }).scheduler
  const backgroundWorkers = (context as ExtensionContext & { backgroundWorkers?: BackgroundWorkersAPI }).backgroundWorkers
  const user = (context as ExtensionContext & { user?: UserAPI }).user

  // Event emitters
  const emitAccountChanged = () => {
    if (!eventsApi) return
    void eventsApi.emit('mail.account.changed', { at: new Date().toISOString() })
  }

  const emitSettingsChanged = () => {
    if (!eventsApi) return
    void eventsApi.emit('mail.settings.changed', { at: new Date().toISOString() })
  }

  const emitEditChanged = () => {
    if (!eventsApi) return
    void eventsApi.emit('mail.edit.changed', { at: new Date().toISOString() })
  }

  // Load OAuth configuration from settings
  const loadProviderConfig = async (): Promise<void> => {
    if (!settingsApi) return

    const config: ProviderConfig = {}

    const gmailClientId = await settingsApi.get<string>('gmail_client_id')
    const gmailClientSecret = await settingsApi.get<string>('gmail_client_secret')
    const outlookClientId = await settingsApi.get<string>('outlook_client_id')
    const outlookTenantId = await settingsApi.get<string>('outlook_tenant_id')

    if (gmailClientId) config.gmailClientId = gmailClientId
    if (gmailClientSecret) config.gmailClientSecret = gmailClientSecret
    if (outlookClientId) config.outlookClientId = outlookClientId
    if (outlookTenantId) config.outlookTenantId = outlookTenantId

    providers.setConfig(config)
  }

  void loadProviderConfig()

  // IDLE manager for real-time notifications
  const idleManager = new IdleManager(async (accountId) => {
    context.log.info('New mail detected', { accountId })
  })

  // Polling dependencies
  const storagePath = context.extension.storagePath
  const pollingDeps = {
    providers,
    extensionRepo,
    chat,
    scheduler,
    user,
    storagePath,
    log: context.log,
  }

  // Set up polling scheduler
  const pollingScheduler = createPollingScheduler(pollingDeps)

  // Set up IDLE worker manager
  const idleWorkerManager = createIdleWorkerManager({
    providers,
    backgroundWorkers,
    handleNewEmail: (accountId: string, userStorage: StorageAPI, userSecrets: SecretsAPI, userId: string) =>
      handleNewEmail(accountId, userStorage, userSecrets, userId, pollingDeps),
    log: context.log,
  })

  // Self-healing: ensure user is registered and polling when tools discover accounts
  const ensureUserPolling = async (userId: string): Promise<void> => {
    try {
      await extensionRepo.registerUser(userId)
      if (storagePath) {
        await persistKnownUser(storagePath, userId)
      }
      await pollingScheduler.schedulePollingForUser(userId)
      await idleWorkerManager.startIdleWorkerForUser(userId)
    } catch (error) {
      context.log.debug('Failed to ensure user polling', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Register UI actions
  const actionDisposables = actionsApi
    ? registerActions(actionsApi, {
        extensionRepo,
        providers,
        emitAccountChanged,
        emitSettingsChanged,
        emitEditChanged,
        schedulePollingForUser: pollingScheduler.schedulePollingForUser,
        ensureUserPolling,
        log: context.log,
      })
    : []

  // Register tools
  const disposables = [
    ...actionDisposables,
    context.tools!.register(createListAccountsTool(ensureUserPolling)),
    context.tools!.register(createAddAccountTool(providers, ensureUserPolling)),
    context.tools!.register(
      createDeleteAccountTool((accountId) => {
        emitAccountChanged()
        void idleManager.stopIdle(accountId)
      })
    ),
    context.tools!.register(createUpdateAccountTool()),
    context.tools!.register(createTestAccountTool(providers)),
    context.tools!.register(createListRecentTool(providers, ensureUserPolling)),
    context.tools!.register(createGetMailTool(providers)),
    context.tools!.register(createGetSettingsTool()),
    context.tools!.register(
      createUpdateSettingsTool(() => emitSettingsChanged())
    ),
  ]

  context.log.info('Mail Reader registered', {
    tools: [
      'mail_accounts_list',
      'mail_accounts_add',
      'mail_accounts_update',
      'mail_accounts_delete',
      'mail_accounts_test',
      'mail_list_recent',
      'mail_get',
    ],
    actions: actionsApi
      ? [
          'getAccounts',
          'getEditState',
          'showAddForm',
          'editAccount',
          'closeModal',
          'updateFormField',
          'startOAuth',
          'testConnection',
          'saveAccount',
          'deleteAccount',
          'getSettings',
          'updateSetting',
        ]
      : [],
  })

  // Listen for scheduler events
  const schedulerDisposable = pollingScheduler.setupSchedulerListener()

  // Auto-start polling for all existing users with accounts
  void pollingScheduler.initializePollingForExistingUsers(
    idleWorkerManager.startIdleWorkerForUser
  ).catch((err) =>
    context.log.warn('Failed to initialize polling', {
      error: err instanceof Error ? err.message : String(err),
    })
  )

  return {
    dispose: () => {
      void idleManager.stopAll()
      schedulerDisposable?.dispose()
      idleWorkerManager.stopAll()
      pollingScheduler.cancelAll()
      clearAllEditStates()
      for (const disposable of disposables) {
        disposable.dispose()
      }
      context.log.info('Mail Reader extension deactivated')
    },
  }
}

function deactivate(): void {
  // Cleanup handled by disposable returned from activate
}

initializeExtension({ activate, deactivate })
