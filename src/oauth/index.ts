/**
 * OAuth2 module exports
 */

export {
  initiateDeviceCodeFlow,
  pollForToken,
  refreshAccessToken,
  type DeviceCodeConfig,
  type DeviceCodeFlowResult,
} from './device-code.js'

export {
  initiateGmailAuth,
  pollGmailToken,
  refreshGmailToken,
  isGmailTokenExpired,
  type GmailOAuthConfig,
} from './gmail.js'

export {
  initiateOutlookAuth,
  pollOutlookToken,
  refreshOutlookToken,
  isOutlookTokenExpired,
  DEFAULT_OUTLOOK_CLIENT_ID,
  type OutlookOAuthConfig,
} from './outlook.js'
