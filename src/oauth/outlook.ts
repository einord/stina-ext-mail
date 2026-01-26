/**
 * Outlook/Microsoft OAuth2 implementation using Device Code Flow
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
 * Outlook OAuth2 configuration
 */
export interface OutlookOAuthConfig {
  clientId: string
  tenantId?: string // Defaults to 'common' for multi-tenant
}

/**
 * Microsoft identity platform base URL
 */
const MS_AUTH_BASE = 'https://login.microsoftonline.com'

/**
 * Outlook IMAP scope
 */
const OUTLOOK_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
]

/**
 * Creates device code endpoints for Outlook.
 * @param tenantId Azure AD tenant ID
 * @returns Device code and token URLs
 */
function getOutlookEndpoints(tenantId: string = 'common'): {
  deviceCodeUrl: string
  tokenUrl: string
} {
  return {
    deviceCodeUrl: `${MS_AUTH_BASE}/${tenantId}/oauth2/v2.0/devicecode`,
    tokenUrl: `${MS_AUTH_BASE}/${tenantId}/oauth2/v2.0/token`,
  }
}

/**
 * Creates a device code config for Outlook.
 * @param config Outlook OAuth config
 * @returns Device code config
 */
function createOutlookConfig(config: OutlookOAuthConfig): DeviceCodeConfig {
  const endpoints = getOutlookEndpoints(config.tenantId)

  return {
    clientId: config.clientId,
    deviceCodeUrl: endpoints.deviceCodeUrl,
    tokenUrl: endpoints.tokenUrl,
    scopes: OUTLOOK_SCOPES,
  }
}

/**
 * Initiates Outlook OAuth2 device code flow.
 * @param config Outlook OAuth config
 * @returns Device code flow result with user instructions
 */
export async function initiateOutlookAuth(
  config: OutlookOAuthConfig
): Promise<DeviceCodeFlowResult> {
  return initiateDeviceCodeFlow(createOutlookConfig(config))
}

/**
 * Polls for Outlook OAuth2 token.
 * @param config Outlook OAuth config
 * @param deviceCode Device code from initiation
 * @returns Token response or null if still pending
 */
export async function pollOutlookToken(
  config: OutlookOAuthConfig,
  deviceCode: string
): Promise<TokenResponse | null> {
  return pollForToken(createOutlookConfig(config), deviceCode)
}

/**
 * Refreshes an Outlook OAuth2 access token.
 * @param config Outlook OAuth config
 * @param refreshToken Refresh token
 * @returns New token response
 */
export async function refreshOutlookToken(
  config: OutlookOAuthConfig,
  refreshToken: string
): Promise<TokenResponse> {
  return refreshAccessToken(createOutlookConfig(config), refreshToken)
}

/**
 * Checks if an Outlook access token is expired or about to expire.
 * @param expiresAt Token expiration timestamp (ISO string)
 * @param bufferMinutes Minutes before expiration to consider expired (default: 5)
 * @returns True if token needs refresh
 */
export function isOutlookTokenExpired(expiresAt: string, bufferMinutes: number = 5): boolean {
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
export function buildOutlookXOAuth2String(email: string, accessToken: string): string {
  const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  return Buffer.from(authString).toString('base64')
}
