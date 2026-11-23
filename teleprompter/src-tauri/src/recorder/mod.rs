//! Native take recorder.
//!
//! `recorder_start` opens the default input, pushes mono samples through a
//! lock-free ring, and a writer thread stores a 48 kHz PCM WAV. The page does
//! not call these commands yet.

mod capture;
mod device;
mod events;
mod wav;
mod writer;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

pub use events::RecorderPhase;

use events::StateEvent;

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
}

impl RecorderInner {
  pub fn new() -> Self {
    Self { active: None }
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
  ) -> Result<StartResponse, RecorderError> {
    if self.active.is_some() {
      return Err(RecorderError::AlreadyRecording);
    }
    let opened = device::open_default()?;
    let device_name = opened.device_name.clone();
    let capture_rate = opened.capture_rate;
    let prepared = prepare_session(sessions_root, text_key, device_name)?;
    let (producer, consumer) = rtrb::RingBuffer::new(capture::ring_capacity(capture_rate));
    let dropped = Arc::new(AtomicU64::new(0));
    let written = Arc::new(AtomicU64::new(0));
    let writer = match writer::spawn_writer(
      consumer,
      Arc::clone(&dropped),
      prepared.wav_path.clone(),
      capture_rate,
      Arc::clone(&written),
    ) {
      Ok(writer) => writer,
      Err(error) => {
        prepared.rollback();
        return Err(error);
      }
    };
    let stream = match capture::start_input(opened, producer, dropped) {
      Ok(stream) => stream,
      Err(error) => {
        drop(writer);
        prepared.rollback();
        return Err(error);
      }
    };
    self.activate(prepared, capture::CapturePump::from_stream(stream), writer, written)
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
    });
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
}

impl ActiveSession {
  fn finish(mut self) -> Result<StopResponse, RecorderError> {
    self.capture.stop();
    let done = self.writer.finish()?;
    write_session(
      &self.directory,
      &self.started_at,
      &self.text_key,
      &self.device_name,
      "stopped",
    )?;
    Ok(StopResponse {
      path: path_string(&self.wav_path),
      duration_ms: duration_ms(done.frames),
      bytes: done.bytes,
      dropped_samples: done.dropped_samples,
    })
  }

  fn discard(mut self) -> Result<(), RecorderError> {
    self.capture.stop();
    let _ = self.writer.finish();
    fs::remove_dir_all(&self.directory).map_err(|error| {
      RecorderError::Session(format!(
        "could not delete {}: {error}",
        self.directory.display()
      ))
    })
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

#[tauri::command(async)]
pub fn recorder_start(
  app: AppHandle,
  state: State<'_, RecorderState>,
  text_key: String,
) -> Result<StartResponse, RecorderError> {
  let root = sessions_root(&app)?;
  lock(&state)?.start_with_device(&root, text_key)
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

  impl RecorderInner {
    fn start_sine(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      capture_rate: u32,
    ) -> Result<StartResponse, RecorderError> {
      if self.active.is_some() {
        return Err(RecorderError::AlreadyRecording);
      }
      let prepared = prepare_session(sessions_root, text_key.to_string(), "Sine generator".into())?;
      let (producer, consumer) = rtrb::RingBuffer::new(capture::ring_capacity(capture_rate));
      let dropped = Arc::new(AtomicU64::new(0));
      let written = Arc::new(AtomicU64::new(0));
      let writer = writer::spawn_writer(
        consumer,
        dropped,
        prepared.wav_path.clone(),
        capture_rate,
        Arc::clone(&written),
      )?;
      let capture = capture::CapturePump::from_sine(producer, capture_rate);
      self.activate(prepared, capture, writer, written)
    }

    fn start_prefilled(
      &mut self,
      sessions_root: &Path,
      text_key: &str,
      samples: &[f32],
      capacity: usize,
    ) -> Result<StartResponse, RecorderError> {
      if self.active.is_some() {
        return Err(RecorderError::AlreadyRecording);
      }
      let prepared = prepare_session(sessions_root, text_key.to_string(), "Test input".into())?;
      let (mut producer, consumer) = rtrb::RingBuffer::new(capacity.max(1));
      let dropped = Arc::new(AtomicU64::new(0));
      capture::push_frames(samples, 1, &mut producer, &dropped, capture::f32_sample);
      drop(producer);
      let written = Arc::new(AtomicU64::new(0));
      let writer = writer::spawn_writer(
        consumer,
        dropped,
        prepared.wav_path.clone(),
        OUTPUT_SAMPLE_RATE,
        Arc::clone(&written),
      )?;
      self.activate(
        prepared,
        capture::CapturePump::already_stopped(),
        writer,
        written,
      )
    }
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
