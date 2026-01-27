/**
 * Mail Provider Types
 */

import type {
  MailAccount,
  MailCredentials,
  ImapConfig,
  EmailMessage,
} from '../types.js'

/**
 * Mail provider interface
 */
export interface MailProviderInterface {
  /**
   * Provider ID
   */
  readonly id: string

  /**
   * Display name for the provider
   */
  readonly name: string

  /**
   * Get IMAP configuration for this provider
   * @param account The mail account
   * @param credentials Decrypted credentials
   */
  getImapConfig(account: MailAccount, credentials: MailCredentials): ImapConfig

  /**
   * Test connection to the mail server.
   * Throws an error with details if connection fails.
   * @param account The mail account
   * @param credentials Decrypted credentials
   */
  testConnection(account: MailAccount, credentials: MailCredentials): Promise<void>

  /**
   * Fetch new emails from the account
   * @param account The mail account
   * @param credentials Decrypted credentials
   * @param since Only fetch emails after this UID
   * @returns List of new emails
   */
  fetchNewEmails(
    account: MailAccount,
    credentials: MailCredentials,
    since?: number
  ): Promise<EmailMessage[]>

  /**
   * Check if credentials need refresh (for OAuth2)
   * @param credentials The credentials to check
   * @returns True if refresh is needed
   */
  needsRefresh?(credentials: MailCredentials): boolean

  /**
   * Refresh OAuth2 credentials
   * @param credentials The credentials to refresh
   * @returns New credentials with fresh access token
   */
  refreshCredentials?(credentials: MailCredentials): Promise<MailCredentials>
}

/**
 * Provider factory function type
 */
export type ProviderFactory = () => MailProviderInterface

/**
 * Provider configuration for the extension
 */
export interface ProviderConfig {
  // Gmail OAuth2
  gmailClientId?: string
  gmailClientSecret?: string

  // Outlook OAuth2
  outlookClientId?: string
  outlookTenantId?: string
}
