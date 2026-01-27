/**
 * IMAP Client wrapper using imapflow
 */

import { ImapFlow } from 'imapflow'
import type { ImapConfig, EmailMessage, EmailAddress } from '../types.js'
import { parseEmail } from './parser.js'

/**
 * Extracts a detailed error message from ImapFlow errors.
 * @param error The error object
 * @returns A descriptive error message
 */
function formatImapError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  // ImapFlow errors have additional properties
  const imapError = error as Error & {
    response?: string
    responseText?: string
    serverResponseCode?: string
    authenticationFailed?: boolean
    code?: string
  }

  // Build a detailed message
  const parts: string[] = []

  if (imapError.authenticationFailed) {
    parts.push('Authentication failed')
  }

  if (imapError.responseText && imapError.responseText !== 'Command failed') {
    parts.push(imapError.responseText)
  } else if (imapError.serverResponseCode) {
    parts.push(imapError.serverResponseCode)
  }

  if (imapError.code && imapError.code !== imapError.serverResponseCode) {
    parts.push(`(${imapError.code})`)
  }

  // If we got useful parts, use them; otherwise fall back to original message
  if (parts.length > 0) {
    return parts.join(': ')
  }

  return imapError.message
}

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
   * Throws an error if connection fails with details about the failure.
   */
  async connect(): Promise<void> {
    const authConfig = this.buildAuthConfig()

    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: authConfig,
      logger: false,
    })

    await this.client.connect()
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
   * Throws an error if connection fails with details about the failure.
   */
  async testConnection(): Promise<void> {
    try {
      console.log('[IMAP] Testing connection to', this.config.host, 'port', this.config.port)
      await this.connect()

      // Try to select INBOX to verify access
      console.log('[IMAP] Connected, testing INBOX access...')
      await this.client!.getMailboxLock('INBOX')
      console.log('[IMAP] Connection test successful')
      await this.disconnect()
    } catch (error) {
      console.error('[IMAP] Connection test failed:', error)
      await this.disconnect()
      throw new Error(formatImapError(error))
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
      console.log('[IMAP] Fetching emails, sinceUid:', sinceUid, 'limit:', limit)
      const lock = await this.client.getMailboxLock('INBOX')
      console.log('[IMAP] INBOX status:', {
        exists: this.client.mailbox?.exists,
        uidNext: this.client.mailbox?.uidNext,
      })

      try {
        // Build search criteria for new messages
        const searchCriteria = sinceUid > 0 ? { uid: `${sinceUid + 1}:*` } : { all: true }
        console.log('[IMAP] Search criteria:', searchCriteria)

        // Search for messages
        const uidsResult = await this.client.search(searchCriteria, { uid: true })
        console.log('[IMAP] Search result:', uidsResult)

        // Handle case when search returns false (no messages)
        if (!uidsResult || !Array.isArray(uidsResult)) {
          console.log('[IMAP] No messages found (empty result)')
          return emails
        }

        // Limit results - take the most recent UIDs
        const uidsToFetch = uidsResult.slice(-limit)
        console.log('[IMAP] UIDs to fetch:', uidsToFetch.length, 'UIDs, range:', uidsToFetch[0], '-', uidsToFetch[uidsToFetch.length - 1])

        if (uidsToFetch.length === 0) {
          return emails
        }

        // Fetch message details using UID FETCH
        // Pass range as object with uid property to use UID FETCH command
        console.log('[IMAP] Starting fetch loop...')
        let fetchCount = 0
        let skipCount = 0
        for await (const message of this.client.fetch(
          { uid: uidsToFetch.join(',') },
          { envelope: true, source: true }
        )) {
          fetchCount++
          try {
            if (!message.source) {
              skipCount++
              console.log('[IMAP] Skipping message (no source):', message.uid)
              continue
            }
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
            console.error('[IMAP] Failed to parse email:', message.uid, parseError)
          }
        }
        console.log('[IMAP] Fetch complete. Fetched:', fetchCount, 'Skipped:', skipCount, 'Parsed:', emails.length)
      } finally {
        lock.release()
      }
    } catch (error) {
      console.error('[IMAP] Failed to fetch emails:', error)
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
