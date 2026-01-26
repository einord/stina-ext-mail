/**
 * Database schema for Mail Reader extension
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Mail accounts table
 */
export const mailAccounts = sqliteTable('ext_mail_reader_accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(), // 'icloud' | 'gmail' | 'outlook' | 'imap'
  name: text('name').notNull(),
  email: text('email').notNull(),

  // IMAP settings (for generic IMAP only)
  imapHost: text('imap_host'),
  imapPort: integer('imap_port'),

  // Auth
  authType: text('auth_type').notNull(), // 'password' | 'oauth2'
  credentials: text('credentials').notNull(), // Encrypted JSON

  // Status
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastSyncAt: text('last_sync_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * Mail settings table (global settings per user)
 */
export const mailSettings = sqliteTable('ext_mail_reader_settings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  instruction: text('instruction').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * Processed emails table (track which emails we've handled)
 */
export const mailProcessed = sqliteTable('ext_mail_reader_processed', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  userId: text('user_id').notNull(),
  messageId: text('message_id').notNull(), // Email Message-ID header
  uid: integer('uid').notNull(), // IMAP UID
  processedAt: text('processed_at').notNull(),
})

/**
 * OAuth state table (for tracking OAuth flows)
 */
export const oauthState = sqliteTable('ext_mail_reader_oauth_state', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  deviceCode: text('device_code').notNull(),
  userCode: text('user_code').notNull(),
  verificationUrl: text('verification_url').notNull(),
  expiresAt: text('expires_at').notNull(),
  interval: integer('interval').notNull(),
  createdAt: text('created_at').notNull(),
})

// Type exports for records
export type MailAccountRecord = typeof mailAccounts.$inferSelect
export type MailSettingsRecord = typeof mailSettings.$inferSelect
export type MailProcessedRecord = typeof mailProcessed.$inferSelect
export type OAuthStateRecord = typeof oauthState.$inferSelect
