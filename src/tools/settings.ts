/**
 * Settings Tools
 */

import type { MailRepository } from '../db/repository.js'
import type { MailSettingsUpdate } from '../types.js'

/**
 * Creates the settings get tool (for internal use).
 * @param repository Mail repository
 * @returns Tool definition
 */
export function createGetSettingsTool(repository: MailRepository) {
  return {
    id: 'mail_settings_get',
    name: 'Get Mail Settings',
    description: 'Gets the current mail settings including the global instruction',
    async execute(
      _params: Record<string, unknown>,
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const userRepo = repository.withUser(context.userId)
        const settings = await userRepo.settings.get()

        return {
          success: true,
          data: {
            instruction: settings.instruction,
          },
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}

/**
 * Creates the settings update tool (for internal use).
 * @param repository Mail repository
 * @param onUpdate Callback after update
 * @returns Tool definition
 */
export function createUpdateSettingsTool(
  repository: MailRepository,
  onUpdate?: (userId: string) => void
) {
  return {
    id: 'mail_settings_update',
    name: 'Update Mail Settings',
    description: 'Updates the mail settings such as the global instruction for handling emails',
    async execute(
      params: Record<string, unknown>,
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      const input = params as MailSettingsUpdate

      try {
        const userRepo = repository.withUser(context.userId)
        const settings = await userRepo.settings.update(input)

        if (onUpdate) {
          onUpdate(context.userId)
        }

        return {
          success: true,
          data: {
            instruction: settings.instruction,
          },
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
