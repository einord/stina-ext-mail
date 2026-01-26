/**
 * Gmail OAuth2 implementation using Device Code Flow
 */

import {
  initiateDeviceCodeFlow,
  pollForToken,
  refreshAccessToken,
  type DeviceCodeConfig,
  type DeviceCodeFlowResult,
} from './device-code.js'
import type { TokenResponse } from '../types.js'

/**
 * Gmail OAuth2 configuration
 */
export interface GmailOAuthConfig {
  clientId: string
  clientSecret: string
}

/**
 * Gmail OAuth2 endpoints
 */
const GMAIL_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code'
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Gmail IMAP scope
 */
const GMAIL_SCOPES = ['https://mail.google.com/']

/**
 * Creates a device code config for Gmail.
 * @param config Gmail OAuth config
 * @returns Device code config
 */
function createGmailConfig(config: GmailOAuthConfig): DeviceCodeConfig {
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    deviceCodeUrl: GMAIL_DEVICE_CODE_URL,
    tokenUrl: GMAIL_TOKEN_URL,
    scopes: GMAIL_SCOPES,
  }
}

/**
 * Initiates Gmail OAuth2 device code flow.
 * @param config Gmail OAuth config
 * @returns Device code flow result with user instructions
 */
export async function initiateGmailAuth(
  config: GmailOAuthConfig
): Promise<DeviceCodeFlowResult> {
  return initiateDeviceCodeFlow(createGmailConfig(config))
}

/**
 * Polls for Gmail OAuth2 token.
 * @param config Gmail OAuth config
 * @param deviceCode Device code from initiation
 * @returns Token response or null if still pending
 */
export async function pollGmailToken(
  config: GmailOAuthConfig,
  deviceCode: string
): Promise<TokenResponse | null> {
  return pollForToken(createGmailConfig(config), deviceCode)
}

/**
 * Refreshes a Gmail OAuth2 access token.
 * @param config Gmail OAuth config
 * @param refreshToken Refresh token
 * @returns New token response
 */
export async function refreshGmailToken(
  config: GmailOAuthConfig,
  refreshToken: string
): Promise<TokenResponse> {
  return refreshAccessToken(createGmailConfig(config), refreshToken)
}

/**
 * Checks if a Gmail access token is expired or about to expire.
 * @param expiresAt Token expiration timestamp (ISO string)
 * @param bufferMinutes Minutes before expiration to consider expired (default: 5)
 * @returns True if token needs refresh
 */
export function isGmailTokenExpired(expiresAt: string, bufferMinutes: number = 5): boolean {
  const expirationTime = new Date(expiresAt).getTime()
  const bufferMs = bufferMinutes * 60 * 1000
  return Date.now() >= expirationTime - bufferMs
}

/**
 * Builds XOAUTH2 string for IMAP authentication.
 * @param email User email address
 * @param accessToken OAuth2 access token
 * @returns Base64-encoded XOAUTH2 string
 */
export function buildXOAuth2String(email: string, accessToken: string): string {
  const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  return Buffer.from(authString).toString('base64')
}
