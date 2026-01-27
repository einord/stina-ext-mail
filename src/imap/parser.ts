/**
 * Email content parser and sanitizer
 */

import { simpleParser, type ParsedMail } from 'mailparser'
import { convert } from 'html-to-text'

/**
 * Maximum length for the email body
 */
const MAX_BODY_LENGTH = 2000

/**
 * Maximum length for the snippet
 */
const MAX_SNIPPET_LENGTH = 200

/**
 * Patterns to remove from email content
 */
const CLEANUP_PATTERNS = [
  // Email signatures
  /^--\s*$/gm,
  /^Sent from my (iPhone|iPad|Android|BlackBerry|Windows Phone).*$/gim,
  /^Get Outlook for (iOS|Android).*$/gim,

  // Tracking pixels and images
  /<img[^>]*>/gi,

  // Quote headers
  /^On .+ wrote:$/gm,
  /^>+.*$/gm,

  // Disclaimer blocks
  /^CONFIDENTIALITY NOTICE.*$/gim,
  /^This email and any attachments.*$/gim,

  // Multiple newlines
  /\n{3,}/g,

  // Multiple spaces
  / {2,}/g,
]

/**
 * Parsed email result
 */
export interface ParsedEmailResult {
  body: string
  snippet: string
  hasAttachments: boolean
  attachmentCount: number
}

/**
 * Parses and sanitizes an email message.
 * @param source Raw email source (Buffer or string)
 * @returns Parsed and sanitized email content
 */
export async function parseEmail(source: Buffer | string): Promise<ParsedEmailResult> {
  try {
    const parsed: ParsedMail = await simpleParser(source)

    let body = ''

    // Prefer plain text, fall back to HTML conversion
    if (parsed.text) {
      body = parsed.text
    } else if (parsed.html) {
      body = convertHtmlToText(parsed.html)
    }

    // Clean up the body
    body = cleanupContent(body)

    // Truncate if too long
    if (body.length > MAX_BODY_LENGTH) {
      body = body.substring(0, MAX_BODY_LENGTH) + '...'
    }

    // Generate snippet
    const snippet = generateSnippet(body)

    return {
      body,
      snippet,
      hasAttachments: (parsed.attachments?.length || 0) > 0,
      attachmentCount: parsed.attachments?.length || 0,
    }
  } catch {
    return {
      body: '[Failed to parse email content]',
      snippet: '[Failed to parse email]',
      hasAttachments: false,
      attachmentCount: 0,
    }
  }
}

/**
 * Converts HTML email content to plain text.
 * @param html HTML content
 * @returns Plain text
 */
function convertHtmlToText(html: string): string {
  return convert(html, {
    wordwrap: 80,
    selectors: [
      // Ignore images
      { selector: 'img', format: 'skip' },
      // Ignore scripts and styles
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      // Convert links to just text
      { selector: 'a', options: { ignoreHref: true } },
      // Skip tracking pixels
      { selector: 'img[width="1"]', format: 'skip' },
      { selector: 'img[height="1"]', format: 'skip' },
    ],
  })
}

/**
 * Cleans up email content by removing signatures, quotes, etc.
 * @param content Raw content
 * @returns Cleaned content
 */
function cleanupContent(content: string): string {
  let cleaned = content

  // Apply cleanup patterns
  for (const pattern of CLEANUP_PATTERNS) {
    cleaned = cleaned.replace(pattern, '\n')
  }

  // Remove signature block (everything after -- on its own line)
  const signatureIndex = cleaned.indexOf('\n-- \n')
  if (signatureIndex > 0) {
    cleaned = cleaned.substring(0, signatureIndex)
  }

  // Remove quoted replies (> lines)
  const lines = cleaned.split('\n')
  const nonQuotedLines = lines.filter((line) => !line.startsWith('>'))
  cleaned = nonQuotedLines.join('\n')

  // Trim whitespace
  cleaned = cleaned.trim()

  // Normalize line endings
  cleaned = cleaned.replace(/\r\n/g, '\n')

  // Remove excessive newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')

  return cleaned
}

/**
 * Generates a short snippet from the email body.
 * @param body Full email body
 * @returns Short snippet
 */
function generateSnippet(body: string): string {
  // Take first non-empty line that's not a greeting
  const lines = body.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (/^(Hi|Hello|Dear|Hey|Good morning|Good afternoon)\b/i.test(trimmed)) return false
    return true
  })

  const firstLine = lines[0] || body.substring(0, MAX_SNIPPET_LENGTH)
  let snippet = firstLine.trim()

  if (snippet.length > MAX_SNIPPET_LENGTH) {
    snippet = snippet.substring(0, MAX_SNIPPET_LENGTH - 3) + '...'
  }

  return snippet
}

/**
 * Formats an email for display in Stina's instruction.
 * @param email Email data
 * @param accountName Display name of the account
 * @param instruction Global instruction
 * @returns Formatted instruction message
 */
export function formatEmailInstruction(
  email: {
    from: { name?: string; address: string }
    to: { name?: string; address: string }[]
    subject: string
    date: string
    body: string
  },
  accountName: string,
  instruction: string
): string {
  const fromDisplay = email.from.name
    ? `${email.from.name} <${email.from.address}>`
    : email.from.address

  const toDisplay = email.to
    .map((addr) => (addr.name ? `${addr.name} <${addr.address}>` : addr.address))
    .join(', ')

  const parts = [
    '[New Email]',
    `From: ${fromDisplay}`,
    `To: ${toDisplay} (${accountName})`,
    `Subject: ${email.subject}`,
    `Date: ${new Date(email.date).toLocaleString()}`,
    'Email content:',
    '---',
    email.body,
    '---',
    ''
  ]

  if (instruction) {
    parts.push(instruction)
  }

  return parts.join('\n')
}
