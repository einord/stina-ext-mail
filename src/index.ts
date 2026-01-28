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
  type BackgroundWorkersAPI,
  type BackgroundTaskContext,
} from '@stina/extension-api/runtime'
import { MailRepository, type DatabaseAPI } from './db/repository.js'
import { ProviderRegistry, getProviderLabel, type ProviderConfig } from './providers/index.js'
import { IdleManager } from './imap/idle.js'
import { ImapClient } from './imap/client.js'
import { formatEmailInstruction, type FormatEmailOptions } from './imap/parser.js'
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
import type { EditState, EditFormState, AccountDisplayData, MailProvider, MailAccount, MailCredentials } from './types.js'
import {
  initiateGmailAuth,
  pollGmailToken,
  initiateOutlookAuth,
  pollOutlookToken,
  DEFAULT_OUTLOOK_CLIENT_ID,
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
      imapSecurity: 'ssl',
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
    // Handle new mail notification
    context.log.info('New mail detected', { accountId })
    // In a full implementation, fetch the new emails and notify Stina
  })

  // Sync baseline UIDs for an account (no notifications, just mark current state)
  const syncAccountBaseline = async (
    accountId: string,
    userId: string
  ): Promise<void> => {
    try {
      const userRepo = repository.withUser(userId)
      const account = await userRepo.accounts.get(accountId)
      if (!account || !account.enabled) return

      const provider = providers.getRequired(account.provider)

      // Fetch recent emails just to get the highest UID
      const emails = await provider.fetchNewEmails(account, account.credentials, 0)

      if (emails.length > 0) {
        // Find the highest UID and mark it as processed (baseline)
        const highestUid = Math.max(...emails.map(e => e.uid))
        const latestEmail = emails.find(e => e.uid === highestUid)
        if (latestEmail) {
          await userRepo.processed.markProcessed(accountId, latestEmail.messageId, latestEmail.uid)
          context.log.info('Synced baseline for account', { accountId, highestUid })
        }
      }

      await userRepo.accounts.updateSyncStatus(accountId, null)
    } catch (error) {
      context.log.warn('Failed to sync baseline', {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

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

      // If no baseline exists, sync it first (no notifications)
      if (sinceUid === 0) {
        context.log.info('No baseline for account, syncing...', { accountId })
        await syncAccountBaseline(accountId, userId)
        return
      }

      // Fetch user profile for personalization
      let userProfile: UserProfile | undefined
      if (user) {
        try {
          userProfile = await user.getProfile(userId)
        } catch (profileError) {
          context.log.debug('Could not fetch user profile', {
            error: profileError instanceof Error ? profileError.message : String(profileError),
          })
        }
      }

      const emails = await provider.fetchNewEmails(account, account.credentials, sinceUid)

      for (const email of emails) {
        // Atomically try to mark as processed - only proceed if we're the first
        const wasMarked = await userRepo.processed.tryMarkProcessed(
          accountId,
          email.messageId,
          email.uid
        )
        if (!wasMarked) {
          // Another process already claimed this email
          continue
        }

        // Format instruction for Stina with user info
        const formatOptions: FormatEmailOptions = {
          email: {
            from: email.from,
            to: email.to,
            subject: email.subject,
            date: email.date,
            body: email.body,
          },
          accountName: account.name,
          instruction: settings.instruction,
          userName: userProfile?.nickname || userProfile?.firstName,
          language: userProfile?.language,
        }
        const instruction = formatEmailInstruction(formatOptions)

        // Send to Stina
        await chat.appendInstruction({ text: instruction, userId })

        context.log.info('Notified about new email', {
          accountId,
          subject: email.subject,
          from: email.from.address
        })
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

  // Poll all accounts for a user
  const pollAllAccounts = async (userId: string): Promise<void> => {
    try {
      const userRepo = repository.withUser(userId)
      const accounts = await userRepo.accounts.list()

      for (const account of accounts) {
        if (!account.enabled) continue
        await handleNewEmail(account.id, userId)
      }
    } catch (error) {
      context.log.warn('Failed to poll accounts', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Set up email polling scheduler
  const POLL_INTERVAL_MS = 5 * 60 * 1000 // Poll every 5 minutes (backup for IDLE)
  const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // Check token refresh every 30 minutes
  const scheduledUsers = new Set<string>()
  const workerDisposables = new Map<string, Disposable>()

  /**
   * Ensures credentials are fresh, refreshing OAuth2 tokens if needed.
   * Updates the database with new credentials if refreshed.
   * @param account The mail account
   * @param userRepo User repository for saving credentials
   * @returns Fresh credentials
   */
  const ensureFreshCredentials = async (
    account: MailAccount,
    userRepo: ReturnType<typeof repository.withUser>
  ): Promise<MailCredentials> => {
    const provider = providers.getRequired(account.provider)

    // Check if provider supports token refresh
    if (!provider.needsRefresh || !provider.refreshCredentials) {
      return account.credentials
    }

    // Check if refresh is needed
    if (!provider.needsRefresh(account.credentials)) {
      return account.credentials
    }

    // Refresh the credentials
    context.log.info('Refreshing OAuth2 token', { accountId: account.id })
    const newCredentials = await provider.refreshCredentials(account.credentials)

    // Save to database
    if (newCredentials.type === 'oauth2') {
      await userRepo.accounts.upsert(account.id, {
        provider: account.provider,
        name: account.name,
        email: account.email,
        accessToken: newCredentials.accessToken,
        refreshToken: newCredentials.refreshToken,
        expiresAt: newCredentials.expiresAt,
      })
      context.log.info('OAuth2 token refreshed and saved', { accountId: account.id })
    }

    return newCredentials
  }

  // Start a background worker for IMAP IDLE monitoring per user
  const startIdleWorkerForUser = async (userId: string): Promise<void> => {
    if (!backgroundWorkers) return

    const workerId = `mail-idle-${userId}`

    // Don't start if already running
    if (workerDisposables.has(workerId)) return

    try {
      const disposable = await backgroundWorkers.start(
        {
          id: workerId,
          name: 'Mail IDLE Monitor',
          userId,
          restartPolicy: { type: 'on-failure', maxRestarts: 0 },
        },
        async (ctx: BackgroundTaskContext) => {
          ctx.reportHealth('Starting IDLE connections...')

          const userRepo = repository.withUser(userId)
          const accounts = await userRepo.accounts.list()
          const enabledAccounts = accounts.filter((a) => a.enabled)

          if (enabledAccounts.length === 0) {
            ctx.reportHealth('No enabled accounts')
            return
          }

          const localIdleManager = new IdleManager(async (accountId) => {
            ctx.log.info('New mail detected via IDLE', { accountId })
            await handleNewEmail(accountId, userId)
          })

          // Track active connections for token refresh
          const activeConnections = new Map<string, { account: MailAccount; client: ImapClient }>()

          // Start IDLE for each account with fresh credentials
          for (const account of enabledAccounts) {
            try {
              // Ensure credentials are fresh before connecting
              const freshCredentials = await ensureFreshCredentials(account, userRepo)
              const accountWithFreshCreds = { ...account, credentials: freshCredentials }

              const provider = providers.getRequired(account.provider)
              const imapConfig = provider.getImapConfig(accountWithFreshCreds, freshCredentials)
              const client = new ImapClient(imapConfig)
              await client.connect()
              await localIdleManager.startIdle(account.id, client, ctx.signal)

              activeConnections.set(account.id, { account: accountWithFreshCreds, client })
              ctx.log.info('IDLE started for account', { accountId: account.id })
            } catch (error) {
              ctx.log.warn('Failed to start IDLE for account', {
                accountId: account.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }

          ctx.reportHealth(`IDLE monitoring ${activeConnections.size} account(s)`)

          // Periodic token refresh loop (runs in parallel with IDLE)
          const tokenRefreshLoop = async (): Promise<void> => {
            while (!ctx.signal.aborted) {
              // Wait for next refresh check interval
              await new Promise<void>((resolve) => {
                const timeout = setTimeout(resolve, TOKEN_REFRESH_INTERVAL_MS)
                ctx.signal.addEventListener('abort', () => {
                  clearTimeout(timeout)
                  resolve()
                }, { once: true })
              })

              if (ctx.signal.aborted) break

              // Check and refresh tokens for all active connections
              for (const [accountId, { account }] of activeConnections) {
                try {
                  const provider = providers.getRequired(account.provider)

                  // Skip if provider doesn't support token refresh
                  if (!provider.needsRefresh || !provider.refreshCredentials) continue

                  // Get fresh account data from database
                  const currentAccount = await userRepo.accounts.get(accountId)
                  if (!currentAccount || !currentAccount.enabled) continue

                  // Check if refresh is needed (refresh 10 minutes before expiry)
                  if (provider.needsRefresh(currentAccount.credentials)) {
                    ctx.log.info('Proactively refreshing OAuth2 token', { accountId })

                    const newCredentials = await ensureFreshCredentials(currentAccount, userRepo)

                    // Reconnect with fresh credentials
                    await localIdleManager.stopIdle(accountId)

                    const imapConfig = provider.getImapConfig(currentAccount, newCredentials)
                    const newClient = new ImapClient(imapConfig)
                    await newClient.connect()
                    await localIdleManager.startIdle(accountId, newClient, ctx.signal)

                    activeConnections.set(accountId, {
                      account: { ...currentAccount, credentials: newCredentials },
                      client: newClient,
                    })

                    ctx.log.info('IDLE reconnected with fresh token', { accountId })
                  }
                } catch (error) {
                  ctx.log.warn('Failed to refresh token for account', {
                    accountId,
                    error: error instanceof Error ? error.message : String(error),
                  })
                }
              }
            }
          }

          // Start token refresh loop in background
          void tokenRefreshLoop()

          // Wait until the signal is aborted
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) {
              resolve()
              return
            }
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          })

          // Graceful shutdown
          ctx.reportHealth('Shutting down IDLE connections...')
          await localIdleManager.stopAll()
        }
      )

      workerDisposables.set(workerId, disposable)
      context.log.info('Background IDLE worker started', { userId })
    } catch (error) {
      context.log.warn('Failed to start IDLE worker', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const schedulePollingForUser = async (userId: string): Promise<void> => {
    if (!scheduler || scheduledUsers.has(userId)) return

    try {
      await scheduler.schedule({
        id: `mail-poll-${userId}`,
        schedule: { type: 'interval', everyMs: POLL_INTERVAL_MS },
        userId,
      })
      scheduledUsers.add(userId)
      context.log.info('Scheduled email polling for user', { userId, intervalMs: POLL_INTERVAL_MS })
    } catch (error) {
      context.log.warn('Failed to schedule polling', {
        userId,
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
              imapSecurity: 'ssl',
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
              imapSecurity: account.imapSecurity || 'ssl',
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
                const outlookClientId = config.outlookClientId || DEFAULT_OUTLOOK_CLIENT_ID

                const result = await initiateOutlookAuth({
                  clientId: outlookClientId,
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
              imapSecurity: state.form.imapSecurity || null,
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
              await provider.testConnection(testAccount, testAccount.credentials)

              return {
                success: true,
                data: {
                  connected: true,
                  message: 'Connection successful!',
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
                imapSecurity: state.form.imapSecurity || undefined,
                username: state.form.username || undefined,
                password: state.form.password || undefined,
              })

              state.showModal = false
              emitEditChanged()
              emitAccountChanged()

              // Start IDLE worker and polling for this user
              void startIdleWorkerForUser(execContext.userId)
              void schedulePollingForUser(execContext.userId)

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
        } else if (provider === 'outlook') {
          const outlookClientId = config.outlookClientId || DEFAULT_OUTLOOK_CLIENT_ID
          token = await pollOutlookToken(
            { clientId: outlookClientId, tenantId: config.outlookTenantId },
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

  // Listen for scheduler events
  let schedulerDisposable: Disposable | undefined
  if (scheduler) {
    schedulerDisposable = scheduler.onFire(async (firePayload: { id: string; payload?: Record<string, unknown>; userId: string }, execContext) => {
      if (!firePayload.id.startsWith('mail-poll-')) return

      const userId = firePayload.userId || execContext.userId
      if (!userId) return

      context.log.debug('Polling triggered', { userId })
      await pollAllAccounts(userId)
    })

    context.log.info('Email polling scheduler configured', { intervalMs: POLL_INTERVAL_MS })
  }

  // Auto-start polling for all existing users with accounts
  const initializePollingForExistingUsers = async (): Promise<void> => {
    try {
      const userIds = await repository.getAllUserIds()

      if (userIds.length === 0) {
        context.log.info('No existing mail accounts found, polling will start when accounts are added')
        return
      }

      context.log.info('Starting email polling for existing users', { userCount: userIds.length })

      for (const userId of userIds) {
        await startIdleWorkerForUser(userId)
        await schedulePollingForUser(userId)
      }
    } catch (error) {
      context.log.warn('Failed to initialize polling for existing users', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Schedule polling initialization after a short delay to ensure DB is ready
  void initializePollingForExistingUsers()

  return {
    dispose: () => {
      void idleManager.stopAll()
      schedulerDisposable?.dispose()
      // Stop all background workers
      for (const [, workerDisposable] of workerDisposables) {
        workerDisposable.dispose()
      }
      workerDisposables.clear()
      // Cancel all scheduled jobs
      if (scheduler) {
        for (const userId of scheduledUsers) {
          void scheduler.cancel(`mail-poll-${userId}`)
        }
      }
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
