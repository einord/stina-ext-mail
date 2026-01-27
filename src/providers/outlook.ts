/**
 * Outlook Provider
 *
 * Uses Outlook IMAP with OAuth2 authentication (XOAUTH2).
 * Host: outlook.office365.com
 * Port: 993 (SSL/TLS)
 */

import type { MailProviderInterface } from './types.js'
import type { MailAccount, MailCredentials, ImapConfig, EmailMessage } from '../types.js'
import { ImapClient } from '../imap/client.js'
import {
  refreshOutlookToken,
  isOutlookTokenExpired,
  type OutlookOAuthConfig,
} from '../oauth/outlook.js'

/**
 * Outlook IMAP configuration
 */
const OUTLOOK_IMAP_HOST = 'outlook.office365.com'
const OUTLOOK_IMAP_PORT = 993

/**
 * Outlook mail provider implementation
 */
export class OutlookProvider implements MailProviderInterface {
  readonly id = 'outlook'
  readonly name = 'Outlook'

  private oauthConfig: OutlookOAuthConfig | null = null

  /**
   * Sets the OAuth configuration for Outlook.
   * @param config OAuth configuration
   */
  setOAuthConfig(config: OutlookOAuthConfig): void {
    this.oauthConfig = config
  }

  /**
   * Gets IMAP configuration for Outlook.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @returns IMAP configuration
   */
  getImapConfig(account: MailAccount, credentials: MailCredentials): ImapConfig {
    if (credentials.type !== 'oauth2') {
      throw new Error('Outlook requires OAuth2 authentication')
    }

    return {
      host: OUTLOOK_IMAP_HOST,
      port: OUTLOOK_IMAP_PORT,
      secure: true,
      auth: {
        user: account.email,
        accessToken: credentials.accessToken,
      },
    }
  }

  /**
   * Tests connection to Outlook IMAP.
   * Throws an error with details if connection fails.
   * @param account Mail account
   * @param credentials Decrypted credentials
   */
  async testConnection(account: MailAccount, credentials: MailCredentials): Promise<void> {
    // Refresh token if needed before testing
    const refreshedCreds = await this.maybeRefreshCredentials(credentials)
    const config = this.getImapConfig(account, refreshedCreds)
    const client = new ImapClient(config)
    await client.testConnection()
  }

  /**
   * Fetches new emails from Outlook.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @param since Only fetch emails after this UID
   * @returns List of new emails
   */
  async fetchNewEmails(
    account: MailAccount,
    credentials: MailCredentials,
    since?: number
  ): Promise<EmailMessage[]> {
    // Refresh token if needed before fetching
    const refreshedCreds = await this.maybeRefreshCredentials(credentials)
    const config = this.getImapConfig(account, refreshedCreds)
    const client = new ImapClient(config)

    try {
      await client.connect()
      const emails = await client.fetchNewEmails(account.id, since)
      await client.disconnect()
      return emails
    } catch (error) {
      await client.disconnect()
      throw error
    }
  }

  /**
   * Checks if credentials need refresh.
   * @param credentials Credentials to check
   * @returns True if refresh is needed
   */
  needsRefresh(credentials: MailCredentials): boolean {
    if (credentials.type !== 'oauth2') {
      return false
    }
    return isOutlookTokenExpired(credentials.expiresAt)
  }

  /**
   * Refreshes OAuth2 credentials.
   * @param credentials Credentials to refresh
   * @returns New credentials with fresh access token
   */
  async refreshCredentials(credentials: MailCredentials): Promise<MailCredentials> {
    if (credentials.type !== 'oauth2') {
      throw new Error('Cannot refresh non-OAuth2 credentials')
    }

    if (!this.oauthConfig) {
      throw new Error('OAuth configuration not set')
    }

    const tokenResponse = await refreshOutlookToken(this.oauthConfig, credentials.refreshToken)

    return {
      type: 'oauth2',
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      expiresAt: new Date(Date.now() + tokenResponse.expiresIn * 1000).toISOString(),
    }
  }

  /**
   * Refreshes credentials if needed.
   * @param credentials Current credentials
   * @returns Possibly refreshed credentials
   */
  private async maybeRefreshCredentials(credentials: MailCredentials): Promise<MailCredentials> {
    if (this.needsRefresh(credentials)) {
      return this.refreshCredentials(credentials)
    }
    return credentials
  }
}

/**
 * Creates an Outlook provider instance.
 * @param oauthConfig Optional OAuth configuration
 * @returns Outlook provider
 */
export function createOutlookProvider(oauthConfig?: OutlookOAuthConfig): MailProviderInterface {
  const provider = new OutlookProvider()
  if (oauthConfig) {
    provider.setOAuthConfig(oauthConfig)
  }
  return provider
}
