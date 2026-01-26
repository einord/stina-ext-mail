/**
 * IMAP Client wrapper using imapflow
 */

import { ImapFlow } from 'imapflow'
import type { ImapConfig, EmailMessage, EmailAddress } from '../types.js'
import { parseEmail } from './parser.js'

/**
 * IMAP client wrapper for connecting to mail servers
 */
export class ImapClient {
  private client: ImapFlow | null = null
  private readonly config: ImapConfig

  constructor(config: ImapConfig) {
    this.config = config
  }

  /**
   * Connects to the IMAP server.
   * @returns True if connection successful
   */
  async connect(): Promise<boolean> {
    try {
      const authConfig = this.buildAuthConfig()

      this.client = new ImapFlow({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: authConfig,
        logger: false,
      })

      await this.client.connect()
      return true
    } catch (error) {
      console.error('IMAP connection failed:', error)
      return false
    }
  }

  /**
   * Builds the authentication configuration for imapflow.
   */
  private buildAuthConfig(): { user: string; pass?: string; accessToken?: string } {
    const auth = this.config.auth

    if ('accessToken' in auth) {
      // OAuth2 XOAUTH2
      return {
        user: auth.user,
        accessToken: auth.accessToken,
      }
    }

    // Password auth
    return {
      user: auth.user,
      pass: auth.pass,
    }
  }

  /**
   * Disconnects from the IMAP server.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.logout()
      this.client = null
    }
  }

  /**
   * Tests the connection to the IMAP server.
   * @returns True if connection is working
   */
  async testConnection(): Promise<boolean> {
    try {
      const connected = await this.connect()
      if (!connected) return false

      // Try to select INBOX to verify access
      await this.client!.getMailboxLock('INBOX')
      await this.disconnect()
      return true
    } catch (error) {
      console.error('IMAP test failed:', error)
      await this.disconnect()
      return false
    }
  }

  /**
   * Fetches new emails from INBOX since a given UID.
   * @param accountId Account ID for tracking
   * @param sinceUid Only fetch emails with UID greater than this
   * @param limit Maximum number of emails to fetch
   * @returns Array of parsed email messages
   */
  async fetchNewEmails(
    accountId: string,
    sinceUid: number = 0,
    limit: number = 50
  ): Promise<EmailMessage[]> {
    if (!this.client) {
      throw new Error('Not connected to IMAP server')
    }

    const emails: EmailMessage[] = []

    try {
      const lock = await this.client.getMailboxLock('INBOX')

      try {
        // Build search criteria for new messages
        const searchCriteria = sinceUid > 0 ? { uid: `${sinceUid + 1}:*` } : { all: true }

        // Search for messages
        const uids = await this.client.search(searchCriteria, { uid: true })

        // Limit results
        const uidsToFetch = uids.slice(-limit)

        if (uidsToFetch.length === 0) {
          return emails
        }

        // Fetch message details
        for await (const message of this.client.fetch(uidsToFetch, {
          uid: true,
          envelope: true,
          source: true,
        })) {
          try {
            const parsed = await parseEmail(message.source)

            const email: EmailMessage = {
              id: `${accountId}:${message.uid}`,
              accountId,
              messageId: message.envelope?.messageId || `uid-${message.uid}`,
              uid: message.uid,
              from: this.parseAddress(message.envelope?.from?.[0]),
              to: (message.envelope?.to || []).map((addr) => this.parseAddress(addr)),
              cc: (message.envelope?.cc || []).map((addr) => this.parseAddress(addr)),
              subject: message.envelope?.subject || '(No subject)',
              date: message.envelope?.date?.toISOString() || new Date().toISOString(),
              body: parsed.body,
              snippet: parsed.snippet,
            }

            emails.push(email)
          } catch (parseError) {
            console.error('Failed to parse email:', parseError)
          }
        }
      } finally {
        lock.release()
      }
    } catch (error) {
      console.error('Failed to fetch emails:', error)
      throw error
    }

    return emails
  }

  /**
   * Parses an IMAP address object into our EmailAddress format.
   */
  private parseAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
    return {
      name: addr?.name || undefined,
      address: addr?.address || 'unknown@unknown',
    }
  }

  /**
   * Gets the IMAP client instance for IDLE operations.
   * @returns The imapflow client instance
   */
  getClient(): ImapFlow | null {
    return this.client
  }
}
