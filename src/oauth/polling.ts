/**
 * OAuth token polling logic for device code flow.
 */

import type { StorageAPI, SecretsAPI } from '@stina/extension-api/runtime'
import { MailRepository, ExtensionRepository } from '../db/repository.js'
import type { ProviderConfig } from '../providers/index.js'
import { getEditState } from '../edit-state.js'
import {
  pollGmailToken,
  pollOutlookToken,
  DEFAULT_OUTLOOK_CLIENT_ID,
} from './index.js'

export interface OAuthPollingDeps {
  extensionRepo: ExtensionRepository
  emitEditChanged: () => void
  emitAccountChanged: () => void
  schedulePollingForUser: (userId: string) => Promise<void>
  log: {
    warn: (msg: string, data?: Record<string, unknown>) => void
  }
}

/**
 * Polls for OAuth token in background after device code flow initiation.
 */
export async function pollForOAuthToken(
  userId: string,
  userStorage: StorageAPI,
  userSecrets: SecretsAPI,
  provider: 'gmail' | 'outlook',
  deviceCode: string,
  interval: number,
  config: ProviderConfig,
  deps: OAuthPollingDeps
): Promise<void> {
  const maxAttempts = 60 // 5 minutes at 5 second intervals
  const state = getEditState(userId)
  const userRepo = new MailRepository(userStorage, userSecrets)

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
        await userRepo.accounts.upsert(state.editingId || undefined, {
          provider,
          name: state.form.name,
          email: state.form.email,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
        })

        // Register user for polling discovery
        await deps.extensionRepo.registerUser(userId)

        state.oauthStatus = 'connected'
        state.showModal = false
        deps.emitEditChanged()
        deps.emitAccountChanged()

        // Schedule polling for this user
        void deps.schedulePollingForUser(userId).catch((err) =>
          deps.log.warn('Failed to schedule polling after OAuth', {
            error: err instanceof Error ? err.message : String(err),
          })
        )
        return
      }
    } catch (error) {
      // Continue polling unless fatal error
      if (
        error instanceof Error &&
        !error.message.includes('authorization_pending') &&
        !error.message.includes('slow_down')
      ) {
        deps.log.warn('OAuth polling failed', { error: error.message })
        state.oauthStatus = 'pending'
        deps.emitEditChanged()
        return
      }
    }
  }

  // Timeout
  state.oauthStatus = 'pending'
  deps.emitEditChanged()
}
