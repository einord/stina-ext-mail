# Mail Reader Extension for Stina

Read incoming emails from iCloud, Gmail, Outlook, or generic IMAP accounts.

## Features

- **Multiple Providers**: iCloud, Gmail, Outlook, and generic IMAP support
- **Real-time Notifications**: IMAP IDLE for instant email notifications
- **Content Sanitization**: Extracts essential text, removes HTML/images/trackers
- **OAuth2 Support**: Device Code Flow for Gmail and Outlook
- **Global Instructions**: Configure how Stina should respond to all incoming mail

## Installation

1. Download the latest release
2. Install the extension in Stina via Settings > Extensions
3. Configure your email accounts in Settings > Mail Reader > Email Accounts

## Provider Setup

### iCloud

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in and go to Security > App-Specific Passwords
3. Generate a new password for Stina
4. Use your Apple ID email and the app-specific password

### Gmail

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Gmail API
3. Create OAuth2 credentials (Desktop app)
4. Configure the Client ID and Secret in Stina admin settings
5. Add an account and complete the OAuth flow

### Outlook

1. Register an app in [Azure Portal](https://portal.azure.com)
2. Add API permissions: `IMAP.AccessAsUser.All`
3. Configure the Client ID and Tenant ID in Stina admin settings
4. Add an account and complete the OAuth flow

### Generic IMAP

1. Enter your IMAP server details (host, port)
2. Use your email username and password

## License

MIT
