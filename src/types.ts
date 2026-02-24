/**
 * Mail Reader Extension Types
 */

/**
 * Supported mail providers
 */
export type MailProvider = 'icloud' | 'gmail' | 'outlook' | 'imap'

/**
 * Authentication type for mail accounts
 */
export type AuthType = 'password' | 'oauth2'

/**
 * IMAP connection security type
 */
export type ImapSecurity = 'ssl' | 'starttls' | 'none'

/**
 * Mail account configuration
 */
export interface MailAccount {
  id: string
  userId: string
  provider: MailProvider
  name: string
  email: string

  // IMAP settings (for generic IMAP only)
  imapHost: string | null
  imapPort: number | null
  imapSecurity: ImapSecurity | null
  allowSelfSignedCert: boolean

  // Auth
  authType: AuthType
  // Credentials are stored encrypted, this is the decrypted form
  credentials: MailCredentials

  // Status
  enabled: boolean
  lastSyncAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Credentials for authentication
 */
export type MailCredentials = PasswordCredentials | OAuth2Credentials

/**
 * Password-based credentials (iCloud, generic IMAP)
 */
export interface PasswordCredentials {
  type: 'password'
  username: string
  password: string
}

/**
 * OAuth2 credentials (Gmail, Outlook)
 */
export interface OAuth2Credentials {
  type: 'oauth2'
  accessToken: string
  refreshToken: string
  expiresAt: string
}

/**
 * Input for creating/updating a mail account
 */
export interface MailAccountInput {
  provider: MailProvider
  name: string
  email: string
  imapHost?: string | null
  imapPort?: number | null
  imapSecurity?: ImapSecurity | null
  allowSelfSignedCert?: boolean
  username?: string
  password?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
  enabled?: boolean
}

/**
 * Mail settings for the extension
 */
export interface MailSettings {
  id: string
  userId: string
  instruction: string
  createdAt: string
  updatedAt: string
}

/**
 * Input for updating mail settings
 */
export interface MailSettingsUpdate {
  instruction?: string
}

/**
 * Processed email tracking
 */
export interface ProcessedEmail {
  id: string
  accountId: string
  userId: string
  messageId: string
  uid: number
  processedAt: string
}

/**
 * Email message (simplified for display)
 */
export interface EmailMessage {
  id: string
  accountId: string
  messageId: string
  uid: number
  from: EmailAddress
  to: EmailAddress[]
  cc?: EmailAddress[]
  subject: string
  date: string
  body: string
  snippet: string
}

/**
 * Email address
 */
export interface EmailAddress {
  name?: string
  address: string
}

/**
 * IMAP connection configuration
 */
export interface ImapConfig {
  host: string
  port: number
  secure: boolean
  tls?: { rejectUnauthorized?: boolean }
  auth: ImapAuth
}

/**
 * IMAP authentication
 */
export type ImapAuth = ImapPasswordAuth | ImapOAuth2Auth

/**
 * Password-based IMAP auth
 */
export interface ImapPasswordAuth {
  user: string
  pass: string
}

/**
 * OAuth2-based IMAP auth (XOAUTH2)
 */
export interface ImapOAuth2Auth {
  user: string
  accessToken: string
}

/**
 * OAuth2 Device Code response
 */
export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

/**
 * OAuth2 Token response
 */
export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  tokenType: string
}

/**
 * Edit state for the UI form
 */
export interface EditState {
  showModal: boolean
  modalTitle: string
  editingId: string | null
  form: EditFormState
  oauthStatus: 'pending' | 'awaiting' | 'connected'
  oauthUrl: string
  oauthCode: string
}

/**
 * Form state for account editing
 */
export interface EditFormState {
  provider: MailProvider
  name: string
  email: string
  password: string
  imapHost: string
  imapPort: string
  imapSecurity: ImapSecurity
  allowSelfSignedCert: boolean
  username: string
}

/**
 * Account display data for UI
 */
export interface AccountDisplayData {
  id: string
  name: string
  email: string
  provider: MailProvider
  providerLabel: string
  statusVariant: 'default' | 'success' | 'warning' | 'danger'
  enabled: boolean
  lastSyncAt: string | null
  lastError: string | null
}

/**
 * Options for listing accounts
 */
export interface ListAccountsOptions {
  limit?: number
  offset?: number
}

/**
 * Options for listing emails
 */
export interface ListEmailsOptions {
  accountId?: string
  limit?: number
  offset?: number
}
