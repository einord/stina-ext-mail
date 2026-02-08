/**
 * Mail Reader UI action registrations.
 */

import type { ExecutionContext, StorageAPI, SecretsAPI } from '@stina/extension-api/runtime'
import { MailRepository, ExtensionRepository } from '../db/repository.js'
import { ProviderRegistry, getProviderLabel, type ProviderConfig } from '../providers/index.js'
import { getEditState, deleteEditState, type EditFormState } from '../edit-state.js'
import { pollForOAuthToken } from '../oauth/polling.js'
import type { AccountDisplayData, MailProvider } from '../types.js'
import {
  initiateGmailAuth,
  initiateOutlookAuth,
  DEFAULT_OUTLOOK_CLIENT_ID,
} from '../oauth/index.js'

type ActionsApi = {
  register: (action: {
    id: string
    execute: (
      params: Record<string, unknown>,
      execContext: ExecutionContext
    ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  }) => { dispose: () => void }
}

export interface ActionDeps {
  extensionRepo: ExtensionRepository
  providers: ProviderRegistry
  emitAccountChanged: () => void
  emitSettingsChanged: () => void
  emitEditChanged: () => void
  schedulePollingForUser: (userId: string) => Promise<void>
  log: {
    warn: (msg: string, data?: Record<string, unknown>) => void
  }
}

function createUserRepository(execContext: ExecutionContext): MailRepository {
  return new MailRepository(execContext.userStorage, execContext.userSecrets)
}

export function registerActions(actionsApi: ActionsApi, deps: ActionDeps): Array<{ dispose: () => void }> {
  return [
    // Get accounts for display
    actionsApi.register({
      id: 'getAccounts',
      async execute(_params, execContext) {
        if (!execContext.userId) {
          return { success: false, error: 'User context required' }
        }

        try {
          const userRepo = createUserRepository(execContext)
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

        deps.emitEditChanged()
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
        const userRepo = createUserRepository(execContext)
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

        deps.emitEditChanged()
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

        // Clean up edit state when modal closes
        deleteEditState(execContext.userId)

        deps.emitEditChanged()
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

        deps.emitEditChanged()
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
        const config = deps.providers.getConfig()

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
              execContext.userStorage,
              execContext.userSecrets,
              'gmail',
              result.deviceCode,
              result.interval,
              config,
              {
                extensionRepo: deps.extensionRepo,
                emitEditChanged: deps.emitEditChanged,
                emitAccountChanged: deps.emitAccountChanged,
                schedulePollingForUser: deps.schedulePollingForUser,
                log: deps.log,
              }
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
              execContext.userStorage,
              execContext.userSecrets,
              'outlook',
              result.deviceCode,
              result.interval,
              config,
              {
                extensionRepo: deps.extensionRepo,
                emitEditChanged: deps.emitEditChanged,
                emitAccountChanged: deps.emitAccountChanged,
                schedulePollingForUser: deps.schedulePollingForUser,
                log: deps.log,
              }
            )
          }

          deps.emitEditChanged()
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
          const provider = deps.providers.getRequired(testAccount.provider)
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
        const userRepo = createUserRepository(execContext)

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

          // Register user in extension-scoped storage for polling discovery
          await deps.extensionRepo.registerUser(execContext.userId)

          state.showModal = false

          // Clean up edit state after save
          deleteEditState(execContext.userId)

          deps.emitEditChanged()
          deps.emitAccountChanged()

          // Schedule polling for this user
          void deps.schedulePollingForUser(execContext.userId).catch((err) =>
            deps.log.warn('Failed to schedule polling after save', {
              error: err instanceof Error ? err.message : String(err),
            })
          )

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
        const userRepo = createUserRepository(execContext)

        try {
          await userRepo.accounts.delete(id)

          // Check if user has any remaining accounts
          const remainingAccounts = await userRepo.accounts.list()
          if (remainingAccounts.length === 0) {
            await deps.extensionRepo.unregisterUser(execContext.userId)
          }

          deps.emitAccountChanged()
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
          const userRepo = createUserRepository(execContext)
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
          const userRepo = createUserRepository(execContext)

          if (key === 'instruction') {
            await userRepo.settings.update({ instruction: value })
          }

          deps.emitSettingsChanged()
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
}
