/**
 * iCloud Mail Provider
 *
 * Uses iCloud IMAP with app-specific password authentication.
 * Host: imap.mail.me.com
 * Port: 993 (SSL/TLS)
 */

import type { MailProviderInterface } from './types.js'
import type { MailAccount, MailCredentials, ImapConfig, EmailMessage } from '../types.js'
import { ImapClient } from '../imap/client.js'

/**
 * iCloud IMAP configuration
 */
const ICLOUD_IMAP_HOST = 'imap.mail.me.com'
const ICLOUD_IMAP_PORT = 993

/**
 * iCloud mail provider implementation
 */
export class ICloudProvider implements MailProviderInterface {
  readonly id = 'icloud'
  readonly name = 'iCloud'

  /**
   * Gets IMAP configuration for iCloud.
   * @param account Mail account
   * @param credentials Decrypted credentials
   * @returns IMAP configuration
   */
  getImapConfig(account: MailAccount, credentials: MailCredentials): ImapConfig {
    if (credentials.type !== 'password') {
      throw new Error('iCloud requires password authentication')
    }

    return {
      host: ICLOUD_IMAP_HOST,
      port: ICLOUD_IMAP_PORT,
      secure: true,
      auth: {
        user: credentials.username || account.email,
        pass: credentials.password,
      },
    }
  }

  /**
   * Tests connection to iCloud IMAP.
   * Throws an error with details if connection fails.
   * @param account Mail account
   * @param credentials Decrypted credentials
   */
  async testConnection(account: MailAccount, credentials: MailCredentials): Promise<void> {
    const config = this.getImapConfig(account, credentials)
    const client = new ImapClient(config)
    await client.testConnection()
  }

  /**
   * Fetches new emails from iCloud.
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
 * Creates an iCloud provider instance.
 * @returns iCloud provider
 */
export function createICloudProvider(): MailProviderInterface {
  return new ICloudProvider()
}
