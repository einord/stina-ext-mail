/**
 * Mail Provider Registry
 */

import type { MailProviderInterface, ProviderConfig } from './types.js'
import type { MailProvider } from '../types.js'
import { createICloudProvider } from './icloud.js'
import { createGmailProvider, GmailProvider } from './gmail.js'
import { createOutlookProvider, OutlookProvider } from './outlook.js'
import { DEFAULT_OUTLOOK_CLIENT_ID } from '../oauth/index.js'
import { createGenericImapProvider } from './generic-imap.js'

export type { MailProviderInterface, ProviderConfig } from './types.js'
export { createICloudProvider } from './icloud.js'
export { createGmailProvider, GmailProvider } from './gmail.js'
export { createOutlookProvider, OutlookProvider } from './outlook.js'
export { createGenericImapProvider } from './generic-imap.js'

/**
 * Provider registry for managing mail providers
 */
export class ProviderRegistry {
  private readonly providers: Map<string, MailProviderInterface> = new Map()
  private config: ProviderConfig = {}

  constructor() {
    // Register default providers
    this.register(createICloudProvider())
    this.register(createGmailProvider())
    this.register(createOutlookProvider())
    this.register(createGenericImapProvider())
  }

  /**
   * Registers a mail provider.
   * @param provider Provider to register
   */
  register(provider: MailProviderInterface): void {
    this.providers.set(provider.id, provider)
  }

  /**
   * Gets a provider by ID.
   * @param id Provider ID
   * @returns Provider or undefined
   */
  get(id: string): MailProviderInterface | undefined {
    return this.providers.get(id)
  }

  /**
   * Gets a provider by ID, throwing if not found.
   * @param id Provider ID
   * @returns Provider
   */
  getRequired(id: MailProvider): MailProviderInterface {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error(`Unknown mail provider: ${id}`)
    }
    return provider
  }

  /**
   * Lists all registered providers.
   * @returns Array of providers
   */
  list(): MailProviderInterface[] {
    return Array.from(this.providers.values())
  }

  /**
   * Sets the provider configuration (OAuth settings, etc.).
   * @param config Provider configuration
   */
  setConfig(config: ProviderConfig): void {
    this.config = config

    // Update Gmail provider with OAuth config
    const gmail = this.providers.get('gmail')
    if (gmail && gmail instanceof GmailProvider && config.gmailClientId && config.gmailClientSecret) {
      gmail.setOAuthConfig({
        clientId: config.gmailClientId,
        clientSecret: config.gmailClientSecret,
      })
    }

    // Update Outlook provider with OAuth config (uses default client ID if not configured)
    const outlook = this.providers.get('outlook')
    if (outlook && outlook instanceof OutlookProvider) {
      outlook.setOAuthConfig({
        clientId: config.outlookClientId || DEFAULT_OUTLOOK_CLIENT_ID,
        tenantId: config.outlookTenantId,
      })
    }
  }

  /**
   * Gets the current provider configuration.
   * @returns Provider configuration
   */
  getConfig(): ProviderConfig {
    return this.config
  }
}

/**
 * Provider display labels
 */
export const PROVIDER_LABELS: Record<MailProvider, string> = {
  icloud: 'iCloud',
  gmail: 'Gmail',
  outlook: 'Outlook',
  imap: 'IMAP',
}

/**
 * Gets the display label for a provider.
 * @param provider Provider ID
 * @returns Display label
 */
export function getProviderLabel(provider: MailProvider): string {
  return PROVIDER_LABELS[provider] || provider
}
