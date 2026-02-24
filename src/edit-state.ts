/**
 * In-memory edit state management for mail account forms.
 */

import type { EditState, EditFormState } from './types.js'

const MAX_EDIT_STATES = 100

/** In-memory edit state per user */
const editStates = new Map<string, EditState>()

function getDefaultEditState(): EditState {
  return {
    showModal: false,
    modalTitle: 'Add Account',
    editingId: null,
    form: {
      provider: 'icloud',
      name: '',
      email: '',
      password: '',
      imapHost: '',
      imapPort: '993',
      imapSecurity: 'ssl',
      allowSelfSignedCert: false,
      username: '',
    },
    oauthStatus: 'pending',
    oauthUrl: '',
    oauthCode: '',
  }
}

export function getEditState(userId: string): EditState {
  if (!editStates.has(userId)) {
    // Evict oldest entries if we exceed the limit
    if (editStates.size >= MAX_EDIT_STATES) {
      const oldestKey = editStates.keys().next().value
      if (oldestKey) editStates.delete(oldestKey)
    }
    editStates.set(userId, getDefaultEditState())
  }
  return editStates.get(userId)!
}

export function deleteEditState(userId: string): void {
  editStates.delete(userId)
}

export function clearAllEditStates(): void {
  editStates.clear()
}

export type { EditFormState }
