/**
 * Mail Account Tools
 */

import type { MailRepository } from '../db/repository.js'
import type { ProviderRegistry } from '../providers/index.js'
import type { MailProvider, MailAccountInput } from '../types.js'

/**
 * Creates the mail_accounts_list tool.
 * @param repository Mail repository
 * @returns Tool definition
 */
export function createListAccountsTool(repository: MailRepository) {
  return {
    id: 'mail_accounts_list',
    async execute(
      params: { limit?: number; offset?: number },
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const userRepo = repository.withUser(context.userId)
        const accounts = await userRepo.accounts.list({
          limit: params.limit,
          offset: params.offset,
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
) {
  return {
    id: 'mail_accounts_add',
    async execute(
      params: MailAccountInput,
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        // Validate provider
        const provider = providers.get(params.provider)
        if (!provider) {
          return { success: false, error: `Unknown provider: ${params.provider}` }
        }

        const userRepo = repository.withUser(context.userId)
        const account = await userRepo.accounts.upsert(undefined, params)

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
export function createUpdateAccountTool(repository: MailRepository) {
  return {
    id: 'mail_accounts_update',
    async execute(
      params: { id: string } & Partial<MailAccountInput>,
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const userRepo = repository.withUser(context.userId)
        const account = await userRepo.accounts.upsert(params.id, params)

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
) {
  return {
    id: 'mail_accounts_delete',
    async execute(
      params: { id: string },
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const userRepo = repository.withUser(context.userId)
        const deleted = await userRepo.accounts.delete(params.id)

        if (!deleted) {
          return { success: false, error: 'Account not found' }
        }

        if (onDelete) {
          onDelete(params.id, context.userId)
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
) {
  return {
    id: 'mail_accounts_test',
    async execute(
      params: { id: string },
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const userRepo = repository.withUser(context.userId)
        const account = await userRepo.accounts.get(params.id)

        if (!account) {
          return { success: false, error: 'Account not found' }
        }

        const provider = providers.getRequired(account.provider)
        const connected = await provider.testConnection(account, account.credentials)

        // Update sync status
        await userRepo.accounts.updateSyncStatus(
          params.id,
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
