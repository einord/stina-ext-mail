/**
 * OAuth2 module exports
 */

export {
  initiateDeviceCodeFlow,
  pollForToken,
  refreshAccessToken,
  pollForTokenWithRetry,
  type DeviceCodeConfig,
  type DeviceCodeFlowResult,
} from './device-code.js'

export {
  initiateGmailAuth,
  pollGmailToken,
  refreshGmailToken,
  isGmailTokenExpired,
  buildXOAuth2String,
  type GmailOAuthConfig,
} from './gmail.js'

export {
  initiateOutlookAuth,
  pollOutlookToken,
  refreshOutlookToken,
  isOutlookTokenExpired,
  buildOutlookXOAuth2String,
  type OutlookOAuthConfig,
} from './outlook.js'
