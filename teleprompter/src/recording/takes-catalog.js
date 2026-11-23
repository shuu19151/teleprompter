/**
 * Take catalog shared by the Documents folder and the in-memory page store.
 * Grouping stays on textKey. Migration writes a file before it deletes a blob.
 */
export const SIDECAR_VERSION = 1
export const SIDECAR_PEAKS = 400
export const MIGRATION_FLAG = 'teleprompter:takesMigrated'

export function fileBaseName(path) {
  if (typeof path !== 'string' || !path) return ''
  const parts = path.split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..')
  return parts.pop() || ''
}

export function suffixedTakeName(name, index) {
  const file = String(name || '')
  if (!file || index <= 1) return file
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  return `${stem}-${index}${ext}`
}

function clampPeak(value) {
  const number = Math.abs(Number(value) || 0)
  if (!Number.isFinite(number)) return 0
  return Math.round(Math.min(1, number) * 1000) / 1000
}

/** Keep at most `max` peaks. A longer waveform keeps the loudest sample in each bucket. */
export function downsamplePeaks(peaks, max = SIDECAR_PEAKS) {
  const count = peaks?.length || 0
  const limit = Math.max(1, max | 0)
  if (!count) return []
  const out = []
  if (count <= limit) {
    for (let i = 0; i < count; i += 1) out.push(clampPeak(peaks[i]))
    return out
  }
  const bucket = count / limit
  for (let i = 0; i < limit; i += 1) {
    const start = Math.floor(i * bucket)
    const end = Math.max(start + 1, Math.min(count, Math.floor((i + 1) * bucket)))
    let peak = 0
    for (let j = start; j < end; j += 1) {
      const value = Math.abs(Number(peaks[j]) || 0)
      if (value > peak) peak = value
    }
    out.push(clampPeak(peak))
  }
  return out
}

export function sidecarDocument(take, peaks) {
  return {
    version: SIDECAR_VERSION,
    textKey: String(take?.textKey || ''),
    durationMs: Math.max(0, Math.round(Number(take?.durationMs) || 0)),
    createdAt: Math.round(Number(take?.createdAt) || 0),
    peaks: downsamplePeaks(peaks ?? take?.peaks),
    mime: String(take?.mimeType || take?.mime || ''),
  }
}

export function sidecarBytes(take, peaks) {
  return new TextEncoder().encode(JSON.stringify(sidecarDocument(take, peaks)))
}

/** Map a folder listing into the row shape the take list already renders. */
export function filesToTakes(files) {
  if (!Array.isArray(files)) return []
  return files.filter((file) => file && typeof file.name === 'string' && file.name).map((file) => ({
    id: file.name,
    name: file.name,
    textKey: typeof file.textKey === 'string' ? file.textKey : '',
    createdAt: Number(file.createdAt) || 0,
    durationMs: Math.max(0, Number(file.durationMs) || 0),
    mimeType: typeof file.mime === 'string' ? file.mime : typeof file.mimeType === 'string' ? file.mimeType : '',
    diskPath: typeof file.path === 'string' ? file.path : typeof file.diskPath === 'string' ? file.diskPath : '',
    peaks: Array.isArray(file.peaks) ? file.peaks : [],
    bytes: Number(file.bytes) || 0,
    sidecar: Boolean(file.sidecar),
  }))
}

/**
 * An existing Documents file for this IndexedDB row.
 * The path stored on the row wins. Otherwise the sidecar's text key and time
 * identify a file this migration already wrote. The plain file name is not
 * enough: two takes in the same minute share it, and the second must still be written.
 */
export function matchTakeFile(record, files) {
  if (!record || !Array.isArray(files)) return null
  const named = fileBaseName(record.diskPath)
  if (named) {
    const byPath = files.find((file) => file && file.name === named && Number(file.bytes) > 0)
    if (byPath) return byPath
  }
  const createdAt = Number(record.createdAt)
  const textKey = record.textKey
  if (!textKey || !Number.isFinite(createdAt)) return null
  return (
    files.find(
      (file) =>
        file &&
        file.sidecar &&
        Number(file.bytes) > 0 &&
        file.textKey === textKey &&
        Number(file.createdAt) === createdAt,
    ) || null
  )
}

function hasAudioBlob(record) {
  return Boolean(record && record.blob && Number(record.blob.size) > 0 && record.id != null)
}

/**
 * Copy each IndexedDB take that is not already a non-empty file.
 * `done` is false when a write or delete failed, so the caller must not set
 * the migration flag. A blob is removed only after its file's size is above zero.
 */
export async function migrateTakes({ records, files, writeTake, writeSidecar, removeBlob }) {
  const known = Array.isArray(files) ? files.slice() : []
  let done = true
  for (const record of Array.isArray(records) ? records : []) {
    if (!hasAudioBlob(record)) continue
    const match = matchTakeFile(record, known)
    try {
      if (match) {
        if (!match.sidecar) await writeSidecar(record, match)
        await removeBlob(record.id)
        continue
      }
      const written = await writeTake(record)
      if (!written || !(Number(written.bytes) > 0) || !written.name) {
        done = false
        continue
      }
      known.push({
        name: written.name,
        bytes: Number(written.bytes),
        textKey: record.textKey,
        createdAt: Number(record.createdAt) || 0,
        sidecar: true,
      })
      await removeBlob(record.id)
    } catch {
      done = false
    }
  }
  return { done }
}

/** Skip a finished migration. An interrupted run leaves the flag unset. */
export async function finishMigration({ isDone, markDone, run }) {
  if (isDone()) return { skipped: true, done: true }
  const result = await run()
  if (result?.done) markDone()
  return { skipped: false, done: Boolean(result?.done) }
}

/**
 * In-memory catalog used outside the Tauri window, and by the unit tests.
 * Saves and deletes notify listeners with the rows after the change.
 */
export function createMemoryTakes() {
  let rows = []
  const listeners = new Set()

  function snapshot() {
    return rows.map((row) => ({ ...row }))
  }

  function emit() {
    const next = snapshot()
    for (const listener of listeners) listener(next)
  }

  return {
    list() {
      return snapshot()
    },
    save(take) {
      const id = take?.id == null ? take?.name : take.id
      if (id == null || id === '') throw new Error('This take has no id.')
      const next = { ...take, id }
      const index = rows.findIndex((row) => String(row.id) === String(id))
      if (index >= 0) rows[index] = next
      else rows.push(next)
      emit()
      return { ...next }
    },
    remove(id) {
      const before = rows.length
      rows = rows.filter((row) => String(row.id) !== String(id))
      if (rows.length !== before) emit()
    },
    replace(next) {
      rows = Array.isArray(next) ? next.map((row) => ({ ...row })) : []
      emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
