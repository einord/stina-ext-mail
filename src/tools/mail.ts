/**
 * Mail Tools
 */

import type { MailRepository } from '../db/repository.js'
import type { ProviderRegistry } from '../providers/index.js'

/**
 * Creates the mail_list_recent tool.
 * @param repository Mail repository
 * @param providers Provider registry
 * @returns Tool definition
 */
export function createListRecentTool(
  repository: MailRepository,
  providers: ProviderRegistry
) {
  return {
    id: 'mail_list_recent',
    async execute(
      params: { accountId?: string; limit?: number },
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        const userRepo = repository.withUser(context.userId)
        const limit = params.limit ?? 10

        // Get accounts to fetch from
        let accounts
        if (params.accountId) {
          const account = await userRepo.accounts.get(params.accountId)
          accounts = account ? [account] : []
        } else {
          accounts = await userRepo.accounts.list()
        }

        if (accounts.length === 0) {
          return {
            success: true,
            data: { emails: [], message: 'No accounts configured' },
          }
        }

        // Fetch emails from each account
        const allEmails = []

        for (const account of accounts) {
          if (!account.enabled) continue

          try {
            const provider = providers.getRequired(account.provider)
            const sinceUid = await userRepo.processed.getHighestUid(account.id)
            const emails = await provider.fetchNewEmails(account, account.credentials, sinceUid)

            // Add account info to each email
            for (const email of emails) {
              allEmails.push({
                ...email,
                accountName: account.name,
                accountEmail: account.email,
              })
            }

            // Update sync status
            await userRepo.accounts.updateSyncStatus(account.id, null)
          } catch (error) {
            // Log error but continue with other accounts
            console.error(`Failed to fetch from ${account.name}:`, error)
            await userRepo.accounts.updateSyncStatus(
              account.id,
              error instanceof Error ? error.message : String(error)
            )
          }
        }

        // Sort by date, newest first
        allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

        // Limit results
        const limitedEmails = allEmails.slice(0, limit)

        return {
          success: true,
          data: {
            emails: limitedEmails.map((email) => ({
              id: email.id,
              accountId: email.accountId,
              accountName: email.accountName,
              from: email.from,
              subject: email.subject,
              date: email.date,
              snippet: email.snippet,
            })),
            count: limitedEmails.length,
            total: allEmails.length,
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
 * Creates the mail_get tool.
 * @param repository Mail repository
 * @param providers Provider registry
 * @returns Tool definition
 */
export function createGetMailTool(
  repository: MailRepository,
  providers: ProviderRegistry
) {
  return {
    id: 'mail_get',
    async execute(
      params: { id: string },
      context: { userId?: string }
    ) {
      if (!context.userId) {
        return { success: false, error: 'User context required' }
      }

      try {
        // Parse the email ID (format: accountId:uid)
        const [accountId, uidStr] = params.id.split(':')
        if (!accountId || !uidStr) {
          return { success: false, error: 'Invalid email ID format' }
        }

        const userRepo = repository.withUser(context.userId)
        const account = await userRepo.accounts.get(accountId)

        if (!account) {
          return { success: false, error: 'Account not found' }
        }

        const provider = providers.getRequired(account.provider)
        const uid = parseInt(uidStr, 10)

        // Fetch the specific email (we fetch from uid-1 to get just this one)
        const emails = await provider.fetchNewEmails(account, account.credentials, uid - 1)
        const email = emails.find((e) => e.uid === uid)

        if (!email) {
          return { success: false, error: 'Email not found' }
        }

        return {
          success: true,
          data: {
            id: email.id,
            accountId: email.accountId,
            accountName: account.name,
            from: email.from,
            to: email.to,
            cc: email.cc,
            subject: email.subject,
            date: email.date,
            body: email.body,
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
