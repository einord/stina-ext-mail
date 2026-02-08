/**
 * Accounts Repository for Mail Reader extension
 *
 * Uses the Extension Storage API for document storage and SecretsAPI for credentials.
 */

import type { StorageAPI, SecretsAPI } from '@stina/extension-api/runtime'
import type {
  MailAccount,
  MailAccountInput,
  MailCredentials,
  ListAccountsOptions,
  AuthType,
  MailProvider,
  ImapSecurity,
} from '../types.js'

/** Collection names */
const COLLECTIONS = {
  accounts: 'accounts',
  processed: 'processed',
} as const

/**
 * Generates a unique ID with the given prefix.
 * @param prefix Prefix for the ID
 * @returns Unique ID string
 */
function generateId(prefix: string): string {
  const random = Math.random().toString(36).substring(2, 10)
  const timestamp = Date.now().toString(36)
  return `${prefix}_${timestamp}${random}`
}

/**
 * Gets the secret key for storing account credentials.
 * @param accountId The account ID
 * @returns Secret key string
 */
function getCredentialsKey(accountId: string): string {
  return `account-${accountId}-credentials`
}

/**
 * Document type for account stored in storage (without credentials).
 */
interface AccountDocument {
  id: string
  provider: MailProvider
  name: string
  email: string
  imapHost: string | null
  imapPort: number | null
  imapSecurity: ImapSecurity | null
  authType: AuthType
  enabled: boolean
  lastSyncAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Repository for managing mail accounts.
 * Uses userStorage for documents and userSecrets for credentials.
 */
export class AccountsRepository {
  private readonly storage: StorageAPI
  private readonly secrets: SecretsAPI

  /**
   * Creates an AccountsRepository instance.
   * @param storage User-scoped storage API
   * @param secrets User-scoped secrets API
   */
  constructor(storage: StorageAPI, secrets: SecretsAPI) {
    this.storage = storage
    this.secrets = secrets
  }

  /**
   * Lists all mail accounts for the current user.
   * @param options List options
   * @returns Array of mail accounts with credentials
   */
  async list(options: ListAccountsOptions = {}): Promise<MailAccount[]> {
    const { limit = 50, offset = 0 } = options

    const docs = await this.storage.find<AccountDocument>(
      COLLECTIONS.accounts,
      {},
      { sort: { name: 'asc' }, limit, offset }
    )

    // Load credentials for each account
    const accounts: MailAccount[] = []
    for (const doc of docs) {
      const credentials = await this.loadCredentials(doc.id, doc.authType)
      accounts.push(this.toMailAccount(doc, credentials))
    }

    return accounts
  }

  /**
   * Gets a mail account by ID.
   * @param id Account ID
   * @returns Mail account or null
   */
  async get(id: string): Promise<MailAccount | null> {
    const doc = await this.storage.get<AccountDocument>(COLLECTIONS.accounts, id)
    if (!doc) return null

    const credentials = await this.loadCredentials(id, doc.authType)
    return this.toMailAccount(doc, credentials)
  }

  /**
   * Creates or updates a mail account.
   * @param id Account ID (if updating)
   * @param input Account input data
   * @returns Created/updated account
   */
  async upsert(id: string | undefined, input: MailAccountInput): Promise<MailAccount> {
    const now = new Date().toISOString()
    const accountId = id ?? generateId('acc')
    const existing = id ? await this.get(id) : null

    // Build credentials object
    let credentials: MailCredentials
    let authType: AuthType

    if (input.accessToken && input.refreshToken) {
      authType = 'oauth2'
      credentials = {
        type: 'oauth2',
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt ?? new Date(Date.now() + 3600 * 1000).toISOString(),
      }
    } else {
      authType = 'password'
      credentials = {
        type: 'password',
        username: input.username ?? input.email,
        password: input.password ?? '',
      }
    }

    if (existing) {
      // Update existing account
      const name = input.name ?? existing.name
      const email = input.email ?? existing.email
      const provider = input.provider ?? existing.provider
      const imapHost = input.imapHost !== undefined ? input.imapHost : existing.imapHost
      const imapPort = input.imapPort !== undefined ? input.imapPort : existing.imapPort
      const imapSecurity =
        input.imapSecurity !== undefined ? input.imapSecurity : existing.imapSecurity
      const enabled = input.enabled !== undefined ? input.enabled : existing.enabled

      // Only update credentials if new ones are provided
      const finalCredentials =
        input.password || input.accessToken ? credentials : existing.credentials
      const finalAuthType = input.password || input.accessToken ? authType : existing.authType

      const doc: AccountDocument = {
        id: accountId,
        provider,
        name,
        email,
        imapHost: imapHost ?? null,
        imapPort: imapPort ?? null,
        imapSecurity: imapSecurity ?? null,
        authType: finalAuthType,
        enabled,
        lastSyncAt: existing.lastSyncAt,
        lastError: existing.lastError,
        createdAt: existing.createdAt,
        updatedAt: now,
      }

      await this.storage.put(COLLECTIONS.accounts, accountId, doc)

      // Save credentials to secrets if updated
      if (input.password || input.accessToken) {
        await this.saveCredentials(accountId, finalCredentials)
      }

      return this.toMailAccount(doc, finalCredentials)
    }

    // Create new account
    if (!input.name || !input.email || !input.provider) {
      throw new Error('Name, email, and provider are required for new accounts')
    }

    const doc: AccountDocument = {
      id: accountId,
      provider: input.provider,
      name: input.name,
      email: input.email,
      imapHost: input.imapHost ?? null,
      imapPort: input.imapPort ?? null,
      imapSecurity: input.imapSecurity ?? null,
      authType,
      enabled: input.enabled !== false,
      lastSyncAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }

    await this.storage.put(COLLECTIONS.accounts, accountId, doc)
    await this.saveCredentials(accountId, credentials)

    return this.toMailAccount(doc, credentials)
  }

  /**
   * Deletes a mail account and its associated credentials.
   * @param id Account ID
   * @returns True if deleted
   */
  async delete(id: string): Promise<boolean> {
    const doc = await this.storage.get<AccountDocument>(COLLECTIONS.accounts, id)
    if (!doc) return false

    // Delete processed emails for this account
    await this.storage.deleteMany(COLLECTIONS.processed, { accountId: id })

    // Delete credentials from secrets
    await this.secrets.delete(getCredentialsKey(id))

    // Delete the account document
    await this.storage.delete(COLLECTIONS.accounts, id)

    return true
  }

  /**
   * Updates the sync status for an account.
   * @param id Account ID
   * @param error Error message if sync failed, null if successful
   */
  async updateSyncStatus(id: string, error: string | null): Promise<void> {
    const doc = await this.storage.get<AccountDocument>(COLLECTIONS.accounts, id)
    if (!doc) return

    const now = new Date().toISOString()
    const updatedDoc: AccountDocument = {
      ...doc,
      lastSyncAt: now,
      lastError: error,
      updatedAt: now,
    }

    await this.storage.put(COLLECTIONS.accounts, id, updatedDoc)
  }

  /**
   * Updates OAuth2 credentials for an account.
   * @param id Account ID
   * @param credentials New OAuth2 credentials
   */
  async updateCredentials(id: string, credentials: MailCredentials): Promise<void> {
    const doc = await this.storage.get<AccountDocument>(COLLECTIONS.accounts, id)
    if (!doc) return

    const now = new Date().toISOString()
    const updatedDoc: AccountDocument = {
      ...doc,
      updatedAt: now,
    }

    await this.storage.put(COLLECTIONS.accounts, id, updatedDoc)
    await this.saveCredentials(id, credentials)
  }

  /**
   * Saves credentials to the secrets store.
   * @param accountId Account ID
   * @param credentials Credentials to save
   */
  private async saveCredentials(accountId: string, credentials: MailCredentials): Promise<void> {
    const key = getCredentialsKey(accountId)
    await this.secrets.set(key, JSON.stringify(credentials))
  }

  /**
   * Loads credentials from the secrets store.
   * @param accountId Account ID
   * @param authType The auth type to determine default credentials
   * @returns Credentials or default empty credentials
   */
  private async loadCredentials(accountId: string, authType: AuthType): Promise<MailCredentials> {
    const key = getCredentialsKey(accountId)
    const stored = await this.secrets.get(key)

    if (stored) {
      return JSON.parse(stored) as MailCredentials
    }

    // Return default empty credentials
    if (authType === 'oauth2') {
      return { type: 'oauth2', accessToken: '', refreshToken: '', expiresAt: '' }
    }
    return { type: 'password', username: '', password: '' }
  }

  /**
   * Converts an account document and credentials to a MailAccount.
   * @param doc Account document
   * @param credentials Account credentials
   * @returns MailAccount object
   */
  private toMailAccount(doc: AccountDocument, credentials: MailCredentials): MailAccount {
    return {
      id: doc.id,
      userId: '', // User ID is implicit - data is user-scoped
      provider: doc.provider,
      name: doc.name,
      email: doc.email,
      imapHost: doc.imapHost,
      imapPort: doc.imapPort,
      imapSecurity: doc.imapSecurity,
      authType: doc.authType,
      credentials,
      enabled: doc.enabled,
      lastSyncAt: doc.lastSyncAt,
      lastError: doc.lastError,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }
  }
}
