/**
 * Generic IMAP Provider
 *
 * Supports any IMAP server with username/password authentication.
 */

import type { MailProviderInterface } from './types.js'
import type { MailAccount, MailCredentials, ImapConfig, EmailMessage } from '../types.js'
import { ImapClient } from '../imap/client.js'

/**
 * Default IMAP port for SSL/TLS
 */
const DEFAULT_IMAP_PORT = 993

/**
 * Generic IMAP mail provider implementation
 */
export class GenericImapProvider implements MailProviderInterface {
  readonly id = 'imap'
  readonly name = 'Generic IMAP'

  /**
   * Gets IMAP configuration from account settings.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @returns IMAP configuration
   */
  getImapConfig(account: MailAccount, credentials: MailCredentials): ImapConfig {
    if (credentials.type !== 'password') {
      throw new Error('Generic IMAP requires password authentication')
    }

    if (!account.imapHost) {
      throw new Error('IMAP host is required for generic IMAP provider')
    }

    const port = account.imapPort || DEFAULT_IMAP_PORT

    return {
      host: account.imapHost,
      port,
      secure: port === 993, // Use TLS for port 993, otherwise STARTTLS
      auth: {
        user: credentials.username || account.email,
        pass: credentials.password,
      },
    }
  }

  /**
   * Tests connection to the IMAP server.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @returns True if connection successful
   */
  async testConnection(account: MailAccount, credentials: MailCredentials): Promise<boolean> {
    const config = this.getImapConfig(account, credentials)
    const client = new ImapClient(config)
    return client.testConnection()
  }

  /**
   * Fetches new emails from the IMAP server.
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
    const config = this.getImapConfig(account, credentials)
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
}

/**
 * Creates a generic IMAP provider instance.
 * @returns Generic IMAP provider
 */
export function createGenericImapProvider(): MailProviderInterface {
  return new GenericImapProvider()
}
