/**
 * Gmail Provider
 *
 * Uses Gmail IMAP with OAuth2 authentication (XOAUTH2).
 * Host: imap.gmail.com
 * Port: 993 (SSL/TLS)
 */

import type { MailProviderInterface } from './types.js'
import type { MailAccount, MailCredentials, ImapConfig, EmailMessage } from '../types.js'
import { ImapClient } from '../imap/client.js'
import { refreshGmailToken, isGmailTokenExpired, type GmailOAuthConfig } from '../oauth/gmail.js'

/**
 * Gmail IMAP configuration
 */
const GMAIL_IMAP_HOST = 'imap.gmail.com'
const GMAIL_IMAP_PORT = 993

/**
 * Gmail mail provider implementation
 */
export class GmailProvider implements MailProviderInterface {
  readonly id = 'gmail'
  readonly name = 'Gmail'

  private oauthConfig: GmailOAuthConfig | null = null

  /**
   * Sets the OAuth configuration for Gmail.
   * @param config OAuth configuration
   */
  setOAuthConfig(config: GmailOAuthConfig): void {
    this.oauthConfig = config
  }

  /**
   * Gets IMAP configuration for Gmail.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @returns IMAP configuration
   */
  getImapConfig(account: MailAccount, credentials: MailCredentials): ImapConfig {
    if (credentials.type !== 'oauth2') {
      throw new Error('Gmail requires OAuth2 authentication')
    }

    return {
      host: GMAIL_IMAP_HOST,
      port: GMAIL_IMAP_PORT,
      secure: true,
      auth: {
        user: account.email,
        accessToken: credentials.accessToken,
      },
    }
  }

  /**
   * Tests connection to Gmail IMAP.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @returns True if connection successful
   */
  async testConnection(account: MailAccount, credentials: MailCredentials): Promise<boolean> {
    // Refresh token if needed before testing
    const refreshedCreds = await this.maybeRefreshCredentials(credentials)
    const config = this.getImapConfig(account, refreshedCreds)
    const client = new ImapClient(config)
    return client.testConnection()
  }

  /**
   * Fetches new emails from Gmail.
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
    return isGmailTokenExpired(credentials.expiresAt)
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

    const tokenResponse = await refreshGmailToken(this.oauthConfig, credentials.refreshToken)

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
 * Creates a Gmail provider instance.
 * @param oauthConfig Optional OAuth configuration
 * @returns Gmail provider
 */
export function createGmailProvider(oauthConfig?: GmailOAuthConfig): MailProviderInterface {
  const provider = new GmailProvider()
  if (oauthConfig) {
    provider.setOAuthConfig(oauthConfig)
  }
  return provider
}
