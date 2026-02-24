/**
 * IMAP Client wrapper using imapflow
 */

import { ImapFlow } from 'imapflow'
import type { ImapConfig, EmailMessage, EmailAddress } from '../types.js'
import { parseEmail } from './parser.js'

/** Default timeout for IMAP operations in milliseconds */
const DEFAULT_TIMEOUT_MS = 30000

/** Maximum retry attempts for transient network errors */
const MAX_RETRY_ATTEMPTS = 3

/** Base delay for exponential backoff in milliseconds */
const BASE_RETRY_DELAY_MS = 1000

/**
 * Checks if an error is a transient network error that should be retried.
 * @param error The error to check
 * @returns True if the error is transient and should be retried
 */
function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const message = error.message.toLowerCase()
  const code = (error as Error & { code?: string }).code?.toLowerCase() || ''

  // Common transient network errors
  const transientPatterns = [
    'etimedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'enetunreach',
    'ehostunreach',
    'timeout',
    'socket hang up',
    'connection reset',
    'network',
    'temporary',
  ]

  return transientPatterns.some((pattern) => message.includes(pattern) || code.includes(pattern))
}

/**
 * Delays execution for a specified time.
 * @param ms Milliseconds to wait
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calculates exponential backoff delay with jitter.
 * @param attempt Current attempt number (0-indexed)
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  const jitter = Math.random() * 1000 // Add up to 1 second of random jitter
  return Math.min(exponentialDelay + jitter, 30000) // Cap at 30 seconds
}

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
 * IMAP client wrapper for connecting to mail servers.
 * Includes timeout handling and retry logic for transient network errors.
 */
export class ImapClient {
  private client: ImapFlow | null = null
  private readonly config: ImapConfig
  private readonly timeoutMs: number

  /**
   * Creates a new IMAP client instance.
   * @param config IMAP configuration
   * @param timeoutMs Timeout for IMAP operations in milliseconds (default: 30000)
   */
  constructor(config: ImapConfig, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.config = config
    this.timeoutMs = timeoutMs
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
      ...(this.config.tls ? { tls: this.config.tls } : {}),
      auth: authConfig,
      logger: false,
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
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
   * Tests the connection to the IMAP server with retry logic.
   * Throws an error if connection fails after all retries.
   */
  async testConnection(): Promise<void> {
    await this.withRetry(async () => {
      await this.connect()

      // Try to select INBOX to verify access
      await this.client!.getMailboxLock('INBOX')
      await this.disconnect()
    }, 'testConnection')
  }

  /**
   * Executes an operation with retry logic for transient network errors.
   * Uses exponential backoff between retries.
   * @param operation The async operation to execute
   * @param operationName Name for logging purposes
   * @returns The result of the operation
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    _operationName: string
  ): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Clean up connection state before retry
        try {
          await this.disconnect()
        } catch {
          // Ignore disconnect errors during cleanup
        }

        // Check if error is transient and we should retry
        if (isTransientError(error) && attempt < MAX_RETRY_ATTEMPTS - 1) {
          const backoffDelay = calculateBackoffDelay(attempt)
          await delay(backoffDelay)
          continue
        }

        // Non-transient error or max retries reached
        throw new Error(formatImapError(lastError))
      }
    }

    // Should not reach here, but TypeScript requires it
    throw new Error(formatImapError(lastError))
  }

  /**
   * Fetches new emails from INBOX since a given UID.
   * Includes retry logic for transient network errors.
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
    return this.withRetry(async () => {
      if (!this.client) {
        throw new Error('Not connected to IMAP server')
      }

      const emails: EmailMessage[] = []

      const lock = await this.client.getMailboxLock('INBOX')

      try {
        // Build search criteria for new messages
        const searchCriteria = sinceUid > 0 ? { uid: `${sinceUid + 1}:*` } : { all: true }

        // Search for messages
        const uidsResult = await this.client.search(searchCriteria, { uid: true })

        // Handle case when search returns false (no messages)
        if (!uidsResult || !Array.isArray(uidsResult)) {
          return emails
        }

        // Limit results - take the most recent UIDs
        const uidsToFetch = uidsResult.slice(-limit)

        if (uidsToFetch.length === 0) {
          return emails
        }

        // Fetch message details using UID FETCH
        // Pass range as object with uid property to use UID FETCH command
        for await (const message of this.client.fetch(
          { uid: uidsToFetch.join(',') },
          { envelope: true, source: true }
        )) {
          try {
            if (!message.source) {
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
          } catch {
            // Skip emails that fail to parse
          }
        }
      } finally {
        lock.release()
      }

      return emails
    }, 'fetchNewEmails')
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
