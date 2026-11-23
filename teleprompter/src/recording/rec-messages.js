/**
 * Recorder failures that stay under the controls, and the ones that only toast.
 * A message clears when that failure is over, or when the reader dismisses it.
 */

export const DEVICE_LOST_MESSAGE = 'The microphone was disconnected. Recording stopped.'
export const MIC_FAILED_MESSAGE = 'Recording stopped because the microphone failed.'
export const MIC_DENIED_MESSAGE = 'Microphone access was denied.'
export const NO_MIC_MESSAGE = 'No microphone was found.'
export const MIC_UNOPENABLE_MESSAGE = 'The microphone could not be opened.'
export const START_RECORDING_MESSAGE = 'Could not start recording.'
export const QUOTA_TAKE_MESSAGE = 'Could not save this take because browser storage is full.'
export const SAVE_TAKE_MESSAGE = 'Could not save this take.'
export const DISK_TAKE_MESSAGE = 'Could not save the take to Documents.'
export const DELETE_TAKE_MESSAGE = 'Could not delete this take.'
export const SHOW_TAKE_MESSAGE = 'Could not show that file.'
export const PLAY_TAKE_MESSAGE = 'Could not play that take.'

const INLINE_MESSAGES = new Set([
  DEVICE_LOST_MESSAGE,
  MIC_FAILED_MESSAGE,
  MIC_DENIED_MESSAGE,
  NO_MIC_MESSAGE,
  MIC_UNOPENABLE_MESSAGE,
  START_RECORDING_MESSAGE,
  QUOTA_TAKE_MESSAGE,
  SAVE_TAKE_MESSAGE,
  DISK_TAKE_MESSAGE,
])

const TOAST_MESSAGES = new Set([DELETE_TAKE_MESSAGE, SHOW_TAKE_MESSAGE, PLAY_TAKE_MESSAGE])

const SAVE_MESSAGES = new Set([QUOTA_TAKE_MESSAGE, SAVE_TAKE_MESSAGE, DISK_TAKE_MESSAGE])

/** Unplug / no-device notes. A later device list that contains a microphone clears these. */
const DEVICE_RETURN_MESSAGES = new Set([DEVICE_LOST_MESSAGE, NO_MIC_MESSAGE])

/** The mic graph is open again. These are the notes from a failed open. */
const MIC_READY_MESSAGES = new Set([
  MIC_DENIED_MESSAGE,
  NO_MIC_MESSAGE,
  MIC_UNOPENABLE_MESSAGE,
  START_RECORDING_MESSAGE,
])

export function recorderMessageChannel(message) {
  if (INLINE_MESSAGES.has(message)) return 'inline'
  if (TOAST_MESSAGES.has(message)) return 'toast'
  return null
}

export function describeMediaError(error) {
  const name = error?.name || ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return MIC_DENIED_MESSAGE
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return NO_MIC_MESSAGE
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return MIC_UNOPENABLE_MESSAGE
  }
  return START_RECORDING_MESSAGE
}

/**
 * `recording-started` clears any inline note. `take-saved` clears a save note.
 * `device-returned` clears a device-lost or no-microphone note.
 * `mic-ready` clears a failed open once the microphone is flowing. `dismiss` hides it.
 */
export function recMessageAfter(current, event) {
  const text = current || ''
  if (event === 'dismiss' || event === 'recording-started') return ''
  if (event === 'take-saved' && SAVE_MESSAGES.has(text)) return ''
  if (event === 'device-returned' && DEVICE_RETURN_MESSAGES.has(text)) return ''
  if (event === 'mic-ready' && MIC_READY_MESSAGES.has(text)) return ''
  return text
}
