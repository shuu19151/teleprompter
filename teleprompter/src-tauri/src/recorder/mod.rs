//! Native take recorder.
//!
//! `recorder_start` opens one input (the requested id, or the default when
//! that id is missing), pushes one channel or a down-mix through a lock-free
//! ring, and a writer thread stores 48 kHz PCM WAV segments. That thread also
//! emits meter and peak events. The capture callback never emits and never
//! blocks. Pause does not touch it.
//!
//! `recorder_pause` finishes the open segment and tells the writer to drop
//! every sample it pops. The ring keeps draining, so a pause cannot overflow
//! it. Meter and peak events stop for the pause. The partial level window at
//! the boundary is flushed into the segment that just closed, then nothing is
//! emitted until resume. `recorder_resume` opens the next segment. The first
//! file is `seg-000.wav`. Each resume adds `seg-001.wav`, `seg-002.wav`, and
//! so on. The writer also opens a new segment after 60 seconds of recorded
//! audio, finalizes the file it just closed, and rewrites `session.json`.
//! Duration counts written frames only, so the pause is not part of it. The
//! writer runs the voice chain (90 Hz highpass, compressor, makeup, limiter)
//! on each sample it keeps, after it has dropped leading zeros, and feeds that
//! PCM to the AAC encoder on the same thread. A lost device finalizes the open
//! segment, including while paused, and emits `recorder://device-lost`. Stop
//! muxes the access units already encoded, reuses the writer's peaks, and
//! deletes the session only after one light check of the final m4a. Crash
//! recovery still reads the WAV segments and encodes them, because a killed
//! process has no streamed frames.

mod capture;
mod device;
mod events;
mod levels;
mod m4a;
mod recovery;
mod session;
mod voice;
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
use events::{
  DevicesChangedEvent, ErrorEvent, RecorderEmit, StateEvent, StateNotice, notify_device_lost,
};

/// File sample rate. Device audio at another rate is resampled on the writer thread.
pub const OUTPUT_SAMPLE_RATE: u32 = 48_000;

const SESSIONS_DIR: &str = ".sessions";

use session::{SessionRecord, SessionStore, duration_ms, segment_frames, segment_name};

#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
  #[error("a recording is already in progress")]
  AlreadyRecording,
  #[error("no recording is in progress")]
  NotRecording,
  #[error("the recording is already paused")]
  AlreadyPaused,
  #[error("the recording is not paused")]
  NotPaused,
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
      Self::AlreadyPaused => "already_paused",
      Self::NotPaused => "not_paused",
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
  /// First segment. Empty only when the take produced no file.
  pub path: String,
  /// Every segment in record order. Pause does not add one; resume does.
  pub paths: Vec<String>,
  pub duration_ms: u64,
  pub bytes: u64,
  pub dropped_samples: u64,
  pub peaks: Vec<f32>,
  /// Saved take in Documents/Teleprompter. Empty when the take had no samples.
  pub take_path: String,
  pub take_name: String,
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
  /// Output frames kept in one segment. Production uses 60 seconds.
  segment_frames: u64,
}

impl RecorderInner {
  pub fn new() -> Self {
    Self {
      active: None,
      devices: Vec::new(),
      devices_ready: false,
      segment_frames: segment_frames(OUTPUT_SAMPLE_RATE),
    }
  }

  pub fn status(&self) -> StateEvent {
    match &self.active {
      None => StateEvent {
        state: RecorderPhase::Idle,
        duration_ms: 0,
        session_id: None,
      },
      Some(session) => session.state_event(),
    }
  }

  pub fn start_with_device(
    &mut self,
    sessions_root: &Path,
    text_key: String,
    code: String,
    title: String,
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
    let prepared = prepare_session(sessions_root, text_key, code, title, device_name)?;
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
      self.segment_frames,
      Some(Arc::clone(&prepared.store)),
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

  pub fn pause(&mut self) -> Result<StateEvent, RecorderError> {
    let session = self.active.as_mut().ok_or(RecorderError::NotRecording)?;
    session.pause()
  }

  pub fn resume(&mut self) -> Result<StateEvent, RecorderError> {
    let session = self.active.as_mut().ok_or(RecorderError::NotPaused)?;
    session.resume()
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
      store: prepared.store,
      paused: false,
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
  store: Arc<SessionStore>,
  paused: bool,
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

  fn pause(&mut self) -> Result<StateEvent, RecorderError> {
    if self.paused {
      return Err(RecorderError::AlreadyPaused);
    }
    self.writer.pause()?;
    self.paused = true;
    let event = self.state_event();
    self.emit.state(&StateNotice {
      state: event.state,
      duration_ms: event.duration_ms,
    });
    if let Err(error) = self.persist("paused") {
      self.emit.error(&ErrorEvent::from_recorder(&error));
      return Err(error);
    }
    Ok(event)
  }

  fn resume(&mut self) -> Result<StateEvent, RecorderError> {
    if !self.paused {
      return Err(RecorderError::NotPaused);
    }
    let name = segment_name(self.store.snapshot()?.segments.len() as u32);
    let path = self.directory.join(&name);
    self.writer.resume(path)?;
    self.paused = false;
    let event = self.state_event();
    self.emit.state(&StateNotice {
      state: event.state,
      duration_ms: event.duration_ms,
    });
    if let Err(error) = self.store.update(|record| {
      if !record.segments.iter().any(|existing| existing == &name) {
        record.segments.push(name);
      }
      record.state = "recording".into();
      record.last_written_ms = event.duration_ms;
    }) {
      self.emit.error(&ErrorEvent::from_recorder(&error));
      return Err(error);
    }
    Ok(event)
  }

  fn finish(mut self) -> Result<StopResponse, RecorderError> {
    self.capture.stop();
    let directory = self.directory.clone();
    let emit = Arc::clone(&self.emit);
    let done = match self.writer.finish() {
      Ok(done) => done,
      Err(error) => {
        emit.state(&StateNotice {
          state: RecorderPhase::Idle,
          duration_ms: 0,
        });
        return Err(error);
      }
    };
    let names = self
      .store
      .snapshot()
      .map(|record| record.segments)
      .unwrap_or_default();
    let paths: Vec<String> = names
      .iter()
      .map(|name| path_string(&directory.join(name)))
      .collect();
    // Leave the session marked recording until the m4a has been checked.
    // A failed encode stays on disk for the next launch to save or discard.
    let result = if done.frames == 0 {
      let _ = fs::remove_dir_all(&directory);
      Ok(StopResponse {
        path: paths.first().cloned().unwrap_or_default(),
        paths,
        duration_ms: 0,
        bytes: 0,
        dropped_samples: done.dropped_samples,
        peaks: done.peaks,
        take_path: String::new(),
        take_name: String::new(),
      })
    } else {
      match recovery::save_streamed(
        &directory,
        &recovery::takes_dir_for(&directory),
        &done.encoded,
        &done.peaks,
      ) {
        Ok(saved) => Ok(StopResponse {
          path: paths.first().cloned().unwrap_or_default(),
          paths,
          duration_ms: saved.duration_ms,
          bytes: saved.bytes,
          dropped_samples: done.dropped_samples,
          peaks: done.peaks,
          take_path: path_string(&saved.path),
          take_name: saved.name,
        }),
        Err(error) => {
          emit.error(&ErrorEvent::from_recorder(&error));
          Err(error)
        }
      }
    };
    let duration_ms = result
      .as_ref()
      .map(|stopped| stopped.duration_ms)
      .unwrap_or(0);
    emit.state(&StateNotice {
      state: RecorderPhase::Idle,
      duration_ms,
    });
    result
  }

  fn state_event(&self) -> StateEvent {
    StateEvent {
      state: if self.paused {
        RecorderPhase::Paused
      } else {
        RecorderPhase::Recording
      },
      duration_ms: duration_ms(self.written.load(Ordering::Relaxed)),
      session_id: Some(self.id.clone()),
    }
  }

  fn persist(&self, state: &str) -> Result<(), RecorderError> {
    let ms = duration_ms(self.written.load(Ordering::Relaxed));
    self.store.update(|record| {
      record.state = state.to_string();
      record.last_written_ms = ms;
    })
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
  store: Arc<SessionStore>,
}

impl PreparedSession {
  fn rollback(self) {
    let _ = fs::remove_dir_all(&self.directory);
  }
}

fn prepare_session(
  sessions_root: &Path,
  text_key: String,
  code: String,
  title: String,
  device_name: String,
) -> Result<PreparedSession, RecorderError> {
  let id = uuid::Uuid::new_v4().to_string();
  let directory = sessions_root.join(&id);
  fs::create_dir_all(&directory).map_err(|error| {
    RecorderError::Session(format!("could not create {}: {error}", directory.display()))
  })?;
  let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
  let segments = vec![segment_name(0)];
  let record = SessionRecord::new(
    started_at,
    text_key,
    code,
    title,
    device_name,
    segments.clone(),
  );
  let store = match SessionStore::create(directory.clone(), record) {
    Ok(store) => store,
    Err(error) => {
      let _ = fs::remove_dir_all(&directory);
      return Err(error);
    }
  };
  let wav_path = directory.join(&segments[0]);
  Ok(PreparedSession {
    id,
    wav_path,
    directory,
    store: Arc::new(store),
  })
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
/// `recorder://devices-changed`. While a take is open, including while it is
/// paused, a stream fault or a missing device finalizes the current segment
/// and emits `recorder://device-lost`.
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
  code: Option<String>,
  title: Option<String>,
) -> Result<StartResponse, RecorderError> {
  let root = sessions_root(&app)?;
  let emit = Arc::new(AppEmit(app));
  match lock(&state)?.start_with_device(
    &root,
    text_key,
    code.unwrap_or_default(),
    title.unwrap_or_default(),
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
pub fn recorder_pause(state: State<'_, RecorderState>) -> Result<StateEvent, RecorderError> {
  lock(&state)?.pause()
}

#[tauri::command(async)]
pub fn recorder_resume(state: State<'_, RecorderState>) -> Result<StateEvent, RecorderError> {
  lock(&state)?.resume()
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

#[tauri::command]
pub fn recorder_recover(
  app: AppHandle,
  state: State<'_, RecorderState>,
) -> Result<Vec<recovery::RecoveredSession>, RecorderError> {
  let active = lock(&state)?
    .active
    .as_ref()
    .map(|session| session.id.clone());
  let mut found = recovery::scan_unfinished(&sessions_root(&app)?)?;
  if let Some(id) = active {
    found.retain(|session| session.session_id != id);
  }
  Ok(found)
}

#[tauri::command(async)]
pub fn recorder_recover_apply(
  app: AppHandle,
  state: State<'_, RecorderState>,
  session_id: String,
  action: String,
) -> Result<(), RecorderError> {
  let active = lock(&state)?
    .active
    .as_ref()
    .map(|session| session.id.clone());
  if active.as_deref() == Some(session_id.as_str()) {
    return Err(RecorderError::Session(
      "that recording is still open".into(),
    ));
  }
  let root = app.path().document_dir().map_err(|error| {
    RecorderError::Session(format!("could not find the Documents folder: {error}"))
  })?;
  let takes = root.join("Teleprompter");
  recovery::apply(&takes.join(SESSIONS_DIR), &takes, &session_id, &action)
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
        RecorderError::AlreadyPaused,
        "already_paused",
        "the recording is already paused",
      ),
      (
        RecorderError::NotPaused,
        "not_paused",
        "the recording is not paused",
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
    assert_eq!(
      status.session_id.as_deref(),
      Some(started.session_id.as_str())
    );
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
      serde_json::from_slice(&fs::read(session_path.join(session::SESSION_FILE)).unwrap()).unwrap();
    assert_eq!(meta["textKey"], "E01");
    assert_eq!(meta["sampleRate"], OUTPUT_SAMPLE_RATE);
    assert_eq!(meta["deviceName"], "Test input");
    assert_eq!(meta["state"], "recording");
    assert_eq!(meta["segments"], serde_json::json!(["seg-000.wav"]));
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
    assert!(stopped.bytes > 32);
    assert_eq!(stopped.peaks.len(), 1);
    assert_eq!(stopped.paths, vec![path_string(
      &session_path.join(segment_name(0))
    )]);
    assert_eq!(stopped.path, stopped.paths[0]);
    assert_saved_take(&stopped, 4);
  }

  #[test]
  fn cancel_deletes_the_session_folder() {
    let dir = scratch_dir();
    let mut recorder = RecorderInner::new();
    let started = recorder
      .start_sine(dir.path(), "E01", OUTPUT_SAMPLE_RATE)
      .unwrap();
    let session_path = dir.path().join(&started.session_id);
    assert!(session_path.join(segment_name(0)).exists() || session_path.exists());
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
    assert!(
      stopped
        .peaks
        .iter()
        .all(|value| (0.0..=1.0).contains(value))
    );
    assert!(stopped.peaks.iter().any(|value| *value > 0.0));
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
    assert!(
      recorder
        .finalize_if_lost(&["test-input"])
        .unwrap()
        .is_none()
    );
    assert_eq!(recorder.status().state, RecorderPhase::Recording);

    recorder
      .active
      .as_ref()
      .unwrap()
      .fault
      .store(true, Ordering::Release);
    let stopped = recorder.finalize_if_lost(&["test-input"]).unwrap().unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert!(recorder.finalize_if_lost(&[] as &[&str]).unwrap().is_none());
    let lost = emit.lost.lock().unwrap();
    assert_eq!(lost.len(), 1);
    assert_eq!(lost[0].device_id, "test-input");
    drop(lost);

    assert_saved_take(&stopped, samples.len() as u64);
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
    assert_saved_take(&stopped, samples.len() as u64);
  }

  #[test]
  fn pause_and_resume_reject_the_wrong_state() {
    let mut recorder = RecorderInner::new();
    assert!(matches!(recorder.pause(), Err(RecorderError::NotRecording)));
    assert!(matches!(recorder.resume(), Err(RecorderError::NotPaused)));

    let dir = scratch_dir();
    recorder
      .start_prefilled(dir.path(), "E01", &[0.25, -0.5], 8)
      .unwrap();
    assert!(matches!(recorder.resume(), Err(RecorderError::NotPaused)));
    assert_eq!(recorder.status().state, RecorderPhase::Recording);

    recorder.pause().unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Paused);
    assert!(matches!(
      recorder.pause(),
      Err(RecorderError::AlreadyPaused)
    ));

    recorder.resume().unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Recording);
    assert!(matches!(recorder.resume(), Err(RecorderError::NotPaused)));

    let stopped = recorder.stop().unwrap();
    assert_eq!(stopped.paths.len(), 2);
    assert!(stopped.paths[0].ends_with("seg-000.wav"));
    assert!(stopped.paths[1].ends_with("seg-001.wav"));
    assert!(matches!(recorder.pause(), Err(RecorderError::NotRecording)));
    assert!(matches!(recorder.resume(), Err(RecorderError::NotPaused)));
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
  }

  #[test]
  fn pause_drops_samples_and_duration_skips_the_gap() {
    let dir = scratch_dir();
    let emit = Arc::new(MemoryEmit::default());
    let mut recorder = RecorderInner::new();
    let (started, mut producer) = recorder
      .start_fed(
        dir.path(),
        "E01",
        32_000,
        Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      )
      .unwrap();
    let session_path = dir.path().join(&started.session_id);
    let first = vec![0.5f32; 4_800];
    let skipped = vec![0.9f32; 2_400];
    let second = vec![-0.5f32; 4_800];
    push_all(&mut producer, &first);

    let paused = recorder.pause().unwrap();
    assert_eq!(paused.state, RecorderPhase::Paused);
    assert_eq!(paused.duration_ms, 100);
    assert_eq!(
      paused.session_id.as_deref(),
      Some(started.session_id.as_str())
    );
    assert_eq!(recorder.status().state, RecorderPhase::Paused);
    assert_eq!(recorder.status().duration_ms, 100);
    let during = read_session(&session_path);
    assert_eq!(during["state"], "paused");
    assert_eq!(during["segments"], serde_json::json!(["seg-000.wav"]));

    let meters_at_pause = emit.meters.lock().unwrap().len();
    let peaks_at_pause = emit.peaks.lock().unwrap().len();
    push_all(&mut producer, &skipped);
    let resumed = recorder.resume().unwrap();
    assert_eq!(resumed.state, RecorderPhase::Recording);
    assert_eq!(resumed.duration_ms, 100);
    assert_eq!(emit.meters.lock().unwrap().len(), meters_at_pause);
    assert_eq!(emit.peaks.lock().unwrap().len(), peaks_at_pause);
    let recording = read_session(&session_path);
    assert_eq!(recording["state"], "recording");
    assert_eq!(
      recording["segments"],
      serde_json::json!(["seg-000.wav", "seg-001.wav"])
    );

    push_all(&mut producer, &second);
    drop(producer);
    let stopped = recorder.stop().unwrap();
    assert_eq!(stopped.duration_ms, 200);
    assert_eq!(stopped.dropped_samples, 0);
    assert_eq!(stopped.paths.len(), 2);
    assert_eq!(stopped.path, stopped.paths[0]);
    assert!(stopped.paths[0].ends_with("seg-000.wav"));
    assert!(stopped.paths[1].ends_with("seg-001.wav"));
    assert!(stopped.bytes > 32);
    assert_saved_take(&stopped, 9_600);

    let states = emit.states.lock().unwrap();
    assert_eq!(
      states.iter().map(|state| state.state).collect::<Vec<_>>(),
      vec![
        RecorderPhase::Recording,
        RecorderPhase::Paused,
        RecorderPhase::Recording,
        RecorderPhase::Idle,
      ]
    );
    assert_eq!(states[1].duration_ms, 100);
    assert_eq!(states[2].duration_ms, 100);
    assert_eq!(states[3].duration_ms, 200);
  }

  #[test]
  fn recorded_audio_rotates_at_the_segment_boundary() {
    const SHORT_SEGMENT_FRAMES: u64 = 8;
    let dir = scratch_dir();
    let mut recorder = RecorderInner::new();
    recorder.segment_frames = SHORT_SEGMENT_FRAMES;
    let (started, mut producer) = recorder
      .start_fed(dir.path(), "E01", 64, Arc::new(events::NopEmit))
      .unwrap();
    let session_path = dir.path().join(&started.session_id);
    let samples: Vec<f32> = (0..20)
      .map(|index| if index % 2 == 0 { 0.4 } else { -0.3 })
      .collect();
    push_all(&mut producer, &samples[..SHORT_SEGMENT_FRAMES as usize]);
    wait_written(&recorder, SHORT_SEGMENT_FRAMES);

    let closed = session_path.join(segment_name(0));
    let reader = hound::WavReader::open(&closed).unwrap();
    assert_eq!(reader.duration(), SHORT_SEGMENT_FRAMES as u32);
    assert_eq!(reader.spec().sample_rate, OUTPUT_SAMPLE_RATE);
    let during = read_session(&session_path);
    assert_eq!(during["segments"], serde_json::json!(["seg-000.wav"]));
    assert_eq!(during["lastWrittenMs"], duration_ms(SHORT_SEGMENT_FRAMES));
    assert_eq!(during["state"], "recording");
    assert!(!session_path.join("session.json.tmp").exists());

    push_all(&mut producer, &samples[SHORT_SEGMENT_FRAMES as usize..]);
    drop(producer);
    let stopped = recorder.stop().unwrap();
    assert_eq!(stopped.paths.len(), 3);
    assert_eq!(stopped.duration_ms, duration_ms(samples.len() as u64));
    assert_saved_take(&stopped, samples.len() as u64);
    assert!(!session_path.join("session.json.tmp").exists());
  }

  #[test]
  fn device_loss_while_paused_finalizes_the_open_segment() {
    let dir = scratch_dir();
    let emit = Arc::new(MemoryEmit::default());
    let mut recorder = RecorderInner::new();
    let (_started, mut producer) = recorder
      .start_fed(
        dir.path(),
        "E01",
        64,
        Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      )
      .unwrap();
    let samples = [0.25f32, -0.5, 0.75, -0.25];
    push_all(&mut producer, &samples);
    recorder.pause().unwrap();
    drop(producer);

    let stopped = recorder
      .finalize_if_lost(&["other-device"])
      .unwrap()
      .unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert!(recorder.finalize_if_lost(&[] as &[&str]).unwrap().is_none());
    assert_eq!(emit.lost.lock().unwrap().len(), 1);
    assert_eq!(emit.lost.lock().unwrap()[0].device_id, "test-input");
    assert_eq!(stopped.paths.len(), 1);
    assert_eq!(stopped.duration_ms, duration_ms(samples.len() as u64));
    assert_saved_take(&stopped, samples.len() as u64);
  }

  #[test]
  fn stop_of_a_six_minute_take_does_not_reread_or_fully_decode() {
    const MINUTES: u64 = 6;
    let frames = MINUTES * 60 * u64::from(OUTPUT_SAMPLE_RATE);
    let dir = scratch_dir();
    let mut recorder = RecorderInner::new();
    let (started, mut producer) = recorder
      .start_fed(dir.path(), "E01", 32_768, Arc::new(events::NopEmit))
      .unwrap();
    let session_path = dir.path().join(&started.session_id);
    let step = std::f32::consts::TAU * 440.0 / OUTPUT_SAMPLE_RATE as f32;
    let mut sent = 0u64;
    while sent < frames {
      let count = ((frames - sent) as usize).min(4_096);
      for offset in 0..count {
        let sample = (step * (sent + offset as u64) as f32 + 0.4).sin() * 0.25;
        loop {
          match producer.push(sample) {
            Ok(()) => break,
            Err(_) => std::thread::sleep(std::time::Duration::from_micros(50)),
          }
        }
      }
      sent += count as u64;
    }
    drop(producer);
    wait_written_for(&recorder, frames, std::time::Duration::from_secs(30));
    let reads = super::recovery::pcm_reads();
    let decodes = super::m4a::full_decodes();
    let started_stop = std::time::Instant::now();
    let stopped = recorder.stop().unwrap();
    let elapsed = started_stop.elapsed();
    assert_eq!(
      super::recovery::pcm_reads(),
      reads,
      "stop re-read the WAV segments"
    );
    assert_eq!(
      super::m4a::full_decodes(),
      decodes,
      "stop decoded the whole m4a"
    );
    let limit = if cfg!(debug_assertions) {
      std::time::Duration::from_secs(2)
    } else {
      std::time::Duration::from_millis(500)
    };
    assert!(
      elapsed < limit,
      "stop of a {MINUTES}-minute take took {elapsed:?}, limit {limit:?}"
    );
    assert_saved_take(&stopped, frames);
    assert!(
      !session_path.exists(),
      "session was kept after the streamed m4a was saved"
    );
    eprintln!("six-minute stop took {elapsed:?}");
  }

  #[test]
  fn a_stream_fault_while_paused_still_leaves_a_readable_segment() {
    let dir = scratch_dir();
    let emit = Arc::new(MemoryEmit::default());
    let mut recorder = RecorderInner::new();
    let (_started, mut producer) = recorder
      .start_fed(
        dir.path(),
        "E01",
        32,
        Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      )
      .unwrap();
    let samples = [0.5f32, -0.25];
    push_all(&mut producer, &samples);
    recorder.pause().unwrap();
    recorder
      .active
      .as_ref()
      .unwrap()
      .fault
      .store(true, Ordering::Release);
    let stopped = recorder.finalize_if_lost(&["test-input"]).unwrap().unwrap();
    assert_eq!(recorder.status().state, RecorderPhase::Idle);
    assert_saved_take(&stopped, samples.len() as u64);
    assert_eq!(emit.lost.lock().unwrap().len(), 1);
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
      let prepared = prepare_session(
        sessions_root,
        text_key.to_string(),
        text_key.to_string(),
        String::new(),
        "Sine generator".into(),
      )?;
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
        self.segment_frames,
        Some(Arc::clone(&prepared.store)),
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
      let prepared = prepare_session(
        sessions_root,
        text_key.to_string(),
        text_key.to_string(),
        String::new(),
        "Test input".into(),
      )?;
      let (mut producer, consumer) = rtrb::RingBuffer::new(capacity.max(1));
      let dropped = Arc::new(AtomicU64::new(0));
      capture::push_frames(
        samples,
        1,
        None,
        &mut producer,
        &dropped,
        capture::f32_sample,
      );
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
        self.segment_frames,
        Some(Arc::clone(&prepared.store)),
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

    fn start_fed(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      capacity: usize,
      emit: Arc<dyn RecorderEmit>,
    ) -> Result<(StartResponse, rtrb::Producer<f32>), RecorderError> {
      if self.active.is_some() {
        return Err(RecorderError::AlreadyRecording);
      }
      let prepared = prepare_session(
        sessions_root,
        text_key.to_string(),
        text_key.to_string(),
        String::new(),
        "Test input".into(),
      )?;
      let (producer, consumer) = rtrb::RingBuffer::new(capacity.max(1));
      let dropped = Arc::new(AtomicU64::new(0));
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
        self.segment_frames,
        Some(Arc::clone(&prepared.store)),
      )?;
      let started = self.activate(
        prepared,
        capture::CapturePump::already_stopped(),
        writer,
        written,
        device_id,
        fault,
        loss_notified,
        emit,
      )?;
      Ok((started, producer))
    }
  }

  fn wait_written(recorder: &RecorderInner, frames: u64) {
    wait_written_for(recorder, frames, std::time::Duration::from_secs(2));
  }

  fn wait_written_for(recorder: &RecorderInner, frames: u64, limit: std::time::Duration) {
    let started = std::time::Instant::now();
    loop {
      let written = recorder
        .active
        .as_ref()
        .map(|session| session.written.load(Ordering::Relaxed))
        .unwrap_or(0);
      if written >= frames {
        return;
      }
      if started.elapsed() > limit {
        panic!("writer did not reach {frames} frames (saw {written})");
      }
      std::thread::sleep(std::time::Duration::from_millis(5));
    }
  }

  fn push_all(producer: &mut rtrb::Producer<f32>, samples: &[f32]) {
    for sample in samples {
      producer
        .push(*sample)
        .expect("the test ring holds the fixture");
    }
  }

  fn read_session(directory: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(directory.join(session::SESSION_FILE)).unwrap()).unwrap()
  }

  fn assert_saved_take(stopped: &StopResponse, frames: u64) {
    assert!(stopped.take_name.ends_with(".m4a"), "{}", stopped.take_name);
    assert!(!stopped.take_path.is_empty());
    assert_eq!(stopped.duration_ms, duration_ms(frames));
    if let Some(segment) = stopped.paths.first() {
      assert!(
        !Path::new(segment).exists(),
        "session was kept after the m4a was saved: {segment}"
      );
    }
    let bytes = fs::read(&stopped.take_path).unwrap();
    super::m4a::verify_m4a(&bytes, frames).unwrap();
    let sidecar = Path::new(&stopped.take_path).with_extension("json");
    let meta: serde_json::Value = serde_json::from_slice(&fs::read(sidecar).unwrap()).unwrap();
    assert_eq!(meta["mime"], "audio/mp4");
    assert_eq!(meta["version"], 1);
    assert_eq!(meta["durationMs"], duration_ms(frames));
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
