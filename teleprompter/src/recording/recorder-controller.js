/**
 * Record, stop, and save a take. The capture in recording.js remuxes AAC
 * into one M4A file. The takes store writes that file and its sidecar.
 */
import { inTauri } from '../library/essay-folder.js'
import { applyDeviceLost } from './microphone-controller.js'
import { createRecorderBackend } from './recorder-backend.js'
import { isQuotaError as isIdbQuotaError } from './recording.js'
import { downsamplePeaks } from './takes-catalog.js'
import {
  DISK_TAKE_MESSAGE,
  MIC_FAILED_MESSAGE,
  QUOTA_TAKE_MESSAGE,
  SAVE_TAKE_MESSAGE,
  describeMediaError,
} from './rec-messages.js'
import { WAVE_STEP_MS, storedTake, takeMeta as buildTakeMeta, takeTextKey } from './recorder-math.js'

const REC_WITH_RUN_KEY = 'teleprompter:recWithRun'

function readStorage(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore quota or private mode */
  }
}

function loadJSON(key) {
  try {
    const raw = readStorage(key)
    if (raw === null) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function loadRecWithRun() {
  const saved = loadJSON(REC_WITH_RUN_KEY)
  if (typeof saved === 'boolean') return saved
  return true
}

export function createRecorderController({ microphone, ui, wave, takes, store, deps, recorderKind = 'web' }) {
  let recWithRun = loadRecWithRun()
  let recordingMeta = null
  let saveTask = null
  let pendingCommit = null
  let panelMode = 'closed'
  let manualHold = false
  let openAfterSave = true
  let playback = null

  const capture = createRecorderBackend(recorderKind, {
    onError() {
      onCaptureError()
    },
    onStopped(result) {
      onCaptureStopped(result)
    },
    onMeter(meter) {
      wave.ingestMeter(meter)
    },
    onPeaks(batch) {
      wave.ingestPeaks(batch)
    },
    armWave(stepMs) {
      wave.armExternalPeaks(stepMs)
    },
    disarmWave() {
      wave.disarmExternalPeaks()
    },
    getTextKey() {
      return (recordingMeta || takeMeta())?.textKey || ''
    },
    getTakeMeta() {
      return recordingMeta || takeMeta()
    },
  })

  function onDeviceLost() {
    return applyDeviceLost({
      active: capture.isActive(),
      finish: (options) => finishRecording(options),
      showRecMessage: (message) => ui.showRecMessage(message),
    })
  }

  function onCaptureError() {
    ui.showRecMessage(MIC_FAILED_MESSAGE)
    void stopRecordingAndSave()
  }

  function onCaptureStopped(result) {
    pendingCommit?.(result)
  }

  function takeMeta() {
    return buildTakeMeta(deps.current())
  }

  function syncRecorderToRun() {
    if (capture.phase !== 'recording' && capture.phase !== 'paused') return
    if (!recWithRun) {
      if (!manualHold) capture.resume()
      ui.syncRecUi()
      return
    }
    if (deps.isRunning()) {
      manualHold = false
      capture.resume()
    } else capture.pause()
    ui.syncRecUi()
  }

  function releasePlayback() {
    wave.stopPlayLoop()
    wave.clearSeek()
    if (playback?.audio) {
      playback.audio.pause()
      playback.audio.removeAttribute('src')
      playback.audio.load?.()
    }
    if (playback?.url) URL.revokeObjectURL(playback.url)
    playback = null
  }

  function closeRecorderPanel() {
    if (panelMode === 'recording' && capture.isActive()) return
    const panel = document.querySelector('#recorder-panel')
    if (panel?.contains(document.activeElement)) document.querySelector('#rec')?.focus()
    wave.stopWaveLoop()
    releasePlayback()
    panelMode = 'closed'
    ui.syncPanelChrome()
    takes.markActiveTake()
  }

  function restoreRecorderPanel() {
    if (panelMode === 'recording' && capture.isActive()) {
      ui.syncPanelChrome()
      wave.startWaveLoop()
      return
    }
    if (panelMode === 'playback' && playback) {
      ui.syncPanelChrome()
      wave.paintPlayback()
      if (playback.audio && !playback.audio.paused && !playback.audio.ended) wave.startPlayLoop()
      takes.markActiveTake()
      return
    }
    panelMode = 'closed'
    ui.syncPanelChrome()
  }

  function leaveRecordingPanel() {
    wave.stopWaveLoop()
    if (panelMode === 'recording') {
      panelMode = 'closed'
      ui.syncPanelChrome()
    }
  }

  async function commitTake(meta, result) {
    microphone.closeAudioGraph()
    ui.syncRecUi()
    if (result?.failed) {
      ui.showRecMessage(inTauri() ? DISK_TAKE_MESSAGE : SAVE_TAKE_MESSAGE)
      leaveRecordingPanel()
      return null
    }
    if (result?.savedToDisk) {
      try {
        await takes.renderTakes()
        const rows = await store.list()
        const saved = rows.find(
          (row) =>
            (result.name && row.name === result.name) ||
            (result.diskPath && row.diskPath === result.diskPath),
        )
        const sameText = takeTextKey(deps.current()) === meta?.textKey
        if (saved && sameText && openAfterSave) {
          const blob = await store.readBlob(saved)
          await openPlayback({ ...saved, blob })
        } else leaveRecordingPanel()
        if (saved) ui.noteTakeSaved()
        return saved || null
      } catch {
        ui.showRecMessage(inTauri() ? DISK_TAKE_MESSAGE : SAVE_TAKE_MESSAGE)
        leaveRecordingPanel()
        return null
      }
    }
    if (!result?.blob?.size || !meta?.textKey) {
      leaveRecordingPanel()
      return null
    }
    const exported = wave.exportPeaks()
    const take = storedTake({ meta, result, createdAt: Date.now() })
    take.peaks = downsamplePeaks(exported.peaks)
    return store
      .save(take)
      .then(async (saved) => {
        saved.livePeaks = exported.peaks
        saved.livePeakOrigin = exported.origin
        const sameText = takeTextKey(deps.current()) === meta.textKey
        if (sameText) {
          await takes.renderTakes()
          if (openAfterSave) await openPlayback(saved)
          else leaveRecordingPanel()
        } else leaveRecordingPanel()
        ui.noteTakeSaved()
        return saved
      })
      .catch((error) => {
        const quota = isIdbQuotaError(error)
        ui.showRecMessage(quota ? QUOTA_TAKE_MESSAGE : inTauri() ? DISK_TAKE_MESSAGE : SAVE_TAKE_MESSAGE)
        leaveRecordingPanel()
        return null
      })
  }

  function stopRecordingAndSave({ openAfter = true } = {}) {
    if (saveTask) return saveTask
    if (!capture.isActive()) return Promise.resolve(null)
    openAfterSave = openAfter
    const meta = recordingMeta || takeMeta()
    recordingMeta = null
    manualHold = false
    let resolveSave = () => {}
    const task = new Promise((resolve) => {
      resolveSave = resolve
    })
    saveTask = task
    pendingCommit = (result) => {
      pendingCommit = null
      wave.stopWaveLoop()
      commitTake(meta, result).then(resolveSave)
    }
    try {
      capture.stop()
    } catch {
      pendingCommit = null
      microphone.closeAudioGraph()
      ui.showRecMessage(SAVE_TAKE_MESSAGE)
      leaveRecordingPanel()
      resolveSave(null)
    }
    ui.syncRecUi()
    task.finally(() => {
      if (saveTask === task) saveTask = null
    })
    return task
  }

  async function startRecording() {
    if (capture.isActive()) return
    releasePlayback()
    wave.stopPlayLoop()
    microphone.closeAudioGraph()
    if (capture.usesWebCapture !== false) microphone.ensureAudioContext()
    ui.noteRecordingStarted()
    wave.resetPeaks()
    wave.resetRulerTrack()
    manualHold = false
    panelMode = 'recording'
    recordingMeta = takeMeta()
    ui.syncPanelChrome()
    wave.paintRecording()
    let result = null
    try {
      result = await microphone.openCapture()
    } catch (error) {
      recordingMeta = null
      panelMode = 'closed'
      wave.stopWaveLoop()
      microphone.closeAudioGraph()
      ui.syncPanelChrome()
      ui.showRecMessage(describeMediaError(error))
      ui.syncRecUi()
      return
    }
    if (!result?.started) {
      recordingMeta = null
      panelMode = 'closed'
      wave.stopWaveLoop()
      microphone.closeAudioGraph()
      ui.syncPanelChrome()
      ui.syncRecUi()
      return
    }
    if (!recordingMeta) recordingMeta = takeMeta()
    if (capture.stream) microphone.attachAnalyser(capture.stream)
    if (panelMode !== 'recording' || !capture.isActive()) {
      microphone.closeAudioGraph()
      return
    }
    wave.startWaveLoop()
    if (recWithRun) deps.playRun()
    ui.syncRecUi()
    if (capture.stream) void microphone.refreshAudioInputs()
  }

  function finishRecording(options) {
    if (!capture.isActive()) return Promise.resolve(null)
    const pauseWith = recWithRun
    const task = stopRecordingAndSave(options)
    if (pauseWith) deps.pauseRun()
    return task
  }

  function toggleRecording() {
    if (capture.isActive()) return finishRecording()
    return startRecording()
  }

  function pauseRecordingFromPanel() {
    if (capture.phase !== 'recording') return
    if (recWithRun) {
      manualHold = false
      deps.pauseRun()
      return
    }
    manualHold = true
    capture.pause()
    ui.syncRecUi()
  }

  function resumeRecordingFromPanel() {
    if (capture.phase !== 'paused') return
    manualHold = false
    if (recWithRun) deps.playRun()
    else {
      capture.resume()
      ui.syncRecUi()
    }
  }

  function onRecWithRunChange(event) {
    recWithRun = Boolean(event.target.checked)
    writeStorage(REC_WITH_RUN_KEY, JSON.stringify(recWithRun))
    syncRecorderToRun()
  }

  async function openPlayback(take) {
    if (!take?.blob) return
    wave.stopWaveLoop()
    releasePlayback()
    const url = URL.createObjectURL(take.blob)
    const audio = new Audio()
    audio.preload = 'auto'
    audio.src = url
    playback = {
      take,
      url,
      audio,
      peaks: take.livePeaks || take.peaks || null,
      peakOrigin: take.livePeakOrigin || 0,
      peakStep: WAVE_STEP_MS / 1000,
      ratio: 0,
    }
    panelMode = 'playback'
    audio.addEventListener('ended', () => {
      wave.stopPlayLoop()
      ui.syncPanelChrome()
      wave.paintPlayback()
    })
    audio.addEventListener('loadedmetadata', () => {
      if (playback?.audio === audio && !wave.isSeeking()) wave.paintPlayback()
    })
    ui.syncPanelChrome()
    wave.paintPlayback()
    takes.markActiveTake()
    try {
      const decoded = await wave.decodeTakePeaks(take.blob)
      if (playback?.take !== take) return
      playback.decodedDuration = Number.isFinite(decoded.duration) && decoded.duration > 0 ? decoded.duration : 0
      playback.peaks = decoded.peaks
      playback.peakOrigin = 0
      const span = wave.playbackDuration()
      if (span > 0 && decoded.peaks.length) playback.peakStep = span / decoded.peaks.length
      wave.paintPlayback()
    } catch {
      if (playback?.take === take) wave.paintPlayback()
    }
  }

  function togglePlayback() {
    const audio = playback?.audio
    if (!audio) return
    if (!audio.paused && !audio.ended) {
      audio.pause()
      wave.stopPlayLoop()
      ui.syncPanelChrome()
      wave.paintPlayback()
      return
    }
    const duration = wave.playbackDuration()
    if (audio.ended || (duration && audio.currentTime >= duration - 0.05)) {
      try {
        audio.currentTime = 0
      } catch {
        /* not seekable yet */
      }
    }
    audio
      .play()
      .then(() => {
        wave.startPlayLoop()
        ui.syncPanelChrome()
      })
      .catch(() => {
        ui.syncPanelChrome()
      })
  }

  return {
    capture,
    getMode() {
      return panelMode
    },
    getPlayback() {
      return playback
    },
    syncRecorderToRun,
    onDeviceLost,
    closeRecorderPanel,
    restoreRecorderPanel,
    stopRecordingAndSave,
    startRecording,
    finishRecording,
    toggleRecording,
    pauseRecordingFromPanel,
    resumeRecordingFromPanel,
    onRecWithRunChange,
    openPlayback,
    togglePlayback,
    isRecWithRun() {
      return recWithRun
    },
    recordingActive() {
      return capture.isActive()
    },
    recorderPaused() {
      return capture.phase === 'paused'
    },
  }
}
