/**
 * IMAP IDLE background worker management.
 */

import type { Disposable, BackgroundWorkersAPI, BackgroundTaskContext, StorageAPI, SecretsAPI } from '@stina/extension-api/runtime'
import { MailRepository } from './db/repository.js'
import type { ProviderRegistry } from './providers/index.js'
import { IdleManager } from './imap/idle.js'
import { ImapClient } from './imap/client.js'
import { ensureFreshCredentials } from './credentials.js'
import type { MailAccount } from './types.js'

const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // Check token refresh every 30 minutes

export interface IdleWorkerDeps {
  providers: ProviderRegistry
  backgroundWorkers?: BackgroundWorkersAPI
  handleNewEmail: (accountId: string, userStorage: StorageAPI, userSecrets: SecretsAPI, userId: string) => Promise<void>
  log: {
    info: (msg: string, data?: Record<string, unknown>) => void
    warn: (msg: string, data?: Record<string, unknown>) => void
  }
}

/**
 * Creates an IDLE worker manager.
 */
export function createIdleWorkerManager(deps: IdleWorkerDeps) {
  const workerDisposables = new Map<string, Disposable>()

  const startIdleWorkerForUser = async (userId: string): Promise<void> => {
    if (!deps.backgroundWorkers) return

    const workerId = `mail-idle-${userId}`

    // Don't start if already running
    if (workerDisposables.has(workerId)) return

    try {
      const disposable = await deps.backgroundWorkers.start(
        {
          id: workerId,
          name: 'Mail IDLE Monitor',
          userId,
          restartPolicy: { type: 'on-failure', maxRestarts: 0 },
        },
        async (ctx: BackgroundTaskContext) => {
          ctx.reportHealth('Starting IDLE connections...')

          const userRepo = new MailRepository(ctx.userStorage, ctx.userSecrets)
          const accounts = await userRepo.accounts.list()
          const enabledAccounts = accounts.filter((a) => a.enabled)

          if (enabledAccounts.length === 0) {
            ctx.reportHealth('No enabled accounts')
            return
          }

          const localIdleManager = new IdleManager(async (accountId) => {
            ctx.log.info('New mail detected via IDLE', { accountId })
            await deps.handleNewEmail(accountId, ctx.userStorage, ctx.userSecrets, userId)
          })

          // Track active connections for token refresh
          const activeConnections = new Map<string, { account: MailAccount; client: ImapClient }>()

          // Start IDLE for each account with fresh credentials
          for (const account of enabledAccounts) {
            try {
              // Ensure credentials are fresh before connecting
              const freshCredentials = await ensureFreshCredentials(account, userRepo, {
                providers: deps.providers,
                log: ctx.log,
              })
              const accountWithFreshCreds = { ...account, credentials: freshCredentials }

              const provider = deps.providers.getRequired(account.provider)
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
                  const provider = deps.providers.getRequired(account.provider)

                  // Skip if provider doesn't support token refresh
                  if (!provider.needsRefresh || !provider.refreshCredentials) continue

                  // Get fresh account data from storage
                  const currentAccount = await userRepo.accounts.get(accountId)
                  if (!currentAccount || !currentAccount.enabled) continue

                  // Check if refresh is needed (refresh 10 minutes before expiry)
                  if (provider.needsRefresh(currentAccount.credentials)) {
                    ctx.log.info('Proactively refreshing OAuth2 token', { accountId })

                    const newCredentials = await ensureFreshCredentials(currentAccount, userRepo, {
                      providers: deps.providers,
                      log: ctx.log,
                    })

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
          void tokenRefreshLoop().catch((err) =>
            ctx.log.warn('Token refresh loop error', {
              error: err instanceof Error ? err.message : String(err),
            })
          )

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
      deps.log.info('Background IDLE worker started', { userId })
    } catch (error) {
      deps.log.warn('Failed to start IDLE worker', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const stopAll = (): void => {
    for (const [, workerDisposable] of workerDisposables) {
      workerDisposable.dispose()
    }
    workerDisposables.clear()
  }

  return {
    startIdleWorkerForUser,
    stopAll,
  }
}
