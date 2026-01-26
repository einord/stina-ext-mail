/**
 * Mail Reader Extension for Stina
 *
 * Reads incoming emails from configured accounts and notifies Stina.
 */

import {
  initializeExtension,
  type ExtensionContext,
  type ExecutionContext,
  type Disposable,
} from '@stina/extension-api/runtime'
import { MailRepository, type DatabaseAPI } from './db/repository.js'
import { ProviderRegistry, getProviderLabel, type ProviderConfig } from './providers/index.js'
import { IdleManager } from './imap/idle.js'
import { formatEmailInstruction } from './imap/parser.js'
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
import type { EditState, EditFormState, AccountDisplayData, MailProvider } from './types.js'
import {
  initiateGmailAuth,
  pollGmailToken,
  initiateOutlookAuth,
  pollOutlookToken,
} from './oauth/index.js'

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
    schedule: { type: 'at'; at: string } | { type: 'interval'; seconds: number }
    payload?: Record<string, unknown>
    userId: string
  }) => Promise<void>
  cancel: (jobId: string) => Promise<void>
  onFire: (
    callback: (payload: { jobId: string; payload?: Record<string, unknown> }, execContext: ExecutionContext) => void
  ) => Disposable
}

// In-memory edit state (per user)
const editStates = new Map<string, EditState>()

function getDefaultEditState(): EditState {
  return {
    showModal: false,
    modalTitle: 'Add Account',
    editingId: null,
    form: {
      provider: 'icloud',
      name: '',
      email: '',
      password: '',
      imapHost: '',
      imapPort: '993',
      username: '',
    },
    oauthStatus: 'pending',
    oauthUrl: '',
    oauthCode: '',
  }
}

function getEditState(userId: string): EditState {
  if (!editStates.has(userId)) {
    editStates.set(userId, getDefaultEditState())
  }
  return editStates.get(userId)!
}

function activate(context: ExtensionContext): Disposable {
  context.log.info('Activating Mail Reader extension')

  if (!context.database) {
    context.log.warn('Database permission missing; Mail Reader disabled')
    return { dispose: () => undefined }
  }

  const repository = new MailRepository(context.database as DatabaseAPI)
  void repository.initialize()

  const providers = new ProviderRegistry()
  const eventsApi = (context as ExtensionContext & { events?: EventsApi }).events
  const actionsApi = (context as ExtensionContext & { actions?: ActionsApi }).actions
  const settingsApi = (context as ExtensionContext & { settings?: SettingsApi }).settings
  const chat = (context as ExtensionContext & { chat?: ChatAPI }).chat
  const scheduler = (context as ExtensionContext & { scheduler?: SchedulerAPI }).scheduler

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
    // Handle new mail notification
    context.log.info('New mail detected', { accountId })
    // In a full implementation, fetch the new emails and notify Stina
  })

  // Handle new email notification
  const handleNewEmail = async (
    accountId: string,
    userId: string
  ): Promise<void> => {
    if (!chat) return

    try {
      const userRepo = repository.withUser(userId)
      const account = await userRepo.accounts.get(accountId)
      if (!account || !account.enabled) return

      const settings = await userRepo.settings.get()
      const provider = providers.getRequired(account.provider)
      const sinceUid = await userRepo.processed.getHighestUid(accountId)

      const emails = await provider.fetchNewEmails(account, account.credentials, sinceUid)

      for (const email of emails) {
        // Check if already processed
        const isProcessed = await userRepo.processed.isProcessed(accountId, email.messageId)
        if (isProcessed) continue

        // Format instruction for Stina
        const instruction = formatEmailInstruction(
          {
            from: email.from,
            to: email.to,
            subject: email.subject,
            date: email.date,
            body: email.body,
          },
          account.name,
          settings.instruction
        )

        // Send to Stina
        await chat.appendInstruction({ text: instruction, userId })

        // Mark as processed
        await userRepo.processed.markProcessed(accountId, email.messageId, email.uid)
      }

      // Update sync status
      await userRepo.accounts.updateSyncStatus(accountId, null)
    } catch (error) {
      context.log.warn('Failed to handle new email', {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Register UI actions
  const actionDisposables = actionsApi
    ? [
        // Get accounts for display
        actionsApi.register({
          id: 'getAccounts',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            try {
              const userRepo = repository.withUser(execContext.userId)
              const accounts = await userRepo.accounts.list()

              const displayData: AccountDisplayData[] = accounts.map((account) => ({
                id: account.id,
                name: account.name,
                email: account.email,
                provider: account.provider,
                providerLabel: getProviderLabel(account.provider),
                statusVariant: account.lastError
                  ? 'danger'
                  : account.enabled
                    ? 'success'
                    : 'default',
                enabled: account.enabled,
                lastSyncAt: account.lastSyncAt,
                lastError: account.lastError,
              }))

              return { success: true, data: displayData }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),

        // Get edit state
        actionsApi.register({
          id: 'getEditState',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            return { success: true, data: getEditState(execContext.userId) }
          },
        }),

        // Show add form
        actionsApi.register({
          id: 'showAddForm',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const state = getEditState(execContext.userId)
            state.showModal = true
            state.modalTitle = 'Add Account'
            state.editingId = null
            state.form = {
              provider: 'icloud',
              name: '',
              email: '',
              password: '',
              imapHost: '',
              imapPort: '993',
              username: '',
            }
            state.oauthStatus = 'pending'
            state.oauthUrl = ''
            state.oauthCode = ''

            emitEditChanged()
            return { success: true }
          },
        }),

        // Edit account
        actionsApi.register({
          id: 'editAccount',
          async execute(params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const id = params.id as string
            const userRepo = repository.withUser(execContext.userId)
            const account = await userRepo.accounts.get(id)

            if (!account) {
              return { success: false, error: 'Account not found' }
            }

            const state = getEditState(execContext.userId)
            state.showModal = true
            state.modalTitle = 'Edit Account'
            state.editingId = id
            state.form = {
              provider: account.provider,
              name: account.name,
              email: account.email,
              password: '',
              imapHost: account.imapHost || '',
              imapPort: String(account.imapPort || 993),
              username:
                account.credentials.type === 'password' ? account.credentials.username : '',
            }
            state.oauthStatus =
              account.credentials.type === 'oauth2' ? 'connected' : 'pending'
            state.oauthUrl = ''
            state.oauthCode = ''

            emitEditChanged()
            return { success: true }
          },
        }),

        // Close modal
        actionsApi.register({
          id: 'closeModal',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const state = getEditState(execContext.userId)
            state.showModal = false

            emitEditChanged()
            return { success: true }
          },
        }),

        // Update form field
        actionsApi.register({
          id: 'updateFormField',
          async execute(params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const state = getEditState(execContext.userId)
            const field = params.field as keyof EditFormState
            const value = params.value as string

            state.form[field] = value as never

            // Reset OAuth status when provider changes
            if (field === 'provider') {
              state.oauthStatus = 'pending'
              state.oauthUrl = ''
              state.oauthCode = ''
            }

            emitEditChanged()
            return { success: true }
          },
        }),

        // Start OAuth flow
        actionsApi.register({
          id: 'startOAuth',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const state = getEditState(execContext.userId)
            const config = providers.getConfig()

            try {
              if (state.form.provider === 'gmail') {
                if (!config.gmailClientId || !config.gmailClientSecret) {
                  return {
                    success: false,
                    error: 'Gmail OAuth not configured. Please set Client ID and Secret in admin settings.',
                  }
                }

                const result = await initiateGmailAuth({
                  clientId: config.gmailClientId,
                  clientSecret: config.gmailClientSecret,
                })

                state.oauthStatus = 'awaiting'
                state.oauthUrl = result.verificationUrl
                state.oauthCode = result.userCode

                // Start polling in background
                void pollForOAuthToken(
                  execContext.userId,
                  'gmail',
                  result.deviceCode,
                  result.interval,
                  config
                )
              } else if (state.form.provider === 'outlook') {
                if (!config.outlookClientId) {
                  return {
                    success: false,
                    error: 'Outlook OAuth not configured. Please set Client ID in admin settings.',
                  }
                }

                const result = await initiateOutlookAuth({
                  clientId: config.outlookClientId,
                  tenantId: config.outlookTenantId,
                })

                state.oauthStatus = 'awaiting'
                state.oauthUrl = result.verificationUrl
                state.oauthCode = result.userCode

                // Start polling in background
                void pollForOAuthToken(
                  execContext.userId,
                  'outlook',
                  result.deviceCode,
                  result.interval,
                  config
                )
              }

              emitEditChanged()
              return { success: true }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),

        // Test connection
        actionsApi.register({
          id: 'testConnection',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const state = getEditState(execContext.userId)

            // Build temporary account for testing
            const testAccount = {
              id: 'test',
              userId: execContext.userId,
              provider: state.form.provider as MailProvider,
              name: state.form.name,
              email: state.form.email,
              imapHost: state.form.imapHost || null,
              imapPort: parseInt(state.form.imapPort, 10) || null,
              authType: 'password' as const,
              credentials: {
                type: 'password' as const,
                username: state.form.username || state.form.email,
                password: state.form.password,
              },
              enabled: true,
              lastSyncAt: null,
              lastError: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }

            try {
              const provider = providers.getRequired(testAccount.provider)
              const connected = await provider.testConnection(
                testAccount,
                testAccount.credentials
              )

              return {
                success: true,
                data: {
                  connected,
                  message: connected ? 'Connection successful!' : 'Connection failed',
                },
              }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),

        // Save account
        actionsApi.register({
          id: 'saveAccount',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const state = getEditState(execContext.userId)
            const userRepo = repository.withUser(execContext.userId)

            try {
              await userRepo.accounts.upsert(state.editingId || undefined, {
                provider: state.form.provider as MailProvider,
                name: state.form.name,
                email: state.form.email,
                imapHost: state.form.imapHost || undefined,
                imapPort: state.form.imapPort ? parseInt(state.form.imapPort, 10) : undefined,
                username: state.form.username || undefined,
                password: state.form.password || undefined,
              })

              state.showModal = false
              emitEditChanged()
              emitAccountChanged()

              return { success: true }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),

        // Delete account
        actionsApi.register({
          id: 'deleteAccount',
          async execute(params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const id = params.id as string
            const userRepo = repository.withUser(execContext.userId)

            try {
              await userRepo.accounts.delete(id)
              emitAccountChanged()
              return { success: true }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),

        // Get settings
        actionsApi.register({
          id: 'getSettings',
          async execute(_params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            try {
              const userRepo = repository.withUser(execContext.userId)
              const settings = await userRepo.settings.get()
              return {
                success: true,
                data: { instruction: settings.instruction },
              }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),

        // Update setting
        actionsApi.register({
          id: 'updateSetting',
          async execute(params, execContext) {
            if (!execContext.userId) {
              return { success: false, error: 'User context required' }
            }

            const key = params.key as string
            const value = params.value as string

            try {
              const userRepo = repository.withUser(execContext.userId)

              if (key === 'instruction') {
                await userRepo.settings.update({ instruction: value })
              }

              emitSettingsChanged()
              return { success: true }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          },
        }),
      ]
    : []

  // Poll for OAuth token in background
  const pollForOAuthToken = async (
    userId: string,
    provider: 'gmail' | 'outlook',
    deviceCode: string,
    interval: number,
    config: ProviderConfig
  ): Promise<void> => {
    const maxAttempts = 60 // 5 minutes at 5 second intervals
    const state = getEditState(userId)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))

      try {
        let token = null

        if (provider === 'gmail' && config.gmailClientId && config.gmailClientSecret) {
          token = await pollGmailToken(
            { clientId: config.gmailClientId, clientSecret: config.gmailClientSecret },
            deviceCode
          )
        } else if (provider === 'outlook' && config.outlookClientId) {
          token = await pollOutlookToken(
            { clientId: config.outlookClientId, tenantId: config.outlookTenantId },
            deviceCode
          )
        }

        if (token) {
          // Save the account with OAuth credentials
          const userRepo = repository.withUser(userId)
          await userRepo.accounts.upsert(state.editingId || undefined, {
            provider,
            name: state.form.name,
            email: state.form.email,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
          })

          state.oauthStatus = 'connected'
          state.showModal = false
          emitEditChanged()
          emitAccountChanged()
          return
        }
      } catch (error) {
        // Continue polling unless fatal error
        if (
          error instanceof Error &&
          !error.message.includes('authorization_pending') &&
          !error.message.includes('slow_down')
        ) {
          context.log.warn('OAuth polling failed', { error: error.message })
          state.oauthStatus = 'pending'
          emitEditChanged()
          return
        }
      }
    }

    // Timeout
    state.oauthStatus = 'pending'
    emitEditChanged()
  }

  // Register tools
  const disposables = [
    ...actionDisposables,
    context.tools!.register(createListAccountsTool(repository)),
    context.tools!.register(createAddAccountTool(repository, providers)),
    context.tools!.register(createUpdateAccountTool(repository)),
    context.tools!.register(
      createDeleteAccountTool(repository, (accountId) => {
        emitAccountChanged()
        void idleManager.stopIdle(accountId)
      })
    ),
    context.tools!.register(createTestAccountTool(repository, providers)),
    context.tools!.register(createListRecentTool(repository, providers)),
    context.tools!.register(createGetMailTool(repository, providers)),
    context.tools!.register(createGetSettingsTool(repository)),
    context.tools!.register(
      createUpdateSettingsTool(repository, () => emitSettingsChanged())
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

  return {
    dispose: () => {
      void idleManager.stopAll()
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
