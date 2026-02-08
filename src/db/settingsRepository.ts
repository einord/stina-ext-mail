/**
 * Settings Repository for Mail Reader extension.
 */

import type { StorageAPI } from '@stina/extension-api/runtime'
import type { MailSettings, MailSettingsUpdate } from '../types.js'

/** Collection names */
const COLLECTIONS = {
  settings: 'settings',
} as const

/**
 * Document type for settings stored in storage.
 */
interface SettingsDocument {
  id: string
  instruction: string
  createdAt: string
  updatedAt: string
}

/**
 * Repository for managing mail settings.
 */
export class SettingsRepository {
  private readonly storage: StorageAPI

  /**
   * Creates a SettingsRepository instance.
   * @param storage User-scoped storage API
   */
  constructor(storage: StorageAPI) {
    this.storage = storage
  }

  /**
   * Gets the mail settings for the current user.
   * Creates default settings if none exist.
   * @returns Mail settings
   */
  async get(): Promise<MailSettings> {
    // Use a fixed ID since there's only one settings document per user
    const settingsId = 'user-settings'
    const doc = await this.storage.get<SettingsDocument>(COLLECTIONS.settings, settingsId)

    if (doc) {
      return {
        id: doc.id,
        userId: '', // User ID is implicit
        instruction: doc.instruction,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      }
    }

    // Create default settings
    const now = new Date().toISOString()
    const newDoc: SettingsDocument = {
      id: settingsId,
      instruction: '',
      createdAt: now,
      updatedAt: now,
    }

    await this.storage.put(COLLECTIONS.settings, settingsId, newDoc)

    return {
      id: settingsId,
      userId: '',
      instruction: '',
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Updates the mail settings for the current user.
   * @param update Settings update
   * @returns Updated settings
   */
  async update(update: MailSettingsUpdate): Promise<MailSettings> {
    const settings = await this.get()
    const now = new Date().toISOString()

    const instruction = update.instruction ?? settings.instruction

    const doc: SettingsDocument = {
      id: settings.id,
      instruction,
      createdAt: settings.createdAt,
      updatedAt: now,
    }

    await this.storage.put(COLLECTIONS.settings, settings.id, doc)

    return {
      ...settings,
      instruction,
      updatedAt: now,
    }
  }
}
