//! Native take recorder.
//!
//! `recorder_start` opens one input (the requested id, or the default when
//! that id is missing), pushes one channel or a down-mix through a lock-free
//! ring, and a writer thread stores a 48 kHz PCM WAV. That thread also emits
//! meter and peak events. The capture callback never emits. A lost device
//! finalizes the WAV and emits `recorder://device-lost`.

mod capture;
mod device;
mod events;
mod levels;
mod wav;
mod writer;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub use events::RecorderPhase;

use device::InputDevice;
use events::{notify_device_lost, DevicesChangedEvent, ErrorEvent, RecorderEmit, StateEvent, StateNotice};

/// File sample rate. Device audio at another rate is resampled on the writer thread.
pub const OUTPUT_SAMPLE_RATE: u32 = 48_000;

const SESSIONS_DIR: &str = ".sessions";
const TAKE_FILE: &str = "take.wav";
const SESSION_FILE: &str = "session.json";

#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
  #[error("a recording is already in progress")]
  AlreadyRecording,
  #[error("no recording is in progress")]
  NotRecording,
  #[error("no microphone was found")]
  NoDevice,
  #[error("the selected microphone is not connected")]
  DeviceMissing,
  #[error("the selected channel is not available")]
  InvalidChannel,
  #[error("the microphone format is not supported")]
  UnsupportedFormat,
  #[error("could not open the microphone: {0}")]
  Capture(String),
  #[error("could not write the recording: {0}")]
  Write(String),
  #[error("could not prepare the session: {0}")]
  Session(String),
}

impl RecorderError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::AlreadyRecording => "already_recording",
      Self::NotRecording => "not_recording",
      Self::NoDevice => "no_device",
      Self::DeviceMissing => "device_missing",
      Self::InvalidChannel => "invalid_channel",
      Self::UnsupportedFormat => "unsupported_format",
      Self::Capture(_) => "capture",
      Self::Write(_) => "write",
      Self::Session(_) => "session",
    }
  }
}

impl Serialize for RecorderError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    let payload = serde_json::json!({
      "code": self.code(),
      "message": self.to_string(),
    });
    serializer.serialize_str(&payload.to_string())
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
  pub session_id: String,
  pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResponse {
  pub path: String,
  pub duration_ms: u64,
  pub bytes: u64,
  pub dropped_samples: u64,
  pub peaks: Vec<f32>,
}

pub struct RecorderState {
  inner: Mutex<RecorderInner>,
}

impl RecorderState {
  pub fn new() -> Self {
    Self {
      inner: Mutex::new(RecorderInner::new()),
    }
  }
}

pub struct RecorderInner {
  active: Option<ActiveSession>,
  /// Last input list seen while idle. The watcher emits when this changes.
  devices: Vec<InputDevice>,
  devices_ready: bool,
}

impl RecorderInner {
  pub fn new() -> Self {
    Self {
      active: None,
      devices: Vec::new(),
      devices_ready: false,
    }
  }

  pub fn status(&self) -> StateEvent {
    match &self.active {
      None => StateEvent {
        state: RecorderPhase::Idle,
        duration_ms: 0,
        session_id: None,
      },
      Some(session) => StateEvent {
        state: RecorderPhase::Recording,
        duration_ms: duration_ms(session.written.load(Ordering::Relaxed)),
        session_id: Some(session.id.clone()),
      },
    }
  }

  pub fn start_with_device(
    &mut self,
    sessions_root: &Path,
    text_key: String,
    device_id: Option<&str>,
    channel: Option<u16>,
    emit: Arc<dyn RecorderEmit>,
  ) -> Result<StartResponse, RecorderError> {
    if self.active.is_some() {
      return Err(RecorderError::AlreadyRecording);
    }
    let opened = device::open_input(device_id, channel)?;
    let device_name = opened.device_name.clone();
    let opened_id = opened.device_id.clone();
    let capture_rate = opened.capture_rate;
    let prepared = prepare_session(sessions_root, text_key, device_name)?;
    let (producer, consumer) = rtrb::RingBuffer::new(capture::ring_capacity(capture_rate));
    let dropped = Arc::new(AtomicU64::new(0));
    let written = Arc::new(AtomicU64::new(0));
    let fault = Arc::new(AtomicBool::new(false));
    let loss_notified = Arc::new(AtomicBool::new(false));
    let writer = match writer::spawn_writer(
      consumer,
      Arc::clone(&dropped),
      prepared.wav_path.clone(),
      capture_rate,
      Arc::clone(&written),
      Arc::clone(&emit),
      Arc::clone(&fault),
      opened_id.clone(),
      Arc::clone(&loss_notified),
    ) {
      Ok(writer) => writer,
      Err(error) => {
        prepared.rollback();
        return Err(error);
      }
    };
    let stream = match capture::start_input(opened, producer, dropped, Arc::clone(&fault)) {
      Ok(stream) => stream,
      Err(error) => {
        drop(writer);
        prepared.rollback();
        return Err(error);
      }
    };
    self.activate(
      prepared,
      capture::CapturePump::from_stream(stream),
      writer,
      written,
      opened_id,
      fault,
      loss_notified,
      emit,
    )
  }

  /// Stop capture and finalize the WAV when the open device has failed or left.
  ///
  /// Returns `Ok(None)` while the take should keep going. The cpal callback
  /// does not call this; it only sets the fault flag.
  pub fn finalize_if_lost<S: AsRef<str>>(
    &mut self,
    present_ids: &[S],
  ) -> Result<Option<StopResponse>, RecorderError> {
    let lost = match self.active.as_ref() {
      None => return Ok(None),
      Some(session) => device::device_loss(
        session.fault.load(Ordering::Acquire),
        &session.device_id,
        present_ids,
      )
      .is_some(),
    };
    if !lost {
      return Ok(None);
    }
    let session = self.active.take().ok_or(RecorderError::NotRecording)?;
    session.finish_lost().map(Some)
  }

  pub fn stop(&mut self) -> Result<StopResponse, RecorderError> {
    let session = self.active.take().ok_or(RecorderError::NotRecording)?;
    session.finish()
  }

  pub fn cancel(&mut self) -> Result<(), RecorderError> {
    let session = self.active.take().ok_or(RecorderError::NotRecording)?;
    session.discard()
  }

  fn activate(
    &mut self,
    prepared: PreparedSession,
    capture: capture::CapturePump,
    writer: writer::WriterHandle,
    written: Arc<AtomicU64>,
    device_id: String,
    fault: Arc<AtomicBool>,
    loss_notified: Arc<AtomicBool>,
    emit: Arc<dyn RecorderEmit>,
  ) -> Result<StartResponse, RecorderError> {
    if self.active.is_some() {
      drop(capture);
      drop(writer);
      prepared.rollback();
      return Err(RecorderError::AlreadyRecording);
    }
    let response = StartResponse {
      session_id: prepared.id.clone(),
      sample_rate: OUTPUT_SAMPLE_RATE,
    };
    self.active = Some(ActiveSession {
      id: prepared.id,
      directory: prepared.directory,
      wav_path: prepared.wav_path,
      text_key: prepared.text_key,
      device_name: prepared.device_name,
      started_at: prepared.started_at,
      capture,
      writer,
      written,
      device_id,
      fault,
      loss_notified,
      emit,
    });
    if let Some(session) = self.active.as_ref() {
      session.emit.state(&StateNotice {
        state: RecorderPhase::Recording,
        duration_ms: 0,
      });
    }
    Ok(response)
  }
}

impl Drop for RecorderInner {
  fn drop(&mut self) {
    if let Some(session) = self.active.take() {
      let _ = session.finish();
    }
  }
}

struct ActiveSession {
  id: String,
  directory: PathBuf,
  wav_path: PathBuf,
  text_key: String,
  device_name: String,
  started_at: String,
  capture: capture::CapturePump,
  writer: writer::WriterHandle,
  written: Arc<AtomicU64>,
  device_id: String,
  fault: Arc<AtomicBool>,
  loss_notified: Arc<AtomicBool>,
  emit: Arc<dyn RecorderEmit>,
}

impl ActiveSession {
  fn finish_lost(self) -> Result<StopResponse, RecorderError> {
    notify_device_lost(self.emit.as_ref(), &self.loss_notified, &self.device_id);
    self.finish()
  }

  fn finish(mut self) -> Result<StopResponse, RecorderError> {
    self.capture.stop();
    let result = match self.writer.finish() {
      Ok(done) => match write_session(
        &self.directory,
        &self.started_at,
        &self.text_key,
        &self.device_name,
        "stopped",
      ) {
        Ok(()) => Ok(StopResponse {
          path: path_string(&self.wav_path),
          duration_ms: duration_ms(done.frames),
          bytes: done.bytes,
          dropped_samples: done.dropped_samples,
          peaks: done.peaks,
        }),
        Err(error) => {
          self.emit.error(&ErrorEvent::from_recorder(&error));
          Err(error)
        }
      },
      Err(error) => Err(error),
    };
    let duration_ms = result.as_ref().map(|stopped| stopped.duration_ms).unwrap_or(0);
    self.emit.state(&StateNotice {
      state: RecorderPhase::Idle,
      duration_ms,
    });
    result
  }

  fn discard(mut self) -> Result<(), RecorderError> {
    self.capture.stop();
    let _ = self.writer.finish();
    let removed = fs::remove_dir_all(&self.directory).map_err(|error| {
      RecorderError::Session(format!(
        "could not delete {}: {error}",
        self.directory.display()
      ))
    });
    if let Err(error) = &removed {
      self.emit.error(&ErrorEvent::from_recorder(error));
    }
    self.emit.state(&StateNotice {
      state: RecorderPhase::Idle,
      duration_ms: 0,
    });
    removed
  }
}

struct PreparedSession {
  id: String,
  directory: PathBuf,
  wav_path: PathBuf,
  text_key: String,
  device_name: String,
  started_at: String,
}

impl PreparedSession {
  fn rollback(self) {
    let _ = fs::remove_dir_all(&self.directory);
  }
}

fn prepare_session(
  sessions_root: &Path,
  text_key: String,
  device_name: String,
) -> Result<PreparedSession, RecorderError> {
  let id = uuid::Uuid::new_v4().to_string();
  let directory = sessions_root.join(&id);
  fs::create_dir_all(&directory).map_err(|error| {
    RecorderError::Session(format!("could not create {}: {error}", directory.display()))
  })?;
  let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
  if let Err(error) = write_session(&directory, &started_at, &text_key, &device_name, "recording") {
    let _ = fs::remove_dir_all(&directory);
    return Err(error);
  }
  Ok(PreparedSession {
    id,
    wav_path: directory.join(TAKE_FILE),
    directory,
    text_key,
    device_name,
    started_at,
  })
}

fn write_session(
  directory: &Path,
  started_at: &str,
  text_key: &str,
  device_name: &str,
  state: &str,
) -> Result<(), RecorderError> {
  let body = serde_json::json!({
    "startedAt": started_at,
    "textKey": text_key,
    "sampleRate": OUTPUT_SAMPLE_RATE,
    "deviceName": device_name,
    "state": state,
  });
  let bytes = serde_json::to_vec_pretty(&body)
    .map_err(|error| RecorderError::Session(error.to_string()))?;
  fs::write(directory.join(SESSION_FILE), bytes).map_err(|error| {
    RecorderError::Session(format!("could not write {SESSION_FILE}: {error}"))
  })
}

fn duration_ms(frames: u64) -> u64 {
  frames.saturating_mul(1_000) / u64::from(OUTPUT_SAMPLE_RATE)
}

fn path_string(path: &Path) -> String {
  path.to_string_lossy().into_owned()
}

fn sessions_root(app: &AppHandle) -> Result<PathBuf, RecorderError> {
  let documents = app.path().document_dir().map_err(|error| {
    RecorderError::Session(format!("could not find the Documents folder: {error}"))
  })?;
  Ok(documents.join("Teleprompter").join(SESSIONS_DIR))
}

fn lock(state: &RecorderState) -> Result<MutexGuard<'_, RecorderInner>, RecorderError> {
  state
    .inner
    .lock()
    .map_err(|_| RecorderError::Session("the recorder lock was poisoned".into()))
}

struct AppEmit(AppHandle);

impl RecorderEmit for AppEmit {
  fn meter(&self, event: &events::MeterEvent) {
    let _ = self.0.emit("recorder://meter", event.clone());
  }

  fn peaks(&self, event: &events::PeaksEvent) {
    let _ = self.0.emit("recorder://peaks", event.clone());
  }

  fn state(&self, event: &StateNotice) {
    let _ = self.0.emit("recorder://state", event.clone());
  }

  fn error(&self, event: &ErrorEvent) {
    let _ = self.0.emit("recorder://error", event.clone());
  }

  fn device_lost(&self, event: &events::DeviceLostEvent) {
    let _ = self.0.emit("recorder://device-lost", event.clone());
  }

  fn devices_changed(&self, event: &DevicesChangedEvent) {
    let _ = self.0.emit("recorder://devices-changed", event.clone());
  }
}

/// Watch the input list a few times a second. While idle, a change emits
/// `recorder://devices-changed`. While recording, a stream fault or a missing
/// device finalizes the WAV and emits `recorder://device-lost`.
pub fn spawn_device_watch(app: AppHandle) {
  let built = std::thread::Builder::new()
    .name("teleprompter-devices".into())
    .spawn(move || {
      loop {
        std::thread::sleep(device::DEVICE_POLL_INTERVAL);
        poll_devices(&app);
      }
    });
  if let Err(error) = built {
    log::warn!("could not watch microphones: {error}");
  }
}

fn poll_devices(app: &AppHandle) {
  let listed = match device::list_inputs() {
    Ok(devices) => Some(devices),
    Err(error) => {
      log::debug!("could not list microphones: {error}");
      None
    }
  };
  let state = app.state::<RecorderState>();
  let mut guard = match lock(&state) {
    Ok(guard) => guard,
    Err(_) => return,
  };
  if guard.active.is_some() {
    // A failed enumeration is not "every device disappeared". Keep the open
    // id in the present list so only a real stream fault stops the take.
    let present: Vec<String> = match &listed {
      Some(devices) => devices.iter().map(|device| device.id.clone()).collect(),
      None => guard
        .active
        .as_ref()
        .map(|session| vec![session.device_id.clone()])
        .unwrap_or_default(),
    };
    if let Err(error) = guard.finalize_if_lost(&present) {
      log::error!("could not finalize after the microphone was lost: {error}");
    }
    return;
  }
  let Some(devices) = listed else {
    return;
  };
  if !guard.devices_ready {
    guard.devices = devices;
    guard.devices_ready = true;
    return;
  }
  if !device::devices_changed(&guard.devices, &devices) {
    return;
  }
  guard.devices = devices.clone();
  drop(guard);
  AppEmit(app.clone()).devices_changed(&DevicesChangedEvent { devices });
}

fn report_start_error(emit: &dyn RecorderEmit, error: &RecorderError) {
  if matches!(error, RecorderError::AlreadyRecording) {
    return;
  }
  emit.error(&ErrorEvent::from_recorder(error));
}

#[tauri::command(async)]
pub fn recorder_start(
  app: AppHandle,
  state: State<'_, RecorderState>,
  text_key: String,
  device_id: Option<String>,
  channel: Option<u16>,
) -> Result<StartResponse, RecorderError> {
  let root = sessions_root(&app)?;
  let emit = Arc::new(AppEmit(app));
  match lock(&state)?.start_with_device(
    &root,
    text_key,
    device_id.as_deref(),
    channel,
    Arc::clone(&emit) as Arc<dyn RecorderEmit>,
  ) {
    Ok(response) => Ok(response),
    Err(error) => {
      report_start_error(emit.as_ref(), &error);
      Err(error)
    }
  }
}

#[tauri::command(async)]
pub fn recorder_list_devices() -> Result<Vec<InputDevice>, RecorderError> {
  device::list_inputs()
}

#[tauri::command(async)]
pub fn recorder_stop(state: State<'_, RecorderState>) -> Result<StopResponse, RecorderError> {
  lock(&state)?.stop()
}

#[tauri::command]
pub fn recorder_status(state: State<'_, RecorderState>) -> Result<StateEvent, RecorderError> {
  Ok(lock(&state)?.status())
}

#[tauri::command(async)]
pub fn recorder_cancel(state: State<'_, RecorderState>) -> Result<(), RecorderError> {
  lock(&state)?.cancel()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::AtomicU64;

  #[test]
  fn errors_serialize_as_a_code_and_message_string() {
    let cases = [
      (
        RecorderError::AlreadyRecording,
        "already_recording",
        "a recording is already in progress",
      ),
      (
        RecorderError::NotRecording,
        "not_recording",
        "no recording is in progress",
      ),
      (
        RecorderError::NoDevice,
        "no_device",
        "no microphone was found",
      ),
      (
        RecorderError::DeviceMissing,
        "device_missing",
        "the selected microphone is not connected",
      ),
      (
        RecorderError::InvalidChannel,
        "invalid_channel",
        "the selected channel is not available",
      ),
    ];
    for (error, code, message) in cases {
      let value = serde_json::to_value(&error).unwrap();
      let parsed: serde_json::Value = serde_json::from_str(value.as_str().unwrap()).unwrap();
      assert_eq!(parsed["code"], code);
      assert_eq!(parsed["message"], message);
    }
    let quoted = RecorderError::Write("say \"no\"".into());
    let value = serde_json::to_value(&quoted).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(value.as_str().unwrap()).unwrap();
    assert_eq!(parsed["code"], "write");
    assert_eq!(
      parsed["message"],
      "could not write the recording: say \"no\""
    );
  }

  #[test]
  fn stop_and_cancel_when_idle_are_typed_errors() {
    let mut recorder = RecorderInner::new();
    assert!(matches!(recorder.stop(), Err(RecorderError::NotRecording)));
    assert!(matches!(
      recorder.cancel(),
      Err(RecorderError::NotRecording)
    ));
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert_eq!(recorder.status().session_id, None);
  }

  #[test]
  fn start_while_recording_keeps_the_open_session() {
    let dir = scratch_dir();
    let mut recorder = RecorderInner::new();
    let started = recorder
      .start_sine(dir.path(), "E01", OUTPUT_SAMPLE_RATE)
      .unwrap();
    let again = recorder
      .start_sine(dir.path(), "E02", OUTPUT_SAMPLE_RATE)
      .unwrap_err();
    assert!(matches!(again, RecorderError::AlreadyRecording));
    let status = recorder.status();
    assert_eq!(status.state, RecorderPhase::Recording);
    assert_eq!(status.session_id.as_deref(), Some(started.session_id.as_str()));
    let sessions = session_dirs(dir.path());
    assert_eq!(sessions.len(), 1);
    recorder.cancel().unwrap();
    assert!(matches!(recorder.stop(), Err(RecorderError::NotRecording)));
    assert!(session_dirs(dir.path()).is_empty());
  }

  #[test]
  fn stop_finalizes_the_session_and_reports_dropped_samples() {
    let dir = scratch_dir();
    let mut recorder = RecorderInner::new();
    let samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    let started = recorder
      .start_prefilled(dir.path(), "E01", &samples, 4)
      .unwrap();
    let session_path = dir.path().join(&started.session_id);
    let meta: serde_json::Value =
      serde_json::from_slice(&fs::read(session_path.join(SESSION_FILE)).unwrap()).unwrap();
    assert_eq!(meta["textKey"], "E01");
    assert_eq!(meta["sampleRate"], OUTPUT_SAMPLE_RATE);
    assert_eq!(meta["deviceName"], "Test input");
    assert_eq!(meta["state"], "recording");
    assert!(meta["startedAt"].as_str().unwrap().ends_with('Z'));

    let stopped = recorder.stop().unwrap();
    assert!(matches!(recorder.stop(), Err(RecorderError::NotRecording)));
    assert!(matches!(
      recorder.cancel(),
      Err(RecorderError::NotRecording)
    ));
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert_eq!(stopped.dropped_samples, 6);
    assert_eq!(stopped.duration_ms, duration_ms(4));
    assert_eq!(stopped.bytes, 44 + 8);
    assert_eq!(stopped.peaks.len(), 1);
    assert_eq!(stopped.path, path_string(&session_path.join(TAKE_FILE)));
    let after: serde_json::Value =
      serde_json::from_slice(&fs::read(session_path.join(SESSION_FILE)).unwrap()).unwrap();
    assert_eq!(after["state"], "stopped");
    let reader = hound::WavReader::open(&session_path.join(TAKE_FILE)).unwrap();
    assert_eq!(reader.duration(), 4);
  }

  #[test]
  fn cancel_deletes_the_session_folder() {
    let dir = scratch_dir();
    let mut recorder = RecorderInner::new();
    let started = recorder
      .start_sine(dir.path(), "E01", OUTPUT_SAMPLE_RATE)
      .unwrap();
    let session_path = dir.path().join(&started.session_id);
    assert!(session_path.join(TAKE_FILE).exists() || session_path.exists());
    recorder.cancel().unwrap();
    assert!(!session_path.exists());
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert!(matches!(
      recorder.cancel(),
      Err(RecorderError::NotRecording)
    ));
  }

  #[test]
  fn stop_returns_peaks_and_emits_state_around_the_take() {
    let dir = scratch_dir();
    let emit = Arc::new(MemoryEmit::default());
    let mut recorder = RecorderInner::new();
    let samples = vec![0.25f32; 4_800];
    recorder
      .start_prefilled_with(
        dir.path(),
        "E01",
        &samples,
        samples.len(),
        Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      )
      .unwrap();
    let stopped = recorder.stop().unwrap();
    assert_eq!(stopped.peaks.len(), 5);
    for value in &stopped.peaks {
      assert!((value - 0.625).abs() < 1.0e-5, "peak {value}");
    }
    let states = emit.states.lock().unwrap();
    assert_eq!(states.len(), 2);
    assert_eq!(states[0].state, RecorderPhase::Recording);
    assert_eq!(states[0].duration_ms, 0);
    assert_eq!(states[1].state, RecorderPhase::Idle);
    assert_eq!(states[1].duration_ms, stopped.duration_ms);
    let meters = emit.meters.lock().unwrap();
    let peaks = emit.peaks.lock().unwrap();
    assert_eq!(meters.len(), 2);
    assert_eq!(peaks.len(), 2);
    assert_eq!(peaks[0].start_index, 0);
    assert_eq!(peaks[1].start_index, 2);
    assert!(emit.errors.lock().unwrap().is_empty());
  }

  #[test]
  fn a_stream_fault_finalizes_a_readable_wav() {
    let dir = scratch_dir();
    let emit = Arc::new(MemoryEmit::default());
    let mut recorder = RecorderInner::new();
    let samples = [0.25f32, -0.5, 0.0, 1.0];
    recorder
      .start_prefilled_with(
        dir.path(),
        "E01",
        &samples,
        samples.len(),
        Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      )
      .unwrap();
    assert!(recorder
      .finalize_if_lost(&["test-input"])
      .unwrap()
      .is_none());
    assert_eq!(recorder.status().state, RecorderPhase::Recording);

    recorder
      .active
      .as_ref()
      .unwrap()
      .fault
      .store(true, Ordering::Release);
    let stopped = recorder
      .finalize_if_lost(&["test-input"])
      .unwrap()
      .unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert!(recorder.finalize_if_lost(&[] as &[&str]).unwrap().is_none());
    let lost = emit.lost.lock().unwrap();
    assert_eq!(lost.len(), 1);
    assert_eq!(lost[0].device_id, "test-input");
    drop(lost);

    let wav_path = std::path::PathBuf::from(&stopped.path);
    let mut reader = hound::WavReader::open(&wav_path).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 1);
    assert_eq!(spec.sample_rate, OUTPUT_SAMPLE_RATE);
    assert_eq!(spec.bits_per_sample, 16);
    assert_eq!(reader.duration(), samples.len() as u32);
    let pcm: Vec<i16> = reader.samples::<i16>().map(|sample| sample.unwrap()).collect();
    assert_eq!(
      pcm,
      samples
        .iter()
        .copied()
        .map(super::wav::f32_to_i16)
        .collect::<Vec<_>>()
    );
    let session_path = wav_path.parent().unwrap();
    let meta: serde_json::Value =
      serde_json::from_slice(&fs::read(session_path.join(SESSION_FILE)).unwrap()).unwrap();
    assert_eq!(meta["state"], "stopped");
  }

  #[test]
  fn a_missing_device_finalizes_without_a_stream_fault() {
    let dir = scratch_dir();
    let emit = Arc::new(MemoryEmit::default());
    let mut recorder = RecorderInner::new();
    let samples = [0.5f32, -0.25];
    recorder
      .start_prefilled_with(
        dir.path(),
        "E01",
        &samples,
        8,
        Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      )
      .unwrap();
    let stopped = recorder
      .finalize_if_lost(&["other-device"])
      .unwrap()
      .unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert_eq!(emit.lost.lock().unwrap().len(), 1);
    assert_eq!(emit.lost.lock().unwrap()[0].device_id, "test-input");
    let reader = hound::WavReader::open(&stopped.path).unwrap();
    assert_eq!(reader.duration(), samples.len() as u32);
    assert_eq!(reader.spec().sample_rate, OUTPUT_SAMPLE_RATE);
  }

  impl RecorderInner {
    fn start_sine(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      capture_rate: u32,
    ) -> Result<StartResponse, RecorderError> {
      self.start_sine_with(
        sessions_root,
        text_key,
        capture_rate,
        Arc::new(events::NopEmit),
      )
    }

    fn start_sine_with(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      capture_rate: u32,
      emit: Arc<dyn RecorderEmit>,
    ) -> Result<StartResponse, RecorderError> {
      if self.active.is_some() {
        return Err(RecorderError::AlreadyRecording);
      }
      let prepared = prepare_session(sessions_root, text_key.to_string(), "Sine generator".into())?;
      let (producer, consumer) = rtrb::RingBuffer::new(capture::ring_capacity(capture_rate));
      let dropped = Arc::new(AtomicU64::new(0));
      let written = Arc::new(AtomicU64::new(0));
      let fault = Arc::new(AtomicBool::new(false));
      let loss_notified = Arc::new(AtomicBool::new(false));
      let device_id = "sine-generator".to_string();
      let writer = writer::spawn_writer(
        consumer,
        dropped,
        prepared.wav_path.clone(),
        capture_rate,
        Arc::clone(&written),
        Arc::clone(&emit),
        Arc::clone(&fault),
        device_id.clone(),
        Arc::clone(&loss_notified),
      )?;
      let capture = capture::CapturePump::from_sine(producer, capture_rate);
      self.activate(
        prepared,
        capture,
        writer,
        written,
        device_id,
        fault,
        loss_notified,
        emit,
      )
    }

    fn start_prefilled(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      samples: &[f32],
      capacity: usize,
    ) -> Result<StartResponse, RecorderError> {
      self.start_prefilled_with(
        sessions_root,
        text_key,
        samples,
        capacity,
        Arc::new(events::NopEmit),
      )
    }

    fn start_prefilled_with(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      samples: &[f32],
      capacity: usize,
      emit: Arc<dyn RecorderEmit>,
    ) -> Result<StartResponse, RecorderError> {
      if self.active.is_some() {
        return Err(RecorderError::AlreadyRecording);
      }
      let prepared = prepare_session(sessions_root, text_key.to_string(), "Test input".into())?;
      let (mut producer, consumer) = rtrb::RingBuffer::new(capacity.max(1));
      let dropped = Arc::new(AtomicU64::new(0));
      capture::push_frames(samples, 1, None, &mut producer, &dropped, capture::f32_sample);
      drop(producer);
      let written = Arc::new(AtomicU64::new(0));
      let fault = Arc::new(AtomicBool::new(false));
      let loss_notified = Arc::new(AtomicBool::new(false));
      let device_id = "test-input".to_string();
      let writer = writer::spawn_writer(
        consumer,
        dropped,
        prepared.wav_path.clone(),
        OUTPUT_SAMPLE_RATE,
        Arc::clone(&written),
        Arc::clone(&emit),
        Arc::clone(&fault),
        device_id.clone(),
        Arc::clone(&loss_notified),
      )?;
      self.activate(
        prepared,
        capture::CapturePump::already_stopped(),
        writer,
        written,
        device_id,
        fault,
        loss_notified,
        emit,
      )
    }
  }

  #[derive(Default)]
  struct MemoryEmit {
    meters: Mutex<Vec<events::MeterEvent>>,
    peaks: Mutex<Vec<events::PeaksEvent>>,
    states: Mutex<Vec<StateNotice>>,
    errors: Mutex<Vec<ErrorEvent>>,
    lost: Mutex<Vec<events::DeviceLostEvent>>,
  }

  impl RecorderEmit for MemoryEmit {
    fn meter(&self, event: &events::MeterEvent) {
      self.meters.lock().unwrap().push(event.clone());
    }

    fn peaks(&self, event: &events::PeaksEvent) {
      self.peaks.lock().unwrap().push(event.clone());
    }

    fn state(&self, event: &StateNotice) {
      self.states.lock().unwrap().push(event.clone());
    }

    fn error(&self, event: &ErrorEvent) {
      self.errors.lock().unwrap().push(event.clone());
    }

    fn device_lost(&self, event: &events::DeviceLostEvent) {
      self.lost.lock().unwrap().push(event.clone());
    }

    fn devices_changed(&self, _event: &events::DevicesChangedEvent) {}
  }

  struct Scratch {
    path: PathBuf,
  }

  impl Scratch {
    fn path(&self) -> &Path {
      &self.path
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.path);
    }
  }

  fn scratch_dir() -> Scratch {
    let path = std::env::temp_dir().join(format!(
      "teleprompter-sessions-{}-{}",
      std::process::id(),
      uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&path).unwrap();
    Scratch { path }
  }

  fn session_dirs(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
      .unwrap()
      .filter_map(|entry| entry.ok())
      .map(|entry| entry.path())
      .filter(|path| path.is_dir())
      .collect()
  }
}
