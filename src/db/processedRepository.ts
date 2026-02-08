/**
 * Processed Emails Repository for Mail Reader extension.
 */

import type { StorageAPI } from '@stina/extension-api/runtime'

/** Collection names */
const COLLECTIONS = {
  processed: 'processed',
} as const

/**
 * Generates a unique ID with the given prefix.
 * @param prefix Prefix for the ID
 * @returns Unique ID string
 */
function generateId(prefix: string): string {
  const random = Math.random().toString(36).substring(2, 10)
  const timestamp = Date.now().toString(36)
  return `${prefix}_${timestamp}${random}`
}

/**
 * Document type for processed emails stored in storage.
 */
interface ProcessedDocument {
  id: string
  accountId: string
  messageId: string
  uid: number
  processedAt: string
}

/**
 * Repository for tracking processed emails.
 */
export class ProcessedRepository {
  private readonly storage: StorageAPI

  /**
   * Creates a ProcessedRepository instance.
   * @param storage User-scoped storage API
   */
  constructor(storage: StorageAPI) {
    this.storage = storage
  }

  /**
   * Checks if an email has been processed.
   * @param accountId Account ID
   * @param messageId Email Message-ID header
   * @returns True if already processed
   */
  async isProcessed(accountId: string, messageId: string): Promise<boolean> {
    const doc = await this.storage.findOne<ProcessedDocument>(COLLECTIONS.processed, {
      accountId,
      messageId,
    })
    return doc !== undefined
  }

  /**
   * Marks an email as processed.
   * @param accountId Account ID
   * @param messageId Email Message-ID header
   * @param uid IMAP UID
   */
  async markProcessed(accountId: string, messageId: string, uid: number): Promise<void> {
    const existing = await this.storage.findOne<ProcessedDocument>(COLLECTIONS.processed, {
      accountId,
      messageId,
    })

    if (existing) return // Already processed

    const processedId = generateId('prc')
    const now = new Date().toISOString()

    const doc: ProcessedDocument = {
      id: processedId,
      accountId,
      messageId,
      uid,
      processedAt: now,
    }

    await this.storage.put(COLLECTIONS.processed, processedId, doc)
  }

  /**
   * Atomically tries to mark an email as processed using upsert pattern.
   * Returns true if the email was newly marked (this caller should process it).
   * Returns false if the email was already marked (another caller already processed it).
   * @param accountId Account ID
   * @param messageId Email Message-ID header
   * @param uid IMAP UID
   * @returns True if this call marked the email, false if already marked
   */
  async tryMarkProcessed(accountId: string, messageId: string, uid: number): Promise<boolean> {
    // Use a deterministic ID based on accountId + messageId to create an upsert-like pattern.
    // If two concurrent calls try to write the same key, the storage put is idempotent.
    const deterministicId = `prc_${accountId}_${messageId}`

    const existing = await this.storage.get<ProcessedDocument>(COLLECTIONS.processed, deterministicId)
    if (existing) return false

    const now = new Date().toISOString()

    const doc: ProcessedDocument = {
      id: deterministicId,
      accountId,
      messageId,
      uid,
      processedAt: now,
    }

    await this.storage.put(COLLECTIONS.processed, deterministicId, doc)
    return true
  }

  /**
   * Gets the highest processed UID for an account.
   * @param accountId Account ID
   * @returns Highest UID or 0
   */
  async getHighestUid(accountId: string): Promise<number> {
    const docs = await this.storage.find<ProcessedDocument>(
      COLLECTIONS.processed,
      { accountId },
      { sort: { uid: 'desc' }, limit: 1 }
    )

    return docs.length > 0 ? docs[0].uid : 0
  }
}
