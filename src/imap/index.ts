/**
 * IMAP module exports
 */

export { ImapClient } from './client.js'
export { IdleManager, type NewMailCallback, type IdleState } from './idle.js'
export { parseEmail, formatEmailInstruction, type ParsedEmailResult } from './parser.js'
