/**
 * IMAP IDLE implementation for real-time email notifications
 */

import type { ImapFlow } from 'imapflow'
import type { ImapClient } from './client.js'

/**
 * Callback for when new emails arrive
 */
export type NewMailCallback = (accountId: string) => void | Promise<void>

/**
 * IDLE connection state
 */
export interface IdleState {
  accountId: string
  client: ImapClient
  isIdling: boolean
  reconnectAttempts: number
  lastActivity: Date
}

/**
 * Maximum reconnect attempts before giving up
 */
const MAX_RECONNECT_ATTEMPTS = 5

/**
 * Delay between reconnect attempts (ms)
 */
const RECONNECT_DELAY = 5000

/**
 * IDLE refresh interval (IMAP IDLE typically times out after 29 minutes)
 */
const IDLE_REFRESH_INTERVAL = 25 * 60 * 1000 // 25 minutes

/**
 * IMAP IDLE manager for maintaining real-time connections
 */
export class IdleManager {
  private readonly connections: Map<string, IdleState> = new Map()
  private readonly onNewMail: NewMailCallback
  private refreshInterval: ReturnType<typeof setInterval> | null = null

  constructor(onNewMail: NewMailCallback) {
    this.onNewMail = onNewMail
  }

  /**
   * Starts IDLE monitoring for an account.
   * @param accountId Account ID
   * @param client Connected IMAP client
   */
  async startIdle(accountId: string, client: ImapClient): Promise<void> {
    // Stop any existing connection for this account
    await this.stopIdle(accountId)

    const state: IdleState = {
      accountId,
      client,
      isIdling: false,
      reconnectAttempts: 0,
      lastActivity: new Date(),
    }

    this.connections.set(accountId, state)

    // Start the IDLE loop
    await this.enterIdleLoop(state)

    // Start refresh interval if not already running
    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(() => {
        this.refreshAllConnections()
      }, IDLE_REFRESH_INTERVAL)
    }
  }

  /**
   * Stops IDLE monitoring for an account.
   * @param accountId Account ID
   */
  async stopIdle(accountId: string): Promise<void> {
    const state = this.connections.get(accountId)
    if (!state) return

    state.isIdling = false

    try {
      await state.client.disconnect()
    } catch {
      // Ignore disconnect errors during cleanup
    }

    this.connections.delete(accountId)

    // Stop refresh interval if no more connections
    if (this.connections.size === 0 && this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
  }

  /**
   * Stops all IDLE connections.
   */
  async stopAll(): Promise<void> {
    const accountIds = Array.from(this.connections.keys())
    await Promise.all(accountIds.map((id) => this.stopIdle(id)))
  }

  /**
   * Enters the IDLE loop for an account.
   */
  private async enterIdleLoop(state: IdleState): Promise<void> {
    const imapClient = state.client.getClient()
    if (!imapClient) {
      return
    }

    try {
      // Get lock on INBOX
      const lock = await imapClient.getMailboxLock('INBOX')

      try {
        state.isIdling = true
        state.lastActivity = new Date()

        // Listen for new mail events
        imapClient.on('exists', async () => {
          state.lastActivity = new Date()

          try {
            await this.onNewMail(state.accountId)
          } catch {
            // Ignore new mail handling errors
          }
        })

        // Start IDLE
        await this.doIdle(imapClient, state)
      } finally {
        lock.release()
      }
    } catch {
      await this.handleIdleError(state)
    }
  }

  /**
   * Performs the IDLE command with timeout handling.
   */
  private async doIdle(client: ImapFlow, state: IdleState): Promise<void> {
    while (state.isIdling) {
      try {
        // IDLE for up to 25 minutes (before the 29-minute server timeout)
        await client.idle()

        // Refresh activity timestamp
        state.lastActivity = new Date()
        state.reconnectAttempts = 0
      } catch (error) {
        if (!state.isIdling) {
          // Intentional stop, not an error
          return
        }
        throw error
      }
    }
  }

  /**
   * Handles IDLE errors with reconnection logic.
   */
  private async handleIdleError(state: IdleState): Promise<void> {
    state.reconnectAttempts++

    if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      await this.stopIdle(state.accountId)
      return
    }

    // Wait before reconnecting
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY))

    // Try to reconnect
    try {
      await state.client.connect()
      await this.enterIdleLoop(state)
    } catch {
      await this.handleIdleError(state)
    }
  }

  /**
   * Refreshes all IDLE connections to prevent timeout.
   */
  private refreshAllConnections(): void {
    const now = new Date()

    for (const state of this.connections.values()) {
      const idleTime = now.getTime() - state.lastActivity.getTime()

      // If idle for too long, reconnect
      if (idleTime > IDLE_REFRESH_INTERVAL) {
        void this.reconnectIdle(state)
      }
    }
  }

  /**
   * Reconnects an IDLE connection.
   */
  private async reconnectIdle(state: IdleState): Promise<void> {
    try {
      const imapClient = state.client.getClient()
      if (imapClient) {
        // Briefly exit IDLE to refresh the connection
        state.isIdling = false
        await new Promise((resolve) => setTimeout(resolve, 100))
        state.isIdling = true
        state.lastActivity = new Date()
      }
    } catch {
      await this.handleIdleError(state)
    }
  }

  /**
   * Gets the current status of all IDLE connections.
   */
  getStatus(): Array<{ accountId: string; isIdling: boolean; lastActivity: Date }> {
    return Array.from(this.connections.values()).map((state) => ({
      accountId: state.accountId,
      isIdling: state.isIdling,
      lastActivity: state.lastActivity,
    }))
  }
}
