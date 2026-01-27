/**
 * OAuth2 Device Code Flow base implementation
 */

import type { TokenResponse } from '../types.js'

/**
 * Device code flow configuration
 */
export interface DeviceCodeConfig {
  clientId: string
  clientSecret?: string
  deviceCodeUrl: string
  tokenUrl: string
  scopes: string[]
}

/**
 * Device code flow result
 */
export interface DeviceCodeFlowResult {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
}

/**
 * Initiates a device code flow.
 * @param config Device code configuration
 * @returns Device code flow result with user instructions
 */
export async function initiateDeviceCodeFlow(
  config: DeviceCodeConfig
): Promise<DeviceCodeFlowResult> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scopes.join(' '),
  })

  const response = await fetch(config.deviceCodeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to initiate device code flow: ${error}`)
  }

  const data = await response.json()

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri || data.verification_url,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  }
}

/**
 * Polls for token after user authorization.
 * @param config Device code configuration
 * @param deviceCode Device code from initiation
 * @returns Token response or null if still pending
 */
export async function pollForToken(
  config: DeviceCodeConfig,
  deviceCode: string
): Promise<TokenResponse | null> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  if (config.clientSecret) {
    params.append('client_secret', config.clientSecret)
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const data = await response.json()

  // Check for pending authorization
  if (data.error === 'authorization_pending' || data.error === 'slow_down') {
    return null
  }

  // Check for other errors
  if (data.error) {
    throw new Error(`Token error: ${data.error} - ${data.error_description || ''}`)
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  }
}

/**
 * Refreshes an access token using a refresh token.
 * @param config Device code configuration
 * @param refreshToken Refresh token
 * @returns New token response
 */
export async function refreshAccessToken(
  config: DeviceCodeConfig,
  refreshToken: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  if (config.clientSecret) {
    params.append('client_secret', config.clientSecret)
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to refresh token: ${error}`)
  }

  const data = await response.json()

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // Some providers don't return new refresh token
    expiresIn: data.expires_in,
    tokenType: data.token_type,
  }
}

/**
 * Polls for token with automatic retry.
 * @param config Device code configuration
 * @param deviceCode Device code
 * @param interval Polling interval in seconds
 * @param maxAttempts Maximum number of attempts
 * @param onPoll Callback for each poll attempt
 * @returns Token response
 */
export async function pollForTokenWithRetry(
  config: DeviceCodeConfig,
  deviceCode: string,
  interval: number,
  maxAttempts: number = 60,
  onPoll?: (attempt: number) => void
): Promise<TokenResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (onPoll) {
      onPoll(attempt)
    }

    try {
      const token = await pollForToken(config, deviceCode)
      if (token) {
        return token
      }
    } catch (error) {
      // If it's a fatal error, throw it
      if (
        error instanceof Error &&
        !error.message.includes('authorization_pending') &&
        !error.message.includes('slow_down')
      ) {
        throw error
      }
    }

    // Wait for the specified interval before next poll
    await new Promise((resolve) => setTimeout(resolve, interval * 1000))
  }

  throw new Error('Token polling timed out')
}
