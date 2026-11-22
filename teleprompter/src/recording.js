const DB_NAME = 'teleprompter'
const DB_STORE = 'takes'
const DB_VERSION = 1
const MIME_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4;codecs=aac',
  'audio/mp4',
  'audio/webm;codecs=opus',
]
const RECORDER_TIMESLICE_MS = 1000

let dbPromise = null
let database = null

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** mm:ss.cc, centiseconds, matching a sound-recorder clock (00:04.08). */
export function formatFine(ms) {
  const clamped = Math.max(0, Number(ms) || 0)
  const totalCentis = Math.floor(clamped / 10)
  const centis = totalCentis % 100
  const totalSeconds = Math.floor(totalCentis / 100)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}

let sampleScratch = null

/** Peak and RMS of one AnalyserNode time-domain frame, 0–1. */
export function sampleLevel(analyser) {
  if (!analyser) return 0
  const size = analyser.fftSize
  if (!sampleScratch || sampleScratch.length !== size) sampleScratch = new Float32Array(size)
  const buf = sampleScratch
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  let peak = 0
  for (let i = 0; i < buf.length; i += 1) {
    const value = buf[i]
    sum += value * value
    const abs = value < 0 ? -value : value
    if (abs > peak) peak = abs
  }
  const rms = Math.sqrt(sum / (buf.length || 1))
  return Math.min(1, Math.max(peak, rms * 2.5))
}

/** One peak per bar across the whole buffer, mixing channels. */
export function waveformPeaks(audioBuffer, bars) {
  const count = Math.max(1, bars | 0)
  const channels = audioBuffer.numberOfChannels || 1
  const length = audioBuffer.length || 0
  const peaks = new Float32Array(count)
  if (!length) return peaks
  const block = Math.max(1, Math.floor(length / count))
  for (let i = 0; i < count; i += 1) {
    const start = i * block
    const end = Math.min(length, i === count - 1 ? length : start + block)
    let peak = 0
    let sum = 0
    let n = 0
    for (let channel = 0; channel < channels; channel += 1) {
      const data = audioBuffer.getChannelData(channel)
      for (let j = start; j < end; j += 1) {
        const value = data[j]
        const abs = value < 0 ? -value : value
        if (abs > peak) peak = abs
        sum += value * value
        n += 1
      }
    }
    const rms = Math.sqrt(sum / (n || 1))
    peaks[i] = Math.min(1, Math.max(peak, rms * 2.5))
  }
  return peaks
}

export function titleSlug(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'untitled'
}

export function extensionForMime(mime) {
  const type = String(mime || '').toLowerCase()
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a'
  return 'webm'
}

function pad(value) {
  return String(value).padStart(2, '0')
}

export function fileStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

export function takeFileName({ code, title, createdAt, extension, mimeType, blob }) {
  const when = new Date(createdAt)
  const type = blob?.type || mimeType || ''
  const ext = type ? extensionForMime(type) : extension || 'webm'
  return `${code}-${titleSlug(title)}-${fileStamp(when)}.${ext}`
}

export function isQuotaError(error) {
  if (!error) return false
  if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  return error.code === 22 || error.code === 1014
}

export function describeMediaError(error) {
  const name = error?.name || ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Microphone access was denied.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.'
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'The microphone could not be opened.'
  }
  if (name === 'SecurityError') return 'Recording needs https or localhost.'
  if (name === 'NotSupportedError') return 'This browser cannot record audio.'
  return 'Could not start recording.'
}

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null
  if (typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_TYPES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type)
    } catch {
      return false
    }
  }) ?? null
}

function unsupportedError() {
  const error = new Error('Recording is not supported')
  error.name = 'NotSupportedError'
  return error
}

function openDb() {
  if (database) return Promise.resolve(database)
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is not available'))
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true })
        store.createIndex('textKey', 'textKey', { unique: false })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      database = db
      db.onversionchange = () => {
        db.close()
        database = null
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error || new Error('Could not open recording storage'))
    }
  })
  return dbPromise
}

function rejectClosed(error) {
  if (error && (error.name === 'InvalidStateError' || error.name === 'AbortError')) {
    database = null
    dbPromise = null
  }
}

export function warmRecordingStore() {
  return openDb().catch(() => null)
}

export function listTakes(textKey) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly')
        const request = tx.objectStore(DB_STORE).index('textKey').getAll(textKey)
        request.onsuccess = () => resolve(request.result || [])
        request.onerror = () => reject(request.error || tx.error)
        tx.onerror = () => reject(tx.error || request.error)
        tx.onabort = () => {
          rejectClosed(tx.error)
          reject(tx.error || new Error('Could not read takes'))
        }
      }),
  )
}

export function addTake(record) {
  const write = (db) =>
    new Promise((resolve, reject) => {
      let tx
      try {
        tx = db.transaction(DB_STORE, 'readwrite')
      } catch (error) {
        rejectClosed(error)
        reject(error)
        return
      }
      const request = tx.objectStore(DB_STORE).add(record)
      request.onsuccess = () => {
        record.id = request.result
      }
      tx.oncomplete = () => resolve(record)
      tx.onerror = () => {
        rejectClosed(tx.error)
        reject(tx.error || request.error || new Error('Could not save this take'))
      }
      tx.onabort = () => {
        rejectClosed(tx.error)
        reject(tx.error || request.error || new Error('Could not save this take'))
      }
    })
  if (database) return write(database)
  return openDb().then(write)
}

export function removeTake(id) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => {
          rejectClosed(tx.error)
          reject(tx.error || new Error('Could not delete this take'))
        }
        tx.onabort = () => {
          rejectClosed(tx.error)
          reject(tx.error || new Error('Could not delete this take'))
        }
      }),
  )
}

function stopTracks(stream) {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

/**
 * One microphone capture. pause/resume follow MediaRecorder when the browser
 * provides them; stop() always releases the mic tracks.
 * onError runs if the recorder fails or the mic track ends mid-take.
 * onStopped runs synchronously once stop() has a blob (or null).
 */
export function createCapture({ onError, onStopped } = {}) {
  let phase = 'idle'
  let stream = null
  let recorder = null
  let chunks = []
  let mimeType = ''
  let extension = 'webm'
  let accumulated = 0
  let segmentStart = 0
  let cancelStart = false
  let stopWait = null

  function elapsedMs() {
    if (phase === 'recording') return accumulated + (performance.now() - segmentStart)
    return accumulated
  }

  function isActive() {
    return phase === 'starting' || phase === 'recording' || phase === 'paused' || phase === 'stopping'
  }

  function cancel() {
    if (phase === 'starting') cancelStart = true
  }

  async function start(audio) {
    if (phase !== 'idle') return { started: false }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw unsupportedError()
    const mime = pickMimeType()
    if (mime === null) throw unsupportedError()
    phase = 'starting'
    cancelStart = false
    accumulated = 0
    chunks = []
    mimeType = ''
    extension = 'webm'
    let localStream = null
    try {
      const constraints = audio == null || audio === true ? true : audio
      localStream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      if (cancelStart || phase !== 'starting') return { started: false, cancelled: true }
      recorder = mime ? new MediaRecorder(localStream, { mimeType: mime }) : new MediaRecorder(localStream)
      stream = localStream
      localStream = null
      mimeType = recorder.mimeType || mime || 'audio/webm'
      extension = extensionForMime(mimeType)
      recorder.addEventListener('dataavailable', (event) => {
        if (phase === 'idle') return
        if (event.data && event.data.size > 0) chunks.push(event.data)
      })
      recorder.addEventListener('error', () => {
        if (phase === 'recording' || phase === 'paused') onError?.()
      })
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (phase === 'recording' || phase === 'paused') onError?.()
        })
      }
      recorder.start(RECORDER_TIMESLICE_MS)
      segmentStart = performance.now()
      phase = 'recording'
      return { started: true, mimeType, extension }
    } catch (error) {
      if (phase === 'starting') phase = 'idle'
      throw error
    } finally {
      if (phase !== 'recording') {
        stopTracks(localStream)
        if (stream && phase !== 'recording') {
          stopTracks(stream)
          stream = null
          recorder = null
        }
        if (phase === 'starting') phase = 'idle'
      }
    }
  }

  function pause() {
    if (phase !== 'recording' || !recorder || recorder.state !== 'recording') return false
    if (typeof recorder.pause !== 'function') return false
    const next = accumulated + (performance.now() - segmentStart)
    try {
      recorder.pause()
    } catch {
      return false
    }
    accumulated = next
    phase = 'paused'
    return true
  }

  function resume() {
    if (phase !== 'paused' || !recorder || recorder.state !== 'paused') return false
    if (typeof recorder.resume !== 'function') return false
    try {
      recorder.resume()
    } catch {
      return false
    }
    segmentStart = performance.now()
    phase = 'recording'
    return true
  }

  function takeBlob(durationMs) {
    const recordedType = chunks.find((chunk) => chunk?.type)?.type || mimeType || 'audio/webm'
    const blob = chunks.length ? new Blob(chunks, { type: recordedType }) : null
    chunks = []
    const actualType = blob?.type || recordedType
    const result =
      blob && blob.size > 0
        ? {
            blob,
            durationMs: Math.max(0, durationMs),
            mimeType: actualType,
            extension: extensionForMime(actualType),
          }
        : null
    stopTracks(stream)
    stream = null
    recorder = null
    phase = 'idle'
    accumulated = 0
    return result
  }

  function emitStopped(result) {
    try {
      onStopped?.(result)
    } catch {
      /* the caller reports save failures */
    }
  }

  function stop() {
    if (stopWait) return stopWait
    if (phase === 'idle') {
      emitStopped(null)
      return Promise.resolve(null)
    }
    if (phase === 'starting') {
      cancelStart = true
      emitStopped(null)
      return Promise.resolve(null)
    }
    const durationMs = elapsedMs()
    phase = 'stopping'
    const rec = recorder
    if (!rec || rec.state === 'inactive') {
      const result = takeBlob(durationMs)
      emitStopped(result)
      return Promise.resolve(result)
    }
    let resolveStop = () => {}
    const wait = new Promise((resolve) => {
      resolveStop = resolve
    })
    stopWait = wait
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (stopWait === wait) stopWait = null
      const result = takeBlob(durationMs)
      emitStopped(result)
      resolveStop(result)
    }
    rec.addEventListener('stop', finish, { once: true })
    try {
      rec.stop()
    } catch {
      finish()
    }
    return wait
  }

  return {
    get phase() {
      return phase
    },
    get stream() {
      return stream
    },
    elapsedMs,
    isActive,
    start,
    pause,
    resume,
    stop,
    cancel,
  }
}
