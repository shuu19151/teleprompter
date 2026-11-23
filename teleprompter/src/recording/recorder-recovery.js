/**
 * Startup prompt for a native recording that did not finish.
 * Save and discard go through the existing confirm dialog. Closing it
 * without choosing leaves the session for the next launch.
 */

export function formatRecoveryDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function recoveryMessage(session) {
  const key = typeof session?.textKey === 'string' && session.textKey ? ` for ${session.textKey}` : ''
  const when = typeof session?.startedAt === 'string' && session.startedAt ? ` from ${session.startedAt}` : ''
  return `A recording${key}${when} (${formatRecoveryDuration(session?.durationMs)}) was interrupted. Save it as a take, or discard it.`
}

/**
 * Ask once per unfinished session. `true` saves, `false` discards, and any
 * other result leaves that session on disk.
 */
export async function recoverUnfinishedRecordings({ invoke, askConfirm }) {
  const sessions = await invoke('recorder_recover')
  if (!Array.isArray(sessions) || sessions.length === 0) return []
  const applied = []
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId) continue
    const choice = await askConfirm({
      title: 'Unfinished recording',
      message: recoveryMessage(session),
      confirmLabel: 'Save',
      cancelLabel: 'Discard',
      confirmIsDanger: false,
      dismiss: 'later',
    })
    if (choice !== true && choice !== false) {
      applied.push({ sessionId: session.sessionId, action: 'later' })
      continue
    }
    const action = choice ? 'save' : 'discard'
    await invoke('recorder_recover_apply', { sessionId: session.sessionId, action })
    applied.push({ sessionId: session.sessionId, action })
  }
  return applied
}
