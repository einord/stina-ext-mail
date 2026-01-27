/**
 * Mail Repository - Main repository facade
 */

import { AccountsRepository, SettingsRepository, ProcessedRepository } from './accountsRepository.js'
import { MailDb, type DatabaseAPI } from './mailDb.js'

export type { DatabaseAPI } from './mailDb.js'

/**
 * Main repository class for Mail Reader extension.
 * Provides access to all sub-repositories with user scoping.
 */
export class MailRepository {
  private readonly db: MailDb
  readonly accounts: AccountsRepository
  readonly settings: SettingsRepository
  readonly processed: ProcessedRepository

  /**
   * Creates a MailRepository instance.
   * @param database The database API or an existing MailDb instance
   */
  constructor(database: DatabaseAPI | MailDb) {
    this.db = database instanceof MailDb ? database : new MailDb(database)
    this.accounts = new AccountsRepository(this.db)
    this.settings = new SettingsRepository(this.db)
    this.processed = new ProcessedRepository(this.db)
  }

  /**
   * Creates a new MailRepository instance scoped to the specified user ID.
   * All operations on the returned repository will be filtered/scoped to this user.
   * @param userId The user ID to scope operations to
   * @returns A new MailRepository instance with the specified user ID
   */
  withUser(userId: string): MailRepository {
    return new MailRepository(this.db.withUser(userId))
  }

  /**
   * Initializes the database schema.
   */
  async initialize(): Promise<void> {
    await this.db.initialize()
  }

  /**
   * Gets all unique user IDs that have mail accounts.
   * This is used to schedule polling for all users at startup.
   * @returns Array of unique user IDs
   */
  async getAllUserIds(): Promise<string[]> {
    await this.db.initialize()

    const rows = await this.db.execute<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM ext_mail_reader_accounts WHERE enabled = 1`
    )

    return rows.map((row) => row.user_id)
  }
}
