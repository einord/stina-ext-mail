/**
 * Mail Account Tools
 *
 * Tools for managing mail accounts. Each tool creates a repository instance
 * using the user-scoped storage and secrets from ExecutionContext.
 */

import type { Tool, ToolResult, ExecutionContext } from '@stina/extension-api/runtime'
import { MailRepository } from '../db/repository.js'
import type { ProviderRegistry } from '../providers/index.js'
import type { MailAccountInput } from '../types.js'

/**
 * Creates a user-scoped repository from the execution context.
 * @param context Execution context with userStorage and userSecrets
 * @returns MailRepository instance
 */
function createRepository(context: ExecutionContext): MailRepository {
  return new MailRepository(context.userStorage, context.userSecrets)
}

/**
 * Creates the mail_accounts_list tool.
 * Lists all configured mail accounts for the current user.
 * @returns Tool definition
 */
export function createListAccountsTool(
  onUserHasAccounts?: (userId: string) => Promise<void>
): Tool {
  return {
    id: 'mail_accounts_list',
    name: 'List Mail Accounts',
    description: 'Lists all configured mail accounts for the current user',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of accounts to return',
        },
        offset: {
          type: 'number',
          description: 'Number of accounts to skip for pagination',
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

      const { limit, offset } = params as { limit?: number; offset?: number }

      try {
        const repository = createRepository(context)
        const accounts = await repository.accounts.list({
          limit,
          offset,
        })

        // Remove sensitive credential data from response
        const safeAccounts = accounts.map((account) => ({
          id: account.id,
          provider: account.provider,
          name: account.name,
          email: account.email,
          enabled: account.enabled,
          lastSyncAt: account.lastSyncAt,
          lastError: account.lastError,
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
        }))

        // Self-heal: register user for polling if they have accounts
        if (safeAccounts.length > 0 && onUserHasAccounts) {
          void onUserHasAccounts(context.userId)
        }

        return {
          success: true,
          data: {
            accounts: safeAccounts,
            count: safeAccounts.length,
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
 * Creates the mail_accounts_add tool.
 * Adds a new mail account with the specified provider and credentials.
 * @param providers Provider registry for validation
 * @returns Tool definition
 */
export function createAddAccountTool(
  providers: ProviderRegistry,
  onAccountAdded?: (userId: string) => Promise<void>
): Tool {
  return {
    id: 'mail_accounts_add',
    name: 'Add Mail Account',
    description: 'Adds a new mail account with the specified provider and credentials',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Email provider type: icloud, gmail, outlook, or imap',
          enum: ['icloud', 'gmail', 'outlook', 'imap'],
        },
        name: {
          type: 'string',
          description: 'Display name for this account (e.g., "Work Email")',
        },
        email: {
          type: 'string',
          description: 'Email address for the account',
        },
        imapHost: {
          type: 'string',
          description: 'IMAP server hostname (required for generic IMAP)',
        },
        imapPort: {
          type: 'number',
          description: 'IMAP server port (default: 993)',
        },
        username: {
          type: 'string',
          description: 'Username for authentication (defaults to email)',
        },
        password: {
          type: 'string',
          description: 'Password or app-specific password',
        },
        accessToken: {
          type: 'string',
          description: 'OAuth2 access token (for Gmail/Outlook)',
        },
        refreshToken: {
          type: 'string',
          description: 'OAuth2 refresh token (for Gmail/Outlook)',
        },
        expiresAt: {
          type: 'string',
          description: 'OAuth2 token expiration time (ISO 8601)',
        },
      },
      required: ['provider', 'name', 'email'],
    },
    async execute(
      params: Record<string, unknown>,
      context: ExecutionContext
    ): Promise<ToolResult> {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      const input = params as unknown as MailAccountInput

      try {
        // Validate provider
        const provider = providers.get(input.provider)
        if (!provider) {
          return { success: false, error: `Unknown provider: ${input.provider}` }
        }

        const repository = createRepository(context)
        const account = await repository.accounts.upsert(undefined, input)

        // Register user and start polling for this new account
        if (onAccountAdded) {
          void onAccountAdded(context.userId)
        }

        return {
          success: true,
          data: {
            id: account.id,
            provider: account.provider,
            name: account.name,
            email: account.email,
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
 * Creates the mail_accounts_update tool.
 * Updates an existing mail account configuration.
 * @returns Tool definition
 */
export function createUpdateAccountTool(): Tool {
  return {
    id: 'mail_accounts_update',
    name: 'Update Mail Account',
    description: 'Updates an existing mail account configuration',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The unique ID of the account to update',
        },
        provider: {
          type: 'string',
          description: 'Email provider type: icloud, gmail, outlook, or imap',
          enum: ['icloud', 'gmail', 'outlook', 'imap'],
        },
        name: {
          type: 'string',
          description: 'Display name for this account',
        },
        email: {
          type: 'string',
          description: 'Email address for the account',
        },
        imapHost: {
          type: 'string',
          description: 'IMAP server hostname',
        },
        imapPort: {
          type: 'number',
          description: 'IMAP server port',
        },
        username: {
          type: 'string',
          description: 'Username for authentication',
        },
        password: {
          type: 'string',
          description: 'New password or app-specific password',
        },
        accessToken: {
          type: 'string',
          description: 'OAuth2 access token',
        },
        refreshToken: {
          type: 'string',
          description: 'OAuth2 refresh token',
        },
        expiresAt: {
          type: 'string',
          description: 'OAuth2 token expiration time (ISO 8601)',
        },
      },
      required: ['id'],
    },
    async execute(
      params: Record<string, unknown>,
      context: ExecutionContext
    ): Promise<ToolResult> {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      const input = params as unknown as { id: string } & Partial<MailAccountInput>

      try {
        const repository = createRepository(context)

        // Get existing account to merge with partial update
        const existing = await repository.accounts.get(input.id)
        if (!existing) {
          return { success: false, error: 'Account not found' }
        }

        // Merge existing data with updates
        const updateData: MailAccountInput = {
          provider: input.provider ?? existing.provider,
          name: input.name ?? existing.name,
          email: input.email ?? existing.email,
          imapHost: input.imapHost ?? existing.imapHost ?? undefined,
          imapPort: input.imapPort ?? existing.imapPort ?? undefined,
          username: input.username,
          password: input.password,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
        }

        const account = await repository.accounts.upsert(input.id, updateData)

        return {
          success: true,
          data: {
            id: account.id,
            provider: account.provider,
            name: account.name,
            email: account.email,
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
 * Creates the mail_accounts_delete tool.
 * Deletes a mail account and stops any active connections.
 * @param onDelete Optional callback after deletion
 * @returns Tool definition
 */
export function createDeleteAccountTool(
  onDelete?: (accountId: string, userId: string) => void
): Tool {
  return {
    id: 'mail_accounts_delete',
    name: 'Delete Mail Account',
    description: 'Deletes a mail account and stops any active connections',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The unique ID of the account to delete',
        },
      },
      required: ['id'],
    },
    async execute(
      params: Record<string, unknown>,
      context: ExecutionContext
    ): Promise<ToolResult> {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      const { id } = params as { id: string }

      try {
        const repository = createRepository(context)
        const deleted = await repository.accounts.delete(id)

        if (!deleted) {
          return { success: false, error: 'Account not found' }
        }

        if (onDelete) {
          onDelete(id, context.userId)
        }

        return { success: true, data: { deleted: true } }
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
 * Creates the mail_accounts_test tool.
 * Tests the connection to a mail account.
 * @param providers Provider registry
 * @returns Tool definition
 */
export function createTestAccountTool(providers: ProviderRegistry): Tool {
  return {
    id: 'mail_accounts_test',
    name: 'Test Mail Account',
    description: 'Tests the connection to a mail account',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The unique ID of the account to test',
        },
      },
      required: ['id'],
    },
    async execute(
      params: Record<string, unknown>,
      context: ExecutionContext
    ): Promise<ToolResult> {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      const { id } = params as { id: string }

      try {
        const repository = createRepository(context)
        const account = await repository.accounts.get(id)

        if (!account) {
          return { success: false, error: 'Account not found' }
        }

        const provider = providers.getRequired(account.provider)
        await provider.testConnection(account, account.credentials)

        // Update sync status on success
        await repository.accounts.updateSyncStatus(id, null)

        return {
          success: true,
          data: {
            connected: true,
            message: 'Connection successful',
          },
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)

        // Try to update sync status with the error
        try {
          const repository = createRepository(context)
          await repository.accounts.updateSyncStatus(id, errorMessage)
        } catch {
          // Ignore update errors
        }

        return {
          success: false,
          error: errorMessage,
        }
      }
    },
  }
}
