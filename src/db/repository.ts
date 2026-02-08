/**
 * Mail Repository - Main repository facade
 *
 * Provides a unified interface for all mail-related data operations
 * using the Extension Storage API.
 */

import type { StorageAPI, SecretsAPI } from '@stina/extension-api/runtime'
import { AccountsRepository } from './accountsRepository.js'
import { SettingsRepository } from './settingsRepository.js'
import { ProcessedRepository } from './processedRepository.js'

/**
 * Main repository class for Mail Reader extension.
 * Provides access to all sub-repositories using the Storage and Secrets APIs.
 */
export class MailRepository {
  readonly accounts: AccountsRepository
  readonly settings: SettingsRepository
  readonly processed: ProcessedRepository

  /**
   * Creates a MailRepository instance.
   * @param storage User-scoped storage API from ExecutionContext
   * @param secrets User-scoped secrets API from ExecutionContext
   */
  constructor(storage: StorageAPI, secrets: SecretsAPI) {
    this.accounts = new AccountsRepository(storage, secrets)
    this.settings = new SettingsRepository(storage)
    this.processed = new ProcessedRepository(storage)
  }
}

/**
 * Extension-scoped repository for operations that need to work across users.
 * Used primarily for getting all user IDs that have enabled accounts.
 *
 * Note: This uses extension-scoped storage, not user-scoped storage.
 * It maintains a separate registry of users with accounts.
 */
export class ExtensionRepository {
  private readonly storage: StorageAPI

  /**
   * Creates an ExtensionRepository instance.
   * @param storage Extension-scoped storage API from ExtensionContext
   */
  constructor(storage: StorageAPI) {
    this.storage = storage
  }

  /**
   * Registers a user as having mail accounts.
   * Should be called when a user adds their first account.
   * @param userId The user ID to register
   */
  async registerUser(userId: string): Promise<void> {
    await this.storage.put('users', userId, { id: userId, registeredAt: new Date().toISOString() })
  }

  /**
   * Unregisters a user when they have no more accounts.
   * @param userId The user ID to unregister
   */
  async unregisterUser(userId: string): Promise<void> {
    await this.storage.delete('users', userId)
  }

  /**
   * Gets all registered user IDs.
   * @returns Array of user IDs
   */
  async getAllUserIds(): Promise<string[]> {
    const docs = await this.storage.find<{ id: string }>('users')
    return docs.map((doc) => doc.id)
  }
}
