/**
 * Credential refresh logic for OAuth2 accounts.
 */

import type { MailAccount, MailCredentials } from './types.js'
import type { MailRepository } from './db/repository.js'
import type { ProviderRegistry } from './providers/index.js'

export interface CredentialRefreshDeps {
  providers: ProviderRegistry
  log: {
    info: (msg: string, data?: Record<string, unknown>) => void
  }
}

/**
 * Ensures credentials are fresh, refreshing OAuth2 tokens if needed.
 * Updates the storage with new credentials if refreshed.
 * @param account The mail account
 * @param userRepo User repository for saving credentials
 * @param deps Dependencies for providers and logging
 * @returns Fresh credentials
 */
export async function ensureFreshCredentials(
  account: MailAccount,
  userRepo: MailRepository,
  deps: CredentialRefreshDeps
): Promise<MailCredentials> {
  const provider = deps.providers.getRequired(account.provider)

  // Check if provider supports token refresh
  if (!provider.needsRefresh || !provider.refreshCredentials) {
    return account.credentials
  }

  // Check if refresh is needed
  if (!provider.needsRefresh(account.credentials)) {
    return account.credentials
  }

  // Refresh the credentials
  deps.log.info('Refreshing OAuth2 token', { accountId: account.id })
  const newCredentials = await provider.refreshCredentials(account.credentials)

  // Save to storage
  if (newCredentials.type === 'oauth2') {
    await userRepo.accounts.upsert(account.id, {
      provider: account.provider,
      name: account.name,
      email: account.email,
      accessToken: newCredentials.accessToken,
      refreshToken: newCredentials.refreshToken,
      expiresAt: newCredentials.expiresAt,
    })
    deps.log.info('OAuth2 token refreshed and saved', { accountId: account.id })
  }

  return newCredentials
}
