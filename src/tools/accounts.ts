/**
 * Mail Account Tools
 */

import type { Tool, ToolResult, ExecutionContext } from '@stina/extension-api/runtime'
import type { MailRepository } from '../db/repository.js'
import type { ProviderRegistry } from '../providers/index.js'
import type { MailProvider, MailAccountInput } from '../types.js'

/**
 * Creates the mail_accounts_list tool.
 * @param repository Mail repository
 * @returns Tool definition
 */
export function createListAccountsTool(repository: MailRepository): Tool {
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
        const userRepo = repository.withUser(context.userId)
        const accounts = await userRepo.accounts.list({
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
 * @param repository Mail repository
 * @param providers Provider registry
 * @returns Tool definition
 */
export function createAddAccountTool(
  repository: MailRepository,
  providers: ProviderRegistry
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

        const userRepo = repository.withUser(context.userId)
        const account = await userRepo.accounts.upsert(undefined, input)

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
 * @param repository Mail repository
 * @returns Tool definition
 */
export function createUpdateAccountTool(repository: MailRepository): Tool {
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
        const userRepo = repository.withUser(context.userId)

        // Get existing account to merge with partial update
        const existing = await userRepo.accounts.get(input.id)
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

        const account = await userRepo.accounts.upsert(input.id, updateData)

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
 * @param repository Mail repository
 * @param onDelete Callback after deletion
 * @returns Tool definition
 */
export function createDeleteAccountTool(
  repository: MailRepository,
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
        const userRepo = repository.withUser(context.userId)
        const deleted = await userRepo.accounts.delete(id)

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
 * @param repository Mail repository
 * @param providers Provider registry
 * @returns Tool definition
 */
export function createTestAccountTool(
  repository: MailRepository,
  providers: ProviderRegistry
): Tool {
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
        const userRepo = repository.withUser(context.userId)
        const account = await userRepo.accounts.get(id)

        if (!account) {
          return { success: false, error: 'Account not found' }
        }

        const provider = providers.getRequired(account.provider)
        const connected = await provider.testConnection(account, account.credentials)

        // Update sync status
        await userRepo.accounts.updateSyncStatus(
          id,
          connected ? null : 'Connection test failed'
        )

        return {
          success: true,
          data: {
            connected,
            message: connected ? 'Connection successful' : 'Connection failed',
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
