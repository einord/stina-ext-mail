/**
 * Email polling and scheduling logic.
 */

import type { Disposable, StorageAPI, SecretsAPI } from '@stina/extension-api/runtime'
import type { ExecutionContext } from '@stina/extension-api/runtime'
import { MailRepository, ExtensionRepository } from './db/repository.js'
import { ProviderRegistry } from './providers/index.js'
import type { FormatEmailOptions } from './imap/parser.js'
import { formatEmailInstruction } from './imap/parser.js'


// Track which accounts have been initialized this session to avoid
// notifying about emails that arrived while the app was stopped.
const sessionInitializedAccounts = new Set<string>()

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

export interface PollingDeps {
  providers: ProviderRegistry
  extensionRepo: ExtensionRepository
  chat?: ChatAPI
  scheduler?: SchedulerAPI
  user?: UserAPI
  log: {
    info: (msg: string, data?: Record<string, unknown>) => void
    warn: (msg: string, data?: Record<string, unknown>) => void
    debug: (msg: string, data?: Record<string, unknown>) => void
  }
}

const POLL_INTERVAL_MS = 5 * 60 * 1000 // Poll every 5 minutes (backup for IDLE)

/**
 * Sync baseline UIDs for an account (no notifications, just mark current state).
 */
export async function syncAccountBaseline(
  accountId: string,
  userStorage: StorageAPI,
  userSecrets: SecretsAPI,
  deps: PollingDeps
): Promise<void> {
  try {
    const userRepo = new MailRepository(userStorage, userSecrets)
    const account = await userRepo.accounts.get(accountId)
    if (!account || !account.enabled) return

    const provider = deps.providers.getRequired(account.provider)

    // Fetch recent emails just to get the highest UID
    const emails = await provider.fetchNewEmails(account, account.credentials, 0)

    if (emails.length > 0) {
      // Find the highest UID and mark it as processed (baseline)
      const highestUid = Math.max(...emails.map(e => e.uid))
      const latestEmail = emails.find(e => e.uid === highestUid)
      if (latestEmail) {
        await userRepo.processed.markProcessed(accountId, latestEmail.messageId, latestEmail.uid)
        deps.log.info('Synced baseline for account', { accountId, highestUid })
      }
    }

    await userRepo.accounts.updateSyncStatus(accountId, null)
  } catch (error) {
    deps.log.warn('Failed to sync baseline', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Handle new email notification.
 */
export async function handleNewEmail(
  accountId: string,
  userStorage: StorageAPI,
  userSecrets: SecretsAPI,
  userId: string,
  deps: PollingDeps
): Promise<void> {
  if (!deps.chat) {
    deps.log.warn('Chat API not available, cannot send email notification', { accountId })
    return
  }

  try {
    const userRepo = new MailRepository(userStorage, userSecrets)
    const account = await userRepo.accounts.get(accountId)
    if (!account || !account.enabled) return

    const settings = await userRepo.settings.get()
    const provider = deps.providers.getRequired(account.provider)
    const sinceUid = await userRepo.processed.getHighestUid(accountId)

    // If no baseline exists, sync it first (no notifications)
    if (sinceUid === 0) {
      deps.log.info('No baseline for account, syncing...', { accountId })
      await syncAccountBaseline(accountId, userStorage, userSecrets, deps)
      sessionInitializedAccounts.add(accountId)
      return
    }

    // Re-sync baseline on first poll this session to avoid notifying
    // about emails that arrived while the app was stopped.
    if (!sessionInitializedAccounts.has(accountId)) {
      sessionInitializedAccounts.add(accountId)
      deps.log.info('Re-syncing baseline for session restart', { accountId })
      await syncAccountBaseline(accountId, userStorage, userSecrets, deps)
      return
    }

    // Fetch user profile for personalization
    let userProfile: UserProfile | undefined
    if (deps.user) {
      try {
        userProfile = await deps.user.getProfile(userId)
      } catch (profileError) {
        deps.log.debug('Could not fetch user profile', {
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
      await deps.chat.appendInstruction({ text: instruction, userId })

      deps.log.info('Notified about new email', {
        accountId,
        subject: email.subject,
        from: email.from.address
      })
    }

    // Update sync status
    await userRepo.accounts.updateSyncStatus(accountId, null)
  } catch (error) {
    deps.log.warn('Failed to handle new email', {
      accountId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Poll all accounts for a user using their execution context.
 */
export async function pollAllAccountsWithContext(
  execContext: ExecutionContext,
  deps: PollingDeps
): Promise<void> {
  if (!execContext.userId) return

  try {
    const userRepo = new MailRepository(execContext.userStorage, execContext.userSecrets)
    const accounts = await userRepo.accounts.list()

    for (const account of accounts) {
      if (!account.enabled) continue
      await handleNewEmail(account.id, execContext.userStorage, execContext.userSecrets, execContext.userId, deps)
    }
  } catch (error) {
    deps.log.warn('Failed to poll accounts', {
      userId: execContext.userId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Creates a polling scheduler manager.
 */
export function createPollingScheduler(deps: PollingDeps) {
  const scheduledUsers = new Set<string>()

  const schedulePollingForUser = async (userId: string): Promise<void> => {
    if (!deps.scheduler || scheduledUsers.has(userId)) return

    try {
      await deps.scheduler.schedule({
        id: `mail-poll-${userId}`,
        schedule: { type: 'interval', everyMs: POLL_INTERVAL_MS },
        userId,
      })
      scheduledUsers.add(userId)
      deps.log.info('Scheduled email polling for user', { userId, intervalMs: POLL_INTERVAL_MS })
    } catch (error) {
      deps.log.warn('Failed to schedule polling', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const setupSchedulerListener = (): Disposable | undefined => {
    if (!deps.scheduler) return undefined

    const disposable = deps.scheduler.onFire(async (firePayload, execContext) => {
      if (!firePayload.id.startsWith('mail-poll-')) return

      const userId = firePayload.userId || execContext.userId
      if (!userId) return

      deps.log.debug('Polling triggered', { userId })
      await pollAllAccountsWithContext(execContext, deps)
    })

    deps.log.info('Email polling scheduler configured', { intervalMs: POLL_INTERVAL_MS })
    return disposable
  }

  const initializePollingForExistingUsers = async (
    startIdleWorkerForUser: (userId: string) => Promise<void>
  ): Promise<void> => {
    try {
      const userIds = await deps.extensionRepo.getAllUserIds()

      if (userIds.length === 0) {
        deps.log.info('No existing mail accounts found, polling will start when accounts are added')
        return
      }

      deps.log.info('Starting email polling for existing users', { userCount: userIds.length })

      for (const userId of userIds) {
        void startIdleWorkerForUser(userId).catch((err) =>
          deps.log.warn('Failed to start IDLE worker', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
        )
        await schedulePollingForUser(userId)
      }
    } catch (error) {
      deps.log.warn('Failed to initialize polling for existing users', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const cancelAll = (): void => {
    if (deps.scheduler) {
      for (const userId of scheduledUsers) {
        void deps.scheduler.cancel(`mail-poll-${userId}`)
      }
    }
    scheduledUsers.clear()
  }

  return {
    schedulePollingForUser,
    setupSchedulerListener,
    initializePollingForExistingUsers,
    cancelAll,
  }
}
