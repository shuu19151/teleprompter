//! Takes stored in Documents/Teleprompter.
//!
//! Each take is an audio file plus a `<name>.json` sidecar. The folder is the
//! list: hidden entries such as `.sessions/` are skipped, a missing sidecar
//! falls back to the file name and a duration probe, and a debounced watcher
//! emits `takes://changed`.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Local, NaiveDate, TimeZone};
use notify::Watcher;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// How long the folder must stay quiet before `takes://changed` is emitted.
pub const TAKES_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

const AUDIO_EXTENSIONS: &[&str] = &["m4a", "mp4", "aac", "wav", "webm", "mp3"];
const PROBE_WINDOW: u64 = 1_048_576;
const PROBE_WHOLE_FILE: u64 = 8_000_000;
const MAX_PEAKS: usize = 2000;

#[derive(Debug, thiserror::Error)]
pub enum TakesError {
  #[error("could not read takes: {0}")]
  Io(String),
  #[error("that take was not found")]
  NotFound,
  #[error("that take name is not allowed")]
  BadName,
}

impl Serialize for TakesError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    serializer.serialize_str(&self.to_string())
  }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedTake {
  pub name: String,
  pub path: String,
  pub text_key: String,
  pub duration_ms: u64,
  pub created_at: i64,
  pub peaks: Vec<f32>,
  pub mime: String,
  pub bytes: u64,
  pub sidecar: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
  #[serde(default)]
  text_key: String,
  #[serde(default)]
  duration_ms: u64,
  #[serde(default)]
  created_at: i64,
  #[serde(default)]
  peaks: Vec<f32>,
  #[serde(default)]
  mime: String,
}

struct NameFallback {
  text_key: String,
  created_at: Option<i64>,
}

#[derive(Clone, Serialize)]
struct TakesChanged {}

/// Collapse a burst of folder events into one notification.
#[derive(Debug)]
pub struct ChangeDebounce {
  wait: Duration,
  last: Option<Instant>,
}

impl ChangeDebounce {
  pub fn new(wait: Duration) -> Self {
    Self { wait, last: None }
  }

  /// Remember that the folder changed at `now`. A later note restarts the wait.
  pub fn note(&mut self, now: Instant) {
    self.last = Some(now);
  }

  /// True once, after the folder has been quiet for the wait.
  pub fn poll(&mut self, now: Instant) -> bool {
    let Some(last) = self.last else {
      return false;
    };
    if now.saturating_duration_since(last) >= self.wait {
      self.last = None;
      true
    } else {
      false
    }
  }
}

/// True when a watch event might be a take file. Empty paths are a rescan.
/// A path inside a hidden directory, such as `.sessions`, is ignored.
pub fn event_touches_take(paths: &[PathBuf]) -> bool {
  if paths.is_empty() {
    return true;
  }
  paths.iter().any(|path| !path_is_hidden(path))
}

fn path_is_hidden(path: &Path) -> bool {
  path.components().any(|component| match component {
    std::path::Component::Normal(part) => part.to_string_lossy().starts_with('.'),
    _ => false,
  })
}

pub fn scan_takes(dir: &Path) -> Result<Vec<ListedTake>, TakesError> {
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let mut takes = Vec::new();
  let entries = fs::read_dir(dir).map_err(|error| TakesError::Io(error.to_string()))?;
  for entry in entries {
    let entry = entry.map_err(|error| TakesError::Io(error.to_string()))?;
    let Some(name) = entry.file_name().to_str().map(str::to_string) else {
      continue;
    };
    if name.starts_with('.') {
      continue;
    }
    let file_type = entry
      .file_type()
      .map_err(|error| TakesError::Io(error.to_string()))?;
    if !file_type.is_file() {
      continue;
    }
    let Some(ext) = audio_extension(&name) else {
      continue;
    };
    let path = entry.path();
    let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
    let modified = entry
      .metadata()
      .ok()
      .and_then(|meta| meta.modified().ok())
      .map(system_time_ms)
      .unwrap_or(0);
    let parsed = read_sidecar(&dir.join(sidecar_name(&name)));
    // A corrupt sidecar is treated as missing so a later pass can write it again.
    let sidecar = parsed.is_some();
    let fallback = fallback_from_name(&name);
    let text_key = match parsed.as_ref() {
      Some(side) if !side.text_key.is_empty() => side.text_key.clone(),
      _ => fallback.text_key,
    };
    let duration_ms = parsed
      .as_ref()
      .map(|side| side.duration_ms)
      .filter(|value| *value > 0)
      .or_else(|| probe_audio_duration_ms(&path, &ext))
      .unwrap_or(0);
    let created_at = parsed
      .as_ref()
      .map(|side| side.created_at)
      .filter(|value| *value > 0)
      .or(fallback.created_at)
      .filter(|value| *value > 0)
      .unwrap_or(modified);
    let mime = parsed
      .as_ref()
      .map(|side| side.mime.clone())
      .filter(|value| !value.is_empty())
      .unwrap_or_else(|| mime_for_extension(&ext));
    let peaks = parsed
      .map(|side| clean_peaks(side.peaks))
      .unwrap_or_default();
    takes.push(ListedTake {
      name,
      path: path.to_string_lossy().into_owned(),
      text_key,
      duration_ms,
      created_at,
      peaks,
      mime,
      bytes,
      sidecar,
    });
  }
  takes.sort_by(|left, right| left.name.cmp(&right.name));
  Ok(takes)
}

pub fn delete_take(dir: &Path, name: &str) -> Result<(), TakesError> {
  let audio = safe_audio_path(dir, name)?;
  let sidecar = dir.join(sidecar_name(name));
  remove_file_if_present(&audio)?;
  remove_file_if_present(&sidecar)?;
  Ok(())
}

pub fn read_take(dir: &Path, name: &str) -> Result<Vec<u8>, TakesError> {
  let audio = safe_audio_path(dir, name)?;
  let canon_dir = dir
    .canonicalize()
    .map_err(|error| TakesError::Io(error.to_string()))?;
  let canon = match audio.canonicalize() {
    Ok(path) => path,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(TakesError::NotFound),
    Err(error) => return Err(TakesError::Io(error.to_string())),
  };
  let parent = canon.parent().ok_or(TakesError::BadName)?;
  if !paths_equal(parent, &canon_dir) || !canon.is_file() {
    return Err(TakesError::BadName);
  }
  fs::read(&canon).map_err(|error| TakesError::Io(error.to_string()))
}

fn safe_audio_path(dir: &Path, name: &str) -> Result<PathBuf, TakesError> {
  validate_audio_name(name)?;
  let path = dir.join(name);
  if path.parent() != Some(dir) {
    return Err(TakesError::BadName);
  }
  Ok(path)
}

fn validate_audio_name(name: &str) -> Result<(), TakesError> {
  if name.is_empty() || name.len() > 180 {
    return Err(TakesError::BadName);
  }
  if name.contains('/') || name.contains('\\') || name.contains('\0') || name.starts_with('.') {
    return Err(TakesError::BadName);
  }
  if Path::new(name).components().count() != 1 {
    return Err(TakesError::BadName);
  }
  if audio_extension(name).is_none() {
    return Err(TakesError::BadName);
  }
  Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), TakesError> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(TakesError::Io(error.to_string())),
  }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
  if left == right {
    return true;
  }
  cfg!(windows) && left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

fn sidecar_name(audio: &str) -> String {
  match audio.rsplit_once('.') {
    Some((stem, _)) if !stem.is_empty() => format!("{stem}.json"),
    _ => format!("{audio}.json"),
  }
}

fn audio_extension(name: &str) -> Option<String> {
  let (_, ext) = name.rsplit_once('.')?;
  let ext = ext.to_ascii_lowercase();
  if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
    Some(ext)
  } else {
    None
  }
}

fn mime_for_extension(ext: &str) -> String {
  match ext {
    "m4a" | "mp4" | "aac" => "audio/mp4",
    "webm" => "audio/webm",
    "wav" => "audio/wav",
    "mp3" => "audio/mpeg",
    _ => "application/octet-stream",
  }
  .to_string()
}

fn read_sidecar(path: &Path) -> Option<Sidecar> {
  let bytes = fs::read(path).ok()?;
  serde_json::from_slice(&bytes).ok()
}

fn clean_peaks(peaks: Vec<f32>) -> Vec<f32> {
  peaks
    .into_iter()
    .take(MAX_PEAKS)
    .map(|value| {
      if value.is_finite() {
        value.abs().clamp(0.0, 1.0)
      } else {
        0.0
      }
    })
    .collect()
}

fn fallback_from_name(name: &str) -> NameFallback {
  let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
  match parse_stem(stem) {
    Some((text_key, created_at)) => NameFallback {
      text_key,
      created_at: Some(created_at),
    },
    None => NameFallback {
      text_key: String::new(),
      created_at: None,
    },
  }
}

/// `{code}-{slug}-{YYYYMMDD}-{HHMM}` with an optional `-{n}` clash suffix.
fn parse_stem(stem: &str) -> Option<(String, i64)> {
  if let Some(parsed) = parse_stamped(stem) {
    return Some(parsed);
  }
  let (head, last) = stem.rsplit_once('-')?;
  if last.is_empty() || last.len() > 4 || !last.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  parse_stamped(head)
}

fn parse_stamped(stem: &str) -> Option<(String, i64)> {
  let (head, hm) = stem.rsplit_once('-')?;
  if hm.len() != 4 || !hm.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  let (prefix, date) = head.rsplit_once('-')?;
  if prefix.is_empty() || date.len() != 8 || !date.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  let text_key = prefix.split('-').next().unwrap_or(prefix);
  if text_key.is_empty() {
    return None;
  }
  let created_at = created_at_from_stamp(date, hm)?;
  Some((text_key.to_string(), created_at))
}

fn created_at_from_stamp(date: &str, hm: &str) -> Option<i64> {
  let year: i32 = date.get(0..4)?.parse().ok()?;
  let month: u32 = date.get(4..6)?.parse().ok()?;
  let day: u32 = date.get(6..8)?.parse().ok()?;
  let hour: u32 = hm.get(0..2)?.parse().ok()?;
  let minute: u32 = hm.get(2..4)?.parse().ok()?;
  let naive = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, 0)?;
  let local = match Local.from_local_datetime(&naive) {
    chrono::LocalResult::Single(value) => value,
    chrono::LocalResult::Ambiguous(earliest, _) => earliest,
    chrono::LocalResult::None => return None,
  };
  Some(local.timestamp_millis())
}

fn system_time_ms(time: SystemTime) -> i64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as i64)
    .unwrap_or(0)
}

fn probe_audio_duration_ms(path: &Path, ext: &str) -> Option<u64> {
  match ext {
    "wav" => probe_wav_duration_ms(path),
    "m4a" | "mp4" | "aac" => probe_mp4_file(path),
    _ => None,
  }
}

fn probe_wav_duration_ms(path: &Path) -> Option<u64> {
  let reader = hound::WavReader::open(path).ok()?;
  let rate = reader.spec().sample_rate;
  if rate == 0 {
    return None;
  }
  Some(u64::from(reader.duration()).saturating_mul(1000) / u64::from(rate))
}

fn probe_mp4_file(path: &Path) -> Option<u64> {
  let file = File::open(path).ok()?;
  let len = file.metadata().ok()?.len();
  if len == 0 {
    return None;
  }
  if len <= PROBE_WHOLE_FILE {
    return probe_mp4_duration_ms(&fs::read(path).ok()?);
  }
  let mut reader = std::io::BufReader::new(file);
  let head_len = PROBE_WINDOW.min(len) as usize;
  let mut head = vec![0u8; head_len];
  reader.read_exact(&mut head).ok()?;
  if let Some(duration) = probe_mp4_duration_ms(&head) {
    return Some(duration);
  }
  let tail_len = PROBE_WINDOW.min(len) as usize;
  let mut tail = vec![0u8; tail_len];
  reader.seek(SeekFrom::Start(len - tail_len as u64)).ok()?;
  reader.read_exact(&mut tail).ok()?;
  probe_mp4_duration_ms(&tail)
}

fn probe_mp4_duration_ms(data: &[u8]) -> Option<u64> {
  walk_boxes(data)
}

fn walk_boxes(data: &[u8]) -> Option<u64> {
  let mut offset = 0usize;
  while offset + 8 <= data.len() {
    let mut size = u32::from_be_bytes(data[offset..offset + 4].try_into().ok()?) as u64;
    let kind = &data[offset + 4..offset + 8];
    let mut header = 8u64;
    if size == 1 {
      if offset + 16 > data.len() {
        return None;
      }
      size = u64::from_be_bytes(data[offset + 8..offset + 16].try_into().ok()?);
      header = 16;
    } else if size == 0 {
      size = (data.len() - offset) as u64;
    }
    if size < header || offset as u64 + size > data.len() as u64 {
      break;
    }
    let start = offset + header as usize;
    let end = offset + size as usize;
    let body = &data[start..end];
    if kind == b"mvhd" {
      if let Some(duration) = mvhd_duration_ms(body) {
        return Some(duration);
      }
    } else if is_container(kind) {
      if let Some(duration) = walk_boxes(body) {
        return Some(duration);
      }
    }
    offset = end;
  }
  None
}

fn is_container(kind: &[u8]) -> bool {
  matches!(
    kind,
    b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"edts"
  )
}

fn mvhd_duration_ms(body: &[u8]) -> Option<u64> {
  let version = *body.first()?;
  let (timescale, duration) = if version == 0 {
    if body.len() < 20 {
      return None;
    }
    let timescale = u32::from_be_bytes(body[12..16].try_into().ok()?);
    let duration = u64::from(u32::from_be_bytes(body[16..20].try_into().ok()?));
    (timescale, duration)
  } else if version == 1 {
    if body.len() < 32 {
      return None;
    }
    let timescale = u32::from_be_bytes(body[20..24].try_into().ok()?);
    let duration = u64::from_be_bytes(body[24..32].try_into().ok()?);
    (timescale, duration)
  } else {
    return None;
  };
  if timescale == 0 {
    return None;
  }
  Some(duration.saturating_mul(1000) / u64::from(timescale))
}

fn takes_dir(app: &AppHandle) -> Result<PathBuf, TakesError> {
  let documents = crate::recording_root(app).map_err(|error| {
    TakesError::Io(format!("could not find the Documents folder: {error}"))
  })?;
  Ok(documents.join("Teleprompter"))
}

pub fn spawn_takes_watch(app: AppHandle) {
  let built = std::thread::Builder::new()
    .name("teleprompter-takes".into())
    .spawn(move || {
      if let Err(error) = watch_takes(app) {
        log::warn!("could not watch takes: {error}");
      }
    });
  if let Err(error) = built {
    log::warn!("could not start the takes watcher: {error}");
  }
}

fn watch_takes(app: AppHandle) -> Result<(), String> {
  let dir = takes_dir(&app).map_err(|error| error.to_string())?;
  fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
  let (tx, rx) = std::sync::mpsc::channel();
  let mut watcher = notify::recommended_watcher(move |result| {
    let _ = tx.send(result);
  })
  .map_err(|error| error.to_string())?;
  watcher
    .watch(&dir, notify::RecursiveMode::NonRecursive)
    .map_err(|error| error.to_string())?;
  let mut debounce = ChangeDebounce::new(TAKES_WATCH_DEBOUNCE);
  loop {
    match rx.recv_timeout(Duration::from_millis(50)) {
      Ok(Ok(event)) => {
        if event_touches_take(&event.paths) {
          debounce.note(Instant::now());
        }
      }
      Ok(Err(_)) => debounce.note(Instant::now()),
      Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
    }
    if debounce.poll(Instant::now()) {
      let _ = app.emit("takes://changed", TakesChanged {});
    }
  }
  Ok(())
}

#[tauri::command(async)]
pub fn takes_list(app: AppHandle) -> Result<Vec<ListedTake>, TakesError> {
  scan_takes(&takes_dir(&app)?)
}

#[tauri::command(async)]
pub fn takes_delete(app: AppHandle, name: String) -> Result<(), TakesError> {
  delete_take(&takes_dir(&app)?, &name)
}

#[tauri::command(async)]
pub fn takes_read(app: AppHandle, name: String) -> Result<tauri::ipc::Response, TakesError> {
  let bytes = read_take(&takes_dir(&app)?, &name)?;
  Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU64, Ordering};

  fn temp_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
      "teleprompter-takes-{}-{}",
      std::process::id(),
      NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    path
  }

  struct TempDir(PathBuf);

  impl TempDir {
    fn new() -> Self {
      Self(temp_dir())
    }

    fn path(&self) -> &Path {
      &self.0
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn local_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    match Local.with_ymd_and_hms(year, month, day, hour, minute, 0) {
      chrono::LocalResult::Single(value) => value.timestamp_millis(),
      chrono::LocalResult::Ambiguous(earliest, _) => earliest.timestamp_millis(),
      chrono::LocalResult::None => panic!("local time is missing"),
    }
  }

  fn write_wav(path: &Path, frames: u32, rate: u32) {
    let spec = hound::WavSpec {
      channels: 1,
      sample_rate: rate,
      bits_per_sample: 16,
      sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for _ in 0..frames {
      writer.write_sample(0i16).unwrap();
    }
    writer.finalize().unwrap();
  }

  fn box_of(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let size = (8 + body.len()) as u32;
    let mut out = Vec::new();
    out.extend(size.to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
  }

  fn mvhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut body = vec![0u8; 20];
    body[12..16].copy_from_slice(&timescale.to_be_bytes());
    body[16..20].copy_from_slice(&duration.to_be_bytes());
    box_of(b"mvhd", &body)
  }

  #[test]
  fn scan_reads_sidecars_and_skips_hidden_folders() {
    let dir = TempDir::new();
    let audio = "E01-how-i-stay-20261122-1804.m4a";
    fs::write(dir.path().join(audio), b"not-a-real-m4a").unwrap();
    let sidecar = serde_json::json!({
      "version": 1,
      "textKey": "import-9",
      "durationMs": 4321,
      "createdAt": 1_700_000_000_000_i64,
      "peaks": [0.25, 1.4, -0.5],
      "mime": "audio/mp4"
    });
    fs::write(
      dir.path().join("E01-how-i-stay-20261122-1804.json"),
      serde_json::to_vec(&sidecar).unwrap(),
    )
    .unwrap();
    let sessions = dir.path().join(".sessions").join("abc");
    fs::create_dir_all(&sessions).unwrap();
    write_wav(&sessions.join("take.wav"), 48_000, 48_000);
    fs::write(dir.path().join("notes.txt"), b"hello").unwrap();
    fs::write(dir.path().join(".hidden.m4a"), b"nope").unwrap();

    let takes = scan_takes(dir.path()).unwrap();
    assert_eq!(takes.len(), 1);
    let take = &takes[0];
    assert_eq!(take.name, audio);
    assert_eq!(take.text_key, "import-9");
    assert_eq!(take.duration_ms, 4321);
    assert_eq!(take.created_at, 1_700_000_000_000);
    assert_eq!(take.mime, "audio/mp4");
    assert_eq!(take.bytes, b"not-a-real-m4a".len() as u64);
    assert!(take.sidecar);
    assert_eq!(take.peaks, vec![0.25, 1.0, 0.5]);
    assert_eq!(clean_peaks(vec![0.25, 1.4, -0.5, f32::NAN]), vec![0.25, 1.0, 0.5, 0.0]);
    assert!(take.path.ends_with(audio));
  }

  #[test]
  fn missing_or_broken_sidecar_uses_the_file_name_and_probed_duration() {
    let dir = TempDir::new();
    let named = "E02-market-notes-20261122-1805.wav";
    write_wav(&dir.path().join(named), 48_000, 48_000);
    fs::write(dir.path().join("E02-market-notes-20261122-1805.json"), b"{").unwrap();
    let suffixed = "E01-title-20261123-0900-2.wav";
    write_wav(&dir.path().join(suffixed), 24_000, 48_000);
    fs::write(dir.path().join("stray.m4a"), Vec::<u8>::new()).unwrap();

    let takes = scan_takes(dir.path()).unwrap();
    assert_eq!(takes.len(), 3);
    let by_name = |name: &str| takes.iter().find(|take| take.name == name).unwrap();

    let essay = by_name(named);
    assert!(!essay.sidecar);
    assert_eq!(essay.text_key, "E02");
    assert_eq!(essay.duration_ms, 1000);
    assert_eq!(essay.created_at, local_ms(2026, 11, 22, 18, 5));
    assert_eq!(essay.mime, "audio/wav");
    assert!(essay.peaks.is_empty());

    let second = by_name(suffixed);
    assert_eq!(second.text_key, "E01");
    assert_eq!(second.duration_ms, 500);
    assert_eq!(second.created_at, local_ms(2026, 11, 23, 9, 0));

    let stray = by_name("stray.m4a");
    assert_eq!(stray.text_key, "");
    assert_eq!(stray.duration_ms, 0);
    assert_eq!(stray.mime, "audio/mp4");
    assert!(stray.created_at > 0);
  }

  #[test]
  fn mp4_duration_reads_mvhd_inside_moov() {
    let mut body = Vec::new();
    body.extend(box_of(b"free", b"skip"));
    body.extend(box_of(b"moov", &mvhd(1000, 2500)));
    let file = box_of(b"ftyp", b"M4A ");
    let mut data = file;
    data.extend(body);
    assert_eq!(probe_mp4_duration_ms(&data), Some(2500));

    let mut version1 = vec![1u8, 0, 0, 0];
    version1.extend(std::iter::repeat(0).take(16));
    version1.extend(1000u32.to_be_bytes());
    version1.extend(4_000u64.to_be_bytes());
    assert_eq!(mvhd_duration_ms(&version1), Some(4000));
    assert_eq!(mvhd_duration_ms(&[0, 0, 0, 0]), None);
  }

  #[test]
  fn sidecar_duration_wins_and_a_zero_duration_is_probed() {
    let dir = TempDir::new();
    let name = "E01-title-20261122-1804.wav";
    write_wav(&dir.path().join(name), 48_000, 48_000);
    fs::write(
      dir.path().join("E01-title-20261122-1804.json"),
      br#"{"version":1,"textKey":"E01","durationMs":0,"createdAt":0,"peaks":[],"mime":""}"#,
    )
    .unwrap();
    let takes = scan_takes(dir.path()).unwrap();
    assert_eq!(takes[0].duration_ms, 1000);
    assert_eq!(takes[0].created_at, local_ms(2026, 11, 22, 18, 4));
    assert_eq!(takes[0].mime, "audio/wav");
    assert!(takes[0].sidecar);
  }

  #[test]
  fn delete_removes_the_audio_and_the_sidecar_only() {
    let dir = TempDir::new();
    fs::write(dir.path().join("E01-a-20261122-1804.m4a"), b"audio").unwrap();
    fs::write(dir.path().join("E01-a-20261122-1804.json"), b"{}").unwrap();
    fs::write(dir.path().join("E01-b-20261122-1805.m4a"), b"keep").unwrap();

    delete_take(dir.path(), "E01-a-20261122-1804.m4a").unwrap();
    assert!(!dir.path().join("E01-a-20261122-1804.m4a").exists());
    assert!(!dir.path().join("E01-a-20261122-1804.json").exists());
    assert_eq!(fs::read(dir.path().join("E01-b-20261122-1805.m4a")).unwrap(), b"keep");

    delete_take(dir.path(), "E01-a-20261122-1804.m4a").unwrap();
    assert!(matches!(
      delete_take(dir.path(), "../secret.m4a"),
      Err(TakesError::BadName)
    ));
    assert!(matches!(
      delete_take(dir.path(), ".sessions/take.wav"),
      Err(TakesError::BadName)
    ));
    assert!(matches!(
      delete_take(dir.path(), "notes.txt"),
      Err(TakesError::BadName)
    ));
  }

  #[test]
  fn read_returns_the_audio_bytes_and_rejects_a_missing_name() {
    let dir = TempDir::new();
    fs::write(dir.path().join("E01-a.m4a"), b"abc").unwrap();
    assert_eq!(read_take(dir.path(), "E01-a.m4a").unwrap(), b"abc");
    assert!(matches!(
      read_take(dir.path(), "missing.m4a"),
      Err(TakesError::NotFound)
    ));
    assert!(matches!(
      read_take(dir.path(), "E01-a.m4a/../../etc/passwd"),
      Err(TakesError::BadName)
    ));
  }

  #[cfg(unix)]
  #[test]
  fn read_refuses_a_symlink_that_leaves_the_folder() {
    let dir = TempDir::new();
    let outside = TempDir::new();
    let secret = outside.path().join("secret.m4a");
    fs::write(&secret, b"secret-bytes").unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("link.m4a")).unwrap();
    assert!(matches!(
      read_take(dir.path(), "link.m4a"),
      Err(TakesError::BadName)
    ));
    let listed = scan_takes(dir.path()).unwrap();
    assert!(listed.iter().all(|take| take.name != "link.m4a"));
  }

  #[test]
  fn hidden_session_paths_do_not_count_as_take_changes() {
    assert!(!event_touches_take(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/.sessions/abc/take.wav"
    )]));
    assert!(event_touches_take(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/E01-title.m4a"
    )]));
    assert!(event_touches_take(&[]));
    assert!(!event_touches_take(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/.sessions"
    )]));
  }

  #[test]
  fn debounce_emits_once_after_the_folder_stays_quiet() {
    let start = Instant::now();
    let wait = TAKES_WATCH_DEBOUNCE;
    let mut debounce = ChangeDebounce::new(wait);
    assert!(!debounce.poll(start));
    debounce.note(start);
    assert!(!debounce.poll(start + wait - Duration::from_millis(1)));
    assert!(debounce.poll(start + wait));
    assert!(!debounce.poll(start + wait + wait));

    debounce.note(start);
    debounce.note(start + Duration::from_millis(200));
    assert!(!debounce.poll(start + wait));
    assert!(debounce.poll(start + Duration::from_millis(200) + wait));
    assert!(!debounce.poll(start + Duration::from_millis(200) + wait + wait));
  }

  #[test]
  fn a_missing_folder_lists_nothing() {
    let dir = TempDir::new();
    let missing = dir.path().join("nope");
    assert!(scan_takes(&missing).unwrap().is_empty());
  }
}
