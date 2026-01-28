/**
 * Database wrapper for Mail Reader extension
 */

export interface DatabaseAPI {
  execute<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
}

export class MailDb {
  private readonly db: DatabaseAPI
  private readonly _userId: string | undefined
  private static initializedDatabases = new WeakSet<DatabaseAPI>()

  /**
   * Creates a MailDb instance.
   * @param db The database API
   * @param userId Optional user ID for scoped operations
   */
  constructor(db: DatabaseAPI, userId?: string) {
    this.db = db
    this._userId = userId
  }

  /**
   * Creates a new MailDb instance scoped to the specified user ID.
   * This is the preferred way to get a user-scoped database instance.
   * @param userId The user ID to scope operations to
   * @returns A new MailDb instance with the specified user ID
   */
  withUser(userId: string): MailDb {
    return new MailDb(this.db, userId)
  }

  /**
   * Returns the current user ID for filtering/inserting data.
   * @throws Error if no user ID has been set
   */
  getUserId(): string {
    if (!this._userId) {
      throw new Error('No user ID set. Use withUser(userId) to create a user-scoped instance.')
    }
    return this._userId
  }

  /**
   * Initializes the database schema.
   */
  async initialize(): Promise<void> {
    // Use static WeakSet to track initialized databases across all MailDb instances
    if (MailDb.initializedDatabases.has(this.db)) return

    // Mail accounts table
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ext_mail_reader_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        imap_host TEXT,
        imap_port INTEGER,
        imap_security TEXT,
        auth_type TEXT NOT NULL,
        credentials TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )

    // Migration: Add imap_security column if it doesn't exist (for existing databases)
    await this.migrateAddImapSecurity()

    // Mail settings table
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ext_mail_reader_settings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )

    // Processed emails table
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ext_mail_reader_processed (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        uid INTEGER NOT NULL,
        processed_at TEXT NOT NULL
      )`
    )

    // OAuth state table
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ext_mail_reader_oauth_state (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        device_code TEXT NOT NULL,
        user_code TEXT NOT NULL,
        verification_url TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`
    )

    // Indexes for efficient queries
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS ext_mail_reader_accounts_user_idx
       ON ext_mail_reader_accounts(user_id)`
    )

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS ext_mail_reader_processed_account_idx
       ON ext_mail_reader_processed(account_id)`
    )

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS ext_mail_reader_processed_message_idx
       ON ext_mail_reader_processed(message_id)`
    )

    // Clean up any existing duplicates before creating unique constraint
    // Keep only the first processed entry for each (account_id, user_id, message_id)
    await this.db.execute(
      `DELETE FROM ext_mail_reader_processed
       WHERE id NOT IN (
         SELECT MIN(id) FROM ext_mail_reader_processed
         GROUP BY account_id, user_id, message_id
       )`
    )

    // Unique constraint for atomic duplicate prevention
    await this.db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS ext_mail_reader_processed_unique_idx
       ON ext_mail_reader_processed(account_id, user_id, message_id)`
    )

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS ext_mail_reader_settings_user_idx
       ON ext_mail_reader_settings(user_id)`
    )

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS ext_mail_reader_oauth_state_user_idx
       ON ext_mail_reader_oauth_state(user_id)`
    )

    MailDb.initializedDatabases.add(this.db)
  }

  /**
   * Adds imap_security column to existing databases.
   * This migration is idempotent and safe to run multiple times.
   */
  private async migrateAddImapSecurity(): Promise<void> {
    // Check if column exists by querying table info
    const columns = await this.db.execute<{ name: string }>(
      `PRAGMA table_info(ext_mail_reader_accounts)`
    )
    const hasColumn = columns.some((col) => col.name === 'imap_security')

    if (!hasColumn) {
      await this.db.execute(
        `ALTER TABLE ext_mail_reader_accounts ADD COLUMN imap_security TEXT`
      )
    }
  }

  /**
   * Execute a SQL query.
   * @param sql SQL query string
   * @param params Query parameters
   * @returns Query results
   */
  async execute<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.db.execute<T>(sql, params)
  }

  /**
   * Gets the underlying database API for queries that don't need user scoping.
   * Use with caution - most operations should use user-scoped instances.
   * @returns The raw database API
   */
  getDatabase(): DatabaseAPI {
    return this.db
  }
}
