//! Session folder metadata.
//!
//! `session.json` is the list of segments and the recorded length. It is
//! rewritten by writing a temp file and renaming it, so a crash keeps the
//! previous complete file. `lastWrittenMs` is the heartbeat: the recorded
//! length in milliseconds at the last rotation, checkpoint, or state change.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{RecorderError, OUTPUT_SAMPLE_RATE};

/// Recorded audio in one segment before the writer opens the next file.
pub const SEGMENT_DURATION: Duration = Duration::from_secs(60);

pub const SESSION_FILE: &str = "session.json";
const SESSION_TMP: &str = "session.json.tmp";

/// Frames of recorded audio in one segment at `sample_rate`.
pub fn segment_frames(sample_rate: u32) -> u64 {
  u64::from(sample_rate.max(1)).saturating_mul(SEGMENT_DURATION.as_secs())
}

/// `seg-000.wav`, then `seg-001.wav`. The width is a minimum.
pub fn segment_name(index: u32) -> String {
  format!("seg-{index:03}.wav")
}

pub fn duration_ms(frames: u64) -> u64 {
  frames.saturating_mul(1_000) / u64::from(OUTPUT_SAMPLE_RATE.max(1))
}

pub fn is_segment_name(name: &str) -> bool {
  let Some(stem) = name.strip_prefix("seg-") else {
    return false;
  };
  let Some(index) = stem.strip_suffix(".wav") else {
    return false;
  };
  !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
}

/// A clean stop writes `stopped`. Recovery treats that, and `finished`, as done.
pub fn is_finished_state(state: &str) -> bool {
  state == "stopped" || state == "finished"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
  pub started_at: String,
  pub text_key: String,
  #[serde(default)]
  pub code: String,
  #[serde(default)]
  pub title: String,
  pub sample_rate: u32,
  pub device_name: String,
  pub state: String,
  pub segments: Vec<String>,
  /// Recorded length at the last heartbeat, rotation, or state change.
  #[serde(default)]
  pub last_written_ms: u64,
}

impl SessionRecord {
  pub fn new(
    started_at: String,
    text_key: String,
    code: String,
    title: String,
    device_name: String,
    segments: Vec<String>,
  ) -> Self {
    Self {
      started_at,
      text_key,
      code,
      title,
      sample_rate: OUTPUT_SAMPLE_RATE,
      device_name,
      state: "recording".into(),
      segments,
      last_written_ms: 0,
    }
  }
}

/// Shared session file. The writer thread and the command thread both update it.
#[derive(Clone)]
pub struct SessionStore {
  directory: PathBuf,
  inner: Arc<Mutex<SessionRecord>>,
}

impl SessionStore {
  pub fn create(directory: PathBuf, record: SessionRecord) -> Result<Self, RecorderError> {
    let store = Self {
      directory,
      inner: Arc::new(Mutex::new(record)),
    };
    {
      let guard = store.lock()?;
      store.persist_locked(&guard)?;
    }
    Ok(store)
  }

  pub fn snapshot(&self) -> Result<SessionRecord, RecorderError> {
    Ok(self.lock()?.clone())
  }

  pub fn update(&self, change: impl FnOnce(&mut SessionRecord)) -> Result<(), RecorderError> {
    let mut guard = self.lock()?;
    change(&mut guard);
    self.persist_locked(&guard)
  }

  fn lock(&self) -> Result<std::sync::MutexGuard<'_, SessionRecord>, RecorderError> {
    self
      .inner
      .lock()
      .map_err(|_| RecorderError::Session("the session lock was poisoned".into()))
  }

  fn persist_locked(&self, record: &SessionRecord) -> Result<(), RecorderError> {
    write_session_atomic(&self.directory, record)
  }
}

pub fn write_session_atomic(directory: &Path, record: &SessionRecord) -> Result<(), RecorderError> {
  let bytes = serde_json::to_vec_pretty(record)
    .map_err(|error| RecorderError::Session(error.to_string()))?;
  let target = directory.join(SESSION_FILE);
  let tmp = directory.join(SESSION_TMP);
  {
    let mut file = File::create(&tmp).map_err(|error| {
      RecorderError::Session(format!("could not write {SESSION_TMP}: {error}"))
    })?;
    file.write_all(&bytes).map_err(|error| {
      RecorderError::Session(format!("could not write {SESSION_TMP}: {error}"))
    })?;
    file.sync_all().map_err(|error| {
      RecorderError::Session(format!("could not flush {SESSION_TMP}: {error}"))
    })?;
  }
  replace_file(&tmp, &target).map_err(|error| {
    RecorderError::Session(format!("could not replace {SESSION_FILE}: {error}"))
  })?;
  Ok(())
}

/// Rename `from` onto `to`. Windows will not replace an existing file, so the
/// previous file is removed first. A crash in that gap leaves the temp file,
/// which recovery reads when `session.json` is missing.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
  match fs::rename(from, to) {
    Ok(()) => Ok(()),
    Err(_error) if to.exists() => {
      fs::remove_file(to)?;
      match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(rename_error) => Err(rename_error),
      }
    }
    Err(error) => Err(error),
  }
}

pub fn read_session_file(directory: &Path) -> Result<SessionRecord, RecorderError> {
  let main = directory.join(SESSION_FILE);
  if let Some(record) = read_record_file(&main)? {
    return Ok(record);
  }
  let tmp = directory.join(SESSION_TMP);
  if let Some(record) = read_record_file(&tmp)? {
    return Ok(record);
  }
  Err(RecorderError::Session(format!(
    "could not read {SESSION_FILE} in {}",
    directory.display()
  )))
}

fn read_record_file(path: &Path) -> Result<Option<SessionRecord>, RecorderError> {
  match fs::read(path) {
    Ok(bytes) => serde_json::from_slice(&bytes)
      .map(Some)
      .map_err(|error| RecorderError::Session(format!("could not read {}: {error}", path.display()))),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(RecorderError::Session(format!(
      "could not read {}: {error}",
      path.display()
    ))),
  }
}

/// Segment names from the record, plus any `seg-NNN.wav` the last crash wrote
/// before `session.json` learned about it. Names stay in record order, and a
/// file that is only on disk is appended in numeric order.
pub fn segment_list(directory: &Path, record: &SessionRecord) -> Vec<String> {
  let mut names = record.segments.clone();
  let mut extras = Vec::new();
  if let Ok(entries) = fs::read_dir(directory) {
    for entry in entries.flatten() {
      let Some(name) = entry.file_name().to_str().map(str::to_string) else {
        continue;
      };
      if is_segment_name(&name) && !names.iter().any(|existing| existing == &name) {
        extras.push(name);
      }
    }
  }
  extras.sort();
  names.extend(extras);
  names
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn segment_frames_follow_the_sixty_second_constant() {
    assert_eq!(SEGMENT_DURATION, Duration::from_secs(60));
    assert_eq!(segment_frames(48_000), 2_880_000);
    assert_eq!(segment_frames(0), 60);
  }

  #[test]
  fn atomic_replace_leaves_no_temp_file() {
    let dir = std::env::temp_dir().join(format!(
      "teleprompter-session-{}-{}",
      std::process::id(),
      unique()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = SessionRecord::new(
      "2026-11-23T00:00:00.000Z".into(),
      "E01".into(),
      "E01".into(),
      "Hello".into(),
      "Mic".into(),
      vec![segment_name(0)],
    );
    write_session_atomic(&dir, &record).unwrap();
    write_session_atomic(&dir, &record).unwrap();
    assert!(!dir.join(SESSION_TMP).exists());
    let read = read_session_file(&dir).unwrap();
    assert_eq!(read, record);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_missing_session_file_falls_back_to_the_temp_file() {
    let dir = std::env::temp_dir().join(format!(
      "teleprompter-session-tmp-{}-{}",
      std::process::id(),
      unique()
    ));
    fs::create_dir_all(&dir).unwrap();
    let record = SessionRecord::new(
      "2026-11-23T00:00:00.000Z".into(),
      "E01".into(),
      String::new(),
      String::new(),
      "Mic".into(),
      vec![segment_name(0)],
    );
    fs::write(
      dir.join(SESSION_TMP),
      serde_json::to_vec_pretty(&record).unwrap(),
    )
    .unwrap();
    let read = read_session_file(&dir).unwrap();
    assert_eq!(read.text_key, "E01");
    assert_eq!(read.segments, vec![segment_name(0)]);
    let _ = fs::remove_dir_all(&dir);
  }

  fn unique() -> u64 {
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos() as u64
  }
}
