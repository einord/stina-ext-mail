/**
 * Settings Tools
 *
 * Tools for managing mail settings. Each tool creates a repository instance
 * using the user-scoped storage and secrets from ExecutionContext.
 */

import type { Tool, ToolResult, ExecutionContext } from '@stina/extension-api/runtime'
import { MailRepository } from '../db/repository.js'
import type { MailSettingsUpdate } from '../types.js'

/**
 * Creates a user-scoped repository from the execution context.
 * @param context Execution context with userStorage and userSecrets
 * @returns MailRepository instance
 */
function createRepository(context: ExecutionContext): MailRepository {
  return new MailRepository(context.userStorage, context.userSecrets)
}

/**
 * Creates the settings get tool.
 * Gets the current mail settings including the global instruction.
 * @returns Tool definition
 */
export function createGetSettingsTool(): Tool {
  return {
    id: 'mail_settings_get',
    name: 'Get Mail Settings',
    description: 'Gets the current mail settings including the global instruction',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(
      _params: Record<string, unknown>,
      context: ExecutionContext
    ): Promise<ToolResult> {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const repository = createRepository(context)
        const settings = await repository.settings.get()

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
 * Creates the settings update tool.
 * Updates the mail settings such as the global instruction for handling emails.
 * @param onUpdate Optional callback after update
 * @returns Tool definition
 */
export function createUpdateSettingsTool(
  onUpdate?: (userId: string) => void
): Tool {
  return {
    id: 'mail_settings_update',
    name: 'Update Mail Settings',
    description: 'Updates the mail settings such as the global instruction for handling emails',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'Global instruction for how to handle incoming emails',
        },
      },
    },
    async execute(
      params: Record<string, unknown>,
      context: ExecutionContext
    ): Promise<ToolResult> {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      const input = params as MailSettingsUpdate

      try {
        const repository = createRepository(context)
        const settings = await repository.settings.update(input)

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
