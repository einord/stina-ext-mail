/**
 * Accounts Repository for Mail Reader extension
 */

import type {
  MailAccount,
  MailAccountInput,
  MailCredentials,
  MailSettings,
  MailSettingsUpdate,
  ListAccountsOptions,
  AuthType,
  MailProvider,
} from '../types.js'
import type { MailDb } from './mailDb.js'

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
 * Simple encryption for credentials (placeholder - in production use proper encryption)
 * @param data Data to encrypt
 * @returns Encrypted string
 */
function encryptCredentials(data: MailCredentials): string {
  // In production, use proper encryption with a secret key
  return Buffer.from(JSON.stringify(data)).toString('base64')
}

/**
 * Simple decryption for credentials (placeholder - in production use proper encryption)
 * @param encrypted Encrypted string
 * @returns Decrypted credentials
 */
function decryptCredentials(encrypted: string): MailCredentials {
  // In production, use proper decryption with a secret key
  return JSON.parse(Buffer.from(encrypted, 'base64').toString('utf-8')) as MailCredentials
}

export class AccountsRepository {
  private readonly db: MailDb

  constructor(db: MailDb) {
    this.db = db
  }

  /**
   * Lists all mail accounts for the current user.
   * @param options List options
   * @returns Array of mail accounts
   */
  async list(options: ListAccountsOptions = {}): Promise<MailAccount[]> {
    await this.db.initialize()

    const { limit = 50, offset = 0 } = options
    const userId = this.db.getUserId()

    const rows = await this.db.execute<{
      id: string
      user_id: string
      provider: string
      name: string
      email: string
      imap_host: string | null
      imap_port: number | null
      auth_type: string
      credentials: string
      enabled: number
      last_sync_at: string | null
      last_error: string | null
      created_at: string
      updated_at: string
    }>(
      `SELECT id, user_id, provider, name, email, imap_host, imap_port,
              auth_type, credentials, enabled, last_sync_at, last_error,
              created_at, updated_at
       FROM ext_mail_reader_accounts
       WHERE user_id = ?
       ORDER BY name ASC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    )

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      provider: row.provider as MailProvider,
      name: row.name,
      email: row.email,
      imapHost: row.imap_host,
      imapPort: row.imap_port,
      authType: row.auth_type as AuthType,
      credentials: decryptCredentials(row.credentials),
      enabled: Boolean(row.enabled),
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  /**
   * Gets a mail account by ID.
   * @param id Account ID
   * @returns Mail account or null
   */
  async get(id: string): Promise<MailAccount | null> {
    await this.db.initialize()

    const userId = this.db.getUserId()
    const rows = await this.db.execute<{
      id: string
      user_id: string
      provider: string
      name: string
      email: string
      imap_host: string | null
      imap_port: number | null
      auth_type: string
      credentials: string
      enabled: number
      last_sync_at: string | null
      last_error: string | null
      created_at: string
      updated_at: string
    }>(
      `SELECT id, user_id, provider, name, email, imap_host, imap_port,
              auth_type, credentials, enabled, last_sync_at, last_error,
              created_at, updated_at
       FROM ext_mail_reader_accounts
       WHERE id = ? AND user_id = ?`,
      [id, userId]
    )

    const row = rows[0]
    if (!row) return null

    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider as MailProvider,
      name: row.name,
      email: row.email,
      imapHost: row.imap_host,
      imapPort: row.imap_port,
      authType: row.auth_type as AuthType,
      credentials: decryptCredentials(row.credentials),
      enabled: Boolean(row.enabled),
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Creates or updates a mail account.
   * @param id Account ID (if updating)
   * @param input Account input data
   * @returns Created/updated account
   */
  async upsert(id: string | undefined, input: MailAccountInput): Promise<MailAccount> {
    await this.db.initialize()

    const now = new Date().toISOString()
    const userId = this.db.getUserId()
    const accountId = id ?? generateId('acc')
    const existing = id ? await this.get(id) : null

    // Build credentials object
    let credentials: MailCredentials
    let authType: AuthType

    if (input.accessToken && input.refreshToken) {
      authType = 'oauth2'
      credentials = {
        type: 'oauth2',
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt ?? new Date(Date.now() + 3600 * 1000).toISOString(),
      }
    } else {
      authType = 'password'
      credentials = {
        type: 'password',
        username: input.username ?? input.email,
        password: input.password ?? '',
      }
    }

    if (existing) {
      // Update existing account
      const name = input.name ?? existing.name
      const email = input.email ?? existing.email
      const provider = input.provider ?? existing.provider
      const imapHost = input.imapHost !== undefined ? input.imapHost : existing.imapHost
      const imapPort = input.imapPort !== undefined ? input.imapPort : existing.imapPort
      const enabled = input.enabled !== undefined ? input.enabled : existing.enabled

      // Only update credentials if new ones are provided
      const finalCredentials =
        input.password || input.accessToken ? credentials : existing.credentials
      const finalAuthType = input.password || input.accessToken ? authType : existing.authType

      await this.db.execute(
        `UPDATE ext_mail_reader_accounts
         SET name = ?, email = ?, provider = ?, imap_host = ?, imap_port = ?,
             auth_type = ?, credentials = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
        [
          name,
          email,
          provider,
          imapHost,
          imapPort,
          finalAuthType,
          encryptCredentials(finalCredentials),
          enabled ? 1 : 0,
          now,
          accountId,
          userId,
        ]
      )

      return {
        id: accountId,
        userId,
        provider,
        name,
        email,
        imapHost,
        imapPort,
        authType: finalAuthType,
        credentials: finalCredentials,
        enabled,
        lastSyncAt: existing.lastSyncAt,
        lastError: existing.lastError,
        createdAt: existing.createdAt,
        updatedAt: now,
      }
    }

    // Create new account
    if (!input.name || !input.email || !input.provider) {
      throw new Error('Name, email, and provider are required for new accounts')
    }

    await this.db.execute(
      `INSERT INTO ext_mail_reader_accounts
       (id, user_id, provider, name, email, imap_host, imap_port,
        auth_type, credentials, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        accountId,
        userId,
        input.provider,
        input.name,
        input.email,
        input.imapHost ?? null,
        input.imapPort ?? null,
        authType,
        encryptCredentials(credentials),
        input.enabled !== false ? 1 : 0,
        now,
        now,
      ]
    )

    return {
      id: accountId,
      userId,
      provider: input.provider,
      name: input.name,
      email: input.email,
      imapHost: input.imapHost ?? null,
      imapPort: input.imapPort ?? null,
      authType,
      credentials,
      enabled: input.enabled !== false,
      lastSyncAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Deletes a mail account.
   * @param id Account ID
   * @returns True if deleted
   */
  async delete(id: string): Promise<boolean> {
    await this.db.initialize()

    const userId = this.db.getUserId()
    const rows = await this.db.execute<{ id: string }>(
      `SELECT id FROM ext_mail_reader_accounts WHERE id = ? AND user_id = ?`,
      [id, userId]
    )

    if (rows.length === 0) return false

    // Delete processed emails for this account
    await this.db.execute(
      `DELETE FROM ext_mail_reader_processed WHERE account_id = ? AND user_id = ?`,
      [id, userId]
    )

    // Delete the account
    await this.db.execute(
      `DELETE FROM ext_mail_reader_accounts WHERE id = ? AND user_id = ?`,
      [id, userId]
    )

    return true
  }

  /**
   * Updates the sync status for an account.
   * @param id Account ID
   * @param error Error message if sync failed, null if successful
   */
  async updateSyncStatus(id: string, error: string | null): Promise<void> {
    await this.db.initialize()

    const now = new Date().toISOString()
    const userId = this.db.getUserId()

    await this.db.execute(
      `UPDATE ext_mail_reader_accounts
       SET last_sync_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [now, error, now, id, userId]
    )
  }

  /**
   * Updates OAuth2 credentials for an account.
   * @param id Account ID
   * @param credentials New OAuth2 credentials
   */
  async updateCredentials(id: string, credentials: MailCredentials): Promise<void> {
    await this.db.initialize()

    const now = new Date().toISOString()
    const userId = this.db.getUserId()

    await this.db.execute(
      `UPDATE ext_mail_reader_accounts
       SET credentials = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [encryptCredentials(credentials), now, id, userId]
    )
  }
}

export class SettingsRepository {
  private readonly db: MailDb

  constructor(db: MailDb) {
    this.db = db
  }

  /**
   * Gets the mail settings for the current user.
   * @returns Mail settings
   */
  async get(): Promise<MailSettings> {
    await this.db.initialize()

    const userId = this.db.getUserId()
    const rows = await this.db.execute<{
      id: string
      user_id: string
      instruction: string
      created_at: string
      updated_at: string
    }>(
      `SELECT id, user_id, instruction, created_at, updated_at
       FROM ext_mail_reader_settings
       WHERE user_id = ?`,
      [userId]
    )

    if (rows.length === 0) {
      // Create default settings
      const now = new Date().toISOString()
      const settingsId = generateId('set')

      await this.db.execute(
        `INSERT INTO ext_mail_reader_settings (id, user_id, instruction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [settingsId, userId, '', now, now]
      )

      return {
        id: settingsId,
        userId,
        instruction: '',
        createdAt: now,
        updatedAt: now,
      }
    }

    const row = rows[0]
    return {
      id: row.id,
      userId: row.user_id,
      instruction: row.instruction,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Updates the mail settings for the current user.
   * @param update Settings update
   * @returns Updated settings
   */
  async update(update: MailSettingsUpdate): Promise<MailSettings> {
    await this.db.initialize()

    const settings = await this.get()
    const now = new Date().toISOString()
    const userId = this.db.getUserId()

    const instruction = update.instruction ?? settings.instruction

    await this.db.execute(
      `UPDATE ext_mail_reader_settings
       SET instruction = ?, updated_at = ?
       WHERE user_id = ?`,
      [instruction, now, userId]
    )

    return {
      ...settings,
      instruction,
      updatedAt: now,
    }
  }
}

export class ProcessedRepository {
  private readonly db: MailDb

  constructor(db: MailDb) {
    this.db = db
  }

  /**
   * Checks if an email has been processed.
   * @param accountId Account ID
   * @param messageId Email Message-ID header
   * @returns True if already processed
   */
  async isProcessed(accountId: string, messageId: string): Promise<boolean> {
    await this.db.initialize()

    const userId = this.db.getUserId()
    const rows = await this.db.execute<{ id: string }>(
      `SELECT id FROM ext_mail_reader_processed
       WHERE account_id = ? AND message_id = ? AND user_id = ?`,
      [accountId, messageId, userId]
    )

    return rows.length > 0
  }

  /**
   * Marks an email as processed.
   * @param accountId Account ID
   * @param messageId Email Message-ID header
   * @param uid IMAP UID
   */
  async markProcessed(accountId: string, messageId: string, uid: number): Promise<void> {
    await this.db.initialize()

    const userId = this.db.getUserId()
    const processedId = generateId('prc')
    const now = new Date().toISOString()

    await this.db.execute(
      `INSERT OR IGNORE INTO ext_mail_reader_processed
       (id, account_id, user_id, message_id, uid, processed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [processedId, accountId, userId, messageId, uid, now]
    )
  }

  /**
   * Gets the highest processed UID for an account.
   * @param accountId Account ID
   * @returns Highest UID or 0
   */
  async getHighestUid(accountId: string): Promise<number> {
    await this.db.initialize()

    const userId = this.db.getUserId()
    const rows = await this.db.execute<{ max_uid: number | null }>(
      `SELECT MAX(uid) as max_uid FROM ext_mail_reader_processed
       WHERE account_id = ? AND user_id = ?`,
      [accountId, userId]
    )

    return rows[0]?.max_uid ?? 0
  }
}
