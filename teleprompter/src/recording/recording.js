import { remuxMp4Blob } from './mp4remux.js'

export { describeMediaError } from './rec-messages.js'

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
const AUDIO_BITS_PER_SECOND = 192000
// The Web Audio compressor already restores some level, so this explicit makeup
// is trimmed until speech lands near -18 LUFS and encoded peaks stay under -0.5 dBFS.
const VOICE_MAKEUP_DB = 2.2
const VOICE_SAMPLE_RATE = 48000

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

/** How long Rec waits for a real sample before the take starts anyway. */
export const LEADING_SIGNAL_TIMEOUT_MS = 1500
/** How often the live stream is checked for that first sample. */
export const LEADING_SIGNAL_POLL_MS = 20

/** True when any sample is not an exact digital zero. Negative zero counts as zero. */
export function hasNonZeroSample(samples) {
  if (!samples || typeof samples.length !== 'number') return false
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i] !== 0) return true
  }
  return false
}

/**
 * 'start' on the first non-zero sample, or once the safety timeout has passed.
 * Until then the take clock and the recorder stay off, so a take does not
 * begin with the device's startup block of digital zeros.
 */
export function leadingSignalDecision(samples, elapsedMs, timeoutMs = LEADING_SIGNAL_TIMEOUT_MS) {
  if (hasNonZeroSample(samples)) return 'start'
  if (Number(elapsedMs) >= timeoutMs) return 'start'
  return 'wait'
}

function deviceKey(audio, options) {
  if (options && typeof options.deviceId === 'string') return options.deviceId
  const id = audio && typeof audio === 'object' ? audio.deviceId : null
  if (typeof id === 'string') return id
  if (id && typeof id.exact === 'string') return id.exact
  return ''
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
      const stride = Math.max(1, Math.floor((end - start) / 48))
      for (let j = start; j < end; j += stride) {
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

export function listAllTakes() {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly')
        const request = tx.objectStore(DB_STORE).getAll()
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

/** Mic constraints with the browser's own voice processing left off. */
export function micAudioConstraints(deviceId) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: VOICE_SAMPLE_RATE },
  }
  if (deviceId) audio.deviceId = { exact: deviceId }
  return audio
}

function cleanMicConstraints(audio) {
  const base = micAudioConstraints()
  if (!audio || audio === true || typeof audio !== 'object') return base
  return {
    ...base,
    ...audio,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  }
}

function dbToGain(db) {
  return 10 ** (db / 20)
}

function createVoiceContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  try {
    return new Ctx({ sampleRate: VOICE_SAMPLE_RATE })
  } catch {
    try {
      return new Ctx()
    } catch {
      return null
    }
  }
}

/**
 * Highpass, a gentle compressor, makeup gain, then a fast limiter.
 * The destination stream is what MediaRecorder and the waveform read.
 */
function buildVoiceGraph(ctx, rawStream) {
  const source = ctx.createMediaStreamSource(rawStream)
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 90
  highpass.Q.value = 0.707
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -24
  compressor.knee.value = 12
  compressor.ratio.value = 3
  compressor.attack.value = 0.005
  compressor.release.value = 0.2
  const makeup = ctx.createGain()
  makeup.gain.value = dbToGain(VOICE_MAKEUP_DB)
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -2
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.001
  limiter.release.value = 0.05
  const destination = ctx.createMediaStreamDestination()
  source.connect(highpass)
  highpass.connect(compressor)
  compressor.connect(makeup)
  makeup.connect(limiter)
  limiter.connect(destination)
  return {
    nodes: [source, highpass, compressor, makeup, limiter, destination],
    stream: destination.stream,
    // The limiter is the last stage. A monitor tap reads it without changing the chain.
    monitor: limiter,
  }
}

/**
 * One microphone capture. pause/resume follow MediaRecorder when the browser
 * provides them. stop() ends the recorder and keeps the warmed mic so the next
 * take starts on a stream that is already flowing. releasePrepared() stops the
 * tracks and closes the voice graph.
 * onError runs if the recorder fails or the mic track ends mid-take.
 * onStopped runs once stop() has a blob (or null). An mp4/AAC blob is remuxed
 * into one progressive M4A first. That blob is what playback, IndexedDB, and
 * the Tauri Documents save all use. webm is left as recorded. If the remux
 * fails, the original blob is used.
 * Voice enhance is always on. A passed `voiceEnhance: false` is ignored.
 */
export function createCapture({ onError, onStopped } = {}) {
  let phase = 'idle'
  let stream = null
  let inputStream = null
  let voiceCtx = null
  let voiceGraph = null
  let voiceMonitor = null
  let warmDeviceId = null
  let warmGeneration = 0
  let pendingOpen = null
  let pendingDeviceId = null
  let watchedStream = null
  let recorder = null
  let chunks = []
  let mimeType = ''
  let extension = 'webm'
  let accumulated = 0
  let segmentStart = 0
  let cancelStart = false
  let startSerial = 0
  let stopWait = null

  function disconnectGraph() {
    const graph = voiceGraph
    voiceGraph = null
    voiceMonitor = null
    if (!graph?.nodes) return
    for (const node of graph.nodes) {
      try {
        node.disconnect()
      } catch {
        /* already disconnected */
      }
    }
  }

  function closeVoice() {
    disconnectGraph()
    const ctx = voiceCtx
    voiceCtx = null
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
  }

  function releaseStreams({ keepContext = false } = {}) {
    if (keepContext) disconnectGraph()
    else closeVoice()
    stopTracks(inputStream)
    if (stream && stream !== inputStream) stopTracks(stream)
    inputStream = null
    stream = null
    warmDeviceId = null
    watchedStream = null
  }

  function tracksLive(mediaStream) {
    if (!mediaStream || typeof mediaStream.getTracks !== 'function') return false
    return mediaStream.getTracks().some((track) => track.readyState === 'live')
  }

  function streamReady(deviceId) {
    return warmDeviceId === deviceId && tracksLive(inputStream) && !!stream
  }

  function primeVoiceContext() {
    if (!voiceCtx || voiceCtx.state === 'closed') voiceCtx = createVoiceContext()
    if (voiceCtx?.state === 'suspended') voiceCtx.resume().catch(() => {})
    return voiceCtx
  }

  function watchInputTracks() {
    if (!inputStream || watchedStream === inputStream) return
    watchedStream = inputStream
    for (const track of inputStream.getTracks()) {
      track.addEventListener('ended', () => {
        if (phase === 'recording' || phase === 'paused') onError?.()
      })
    }
  }

  async function openInput(audio, deviceId, generation) {
    primeVoiceContext()
    releaseStreams({ keepContext: true })
    let opened = null
    try {
      opened = await navigator.mediaDevices.getUserMedia({ audio: cleanMicConstraints(audio) })
      if (generation !== warmGeneration) {
        stopTracks(opened)
        return 'stale'
      }
      inputStream = opened
      opened = null
      warmDeviceId = deviceId
      stream = inputStream
      voiceMonitor = null
      if (!voiceCtx || voiceCtx.state === 'closed') primeVoiceContext()
      if (voiceCtx) {
        try {
          voiceGraph = buildVoiceGraph(voiceCtx, inputStream)
          stream = voiceGraph.stream
          voiceMonitor = voiceGraph.monitor || null
          if (voiceCtx.state === 'suspended') await voiceCtx.resume().catch(() => {})
        } catch {
          disconnectGraph()
          stream = inputStream
          voiceMonitor = null
        }
      }
      if (generation !== warmGeneration) {
        releaseStreams({ keepContext: true })
        return 'stale'
      }
      watchInputTracks()
      return 'ready'
    } catch (error) {
      stopTracks(opened)
      if (generation === warmGeneration) releaseStreams({ keepContext: true })
      throw error
    }
  }

  async function ensureInput(audio, deviceId) {
    const id = deviceId || ''
    if (streamReady(id)) return 'reused'
    if (pendingOpen && pendingDeviceId === id) {
      const status = await pendingOpen
      if (streamReady(id)) return 'reused'
      return status
    }
    const generation = ++warmGeneration
    pendingDeviceId = id
    const task = openInput(audio, id, generation)
    pendingOpen = task
    try {
      return await task
    } finally {
      if (pendingOpen === task) pendingOpen = null
    }
  }

  async function waitForLeadingSignal() {
    const ctx = voiceCtx
    if (!ctx || cancelStart || phase !== 'starting') return
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    if (cancelStart || phase !== 'starting') return
    let analyser = null
    let source = null
    let mute = null
    try {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      if (voiceMonitor && typeof voiceMonitor.connect === 'function') voiceMonitor.connect(analyser)
      else if (inputStream) {
        source = ctx.createMediaStreamSource(inputStream)
        source.connect(analyser)
      } else return
      mute = ctx.createGain()
      mute.gain.value = 0
      analyser.connect(mute)
      if (ctx.destination) mute.connect(ctx.destination)
    } catch {
      return
    }
    const samples = new Float32Array(analyser.fftSize || 1024)
    const startedAt = performance.now()
    let timer = 0
    try {
      await new Promise((resolve) => {
        const tick = () => {
          if (cancelStart || phase !== 'starting') {
            resolve()
            return
          }
          try {
            analyser.getFloatTimeDomainData(samples)
          } catch {
            resolve()
            return
          }
          if (leadingSignalDecision(samples, performance.now() - startedAt) === 'start') {
            resolve()
            return
          }
          timer = setTimeout(tick, LEADING_SIGNAL_POLL_MS)
        }
        tick()
      })
    } finally {
      clearTimeout(timer)
      try {
        source?.disconnect()
      } catch {
        /* already disconnected */
      }
      try {
        voiceMonitor?.disconnect?.(analyser)
      } catch {
        /* already disconnected */
      }
      try {
        analyser.disconnect()
      } catch {
        /* already disconnected */
      }
      try {
        mute?.disconnect()
      } catch {
        /* already disconnected */
      }
    }
  }

  function releasePrepared() {
    if (phase === 'recording' || phase === 'paused' || phase === 'stopping') return false
    warmGeneration += 1
    startSerial += 1
    cancelStart = true
    releaseStreams()
    if (phase === 'starting') phase = 'idle'
    return true
  }

  async function prepare(audio, options = {}) {
    if (phase !== 'idle') return { prepared: false, busy: true }
    if (!navigator.mediaDevices?.getUserMedia) throw unsupportedError()
    primeVoiceContext()
    const status = await ensureInput(audio, deviceKey(audio, options))
    if (status !== 'ready' && status !== 'reused') return { prepared: false, stale: true }
    return { prepared: true, reused: status === 'reused' }
  }

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

  function startStillOwns(serial) {
    return serial === startSerial && phase === 'starting' && !cancelStart
  }

  async function start(audio, options = {}) {
    if (phase !== 'idle') return { started: false }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw unsupportedError()
    const mime = pickMimeType()
    if (mime === null) throw unsupportedError()
    const serial = ++startSerial
    phase = 'starting'
    cancelStart = false
    accumulated = 0
    chunks = []
    mimeType = ''
    extension = 'webm'
    // Voice enhance is always on. Resume in this turn so the click can unlock the context.
    primeVoiceContext()
    try {
      const status = await ensureInput(audio, deviceKey(audio, options))
      if (!startStillOwns(serial) || (status !== 'ready' && status !== 'reused')) {
        return { started: false, cancelled: true }
      }
      await waitForLeadingSignal()
      if (!startStillOwns(serial)) return { started: false, cancelled: true }
      const recorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
      if (mime) recorderOptions.mimeType = mime
      const rec = new MediaRecorder(stream, recorderOptions)
      recorder = rec
      mimeType = rec.mimeType || mime || 'audio/webm'
      extension = extensionForMime(mimeType)
      rec.addEventListener('dataavailable', (event) => {
        if (recorder !== rec || phase === 'idle') return
        if (event.data && event.data.size > 0) chunks.push(event.data)
      })
      rec.addEventListener('error', () => {
        if (recorder !== rec) return
        if (phase === 'recording' || phase === 'paused') onError?.()
      })
      watchInputTracks()
      if (!startStillOwns(serial)) return { started: false, cancelled: true }
      rec.start(RECORDER_TIMESLICE_MS)
      segmentStart = performance.now()
      phase = 'recording'
      return { started: true, mimeType, extension }
    } catch (error) {
      if (serial === startSerial && phase === 'starting') phase = 'idle'
      throw error
    } finally {
      if (serial !== startSerial) return
      if (phase !== 'recording') {
        if (recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch {
            /* already stopped */
          }
        }
        recorder = null
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
    try {
      // A live mic stays open for the next take. A dead track is dropped.
      if (!tracksLive(inputStream)) releaseStreams()
    } catch {
      /* the blob is already assembled */
    }
    recorder = null
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

  async function finalizeTakeAudio(result) {
    if (!result?.blob) return result
    const blob = await remuxMp4Blob(result.blob, result.mimeType)
    if (!blob?.size || blob === result.blob) return result
    const mimeType = blob.type || result.mimeType
    return {
      ...result,
      blob,
      mimeType,
      extension: extensionForMime(mimeType),
    }
  }

  function publish(result) {
    return Promise.resolve()
      .then(() => finalizeTakeAudio(result))
      .catch(() => result)
      .then((finalResult) => {
        if (phase === 'stopping') phase = 'idle'
        emitStopped(finalResult)
        return finalResult
      })
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
    const finishWith = (result) => {
      const wait = publish(result).finally(() => {
        if (stopWait === wait) stopWait = null
      })
      stopWait = wait
      return wait
    }
    if (!rec || rec.state === 'inactive') return finishWith(takeBlob(durationMs))
    let resolveStop = () => {}
    const wait = new Promise((resolve) => {
      resolveStop = resolve
    })
    stopWait = wait
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      publish(takeBlob(durationMs)).then((finalResult) => {
        if (stopWait === wait) stopWait = null
        resolveStop(finalResult)
      })
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
    prepare,
    releasePrepared,
    start,
    pause,
    resume,
    stop,
    cancel,
  }
}
