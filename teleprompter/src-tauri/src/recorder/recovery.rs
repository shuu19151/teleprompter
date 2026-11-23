//! Crash recovery for an unfinished session.
//!
//! Startup scans `.sessions/` for a take that is still `recording` or
//! `paused`. The open segment's header is rebuilt from the bytes on disk.
//! Save concatenates the segments into one WAV take under Documents/Teleprompter
//! and deletes the session only after that file and its sidecar have been
//! checked. Discard deletes the session folder and does not write a take.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Timelike};
use hound::{SampleFormat, WavSpec, WavWriter};
use serde::Serialize;

use super::session::{
  duration_ms, is_finished_state, read_session_file, segment_list, write_session_atomic, SessionRecord,
};
use super::wav::repair_wav_header;
use super::{RecorderError, OUTPUT_SAMPLE_RATE};

const SIDECAR_VERSION: u32 = 1;
const MAX_PEAKS: usize = 400;
const PEAK_FRAMES: usize = 960;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredSession {
  pub session_id: String,
  pub text_key: String,
  pub duration_ms: u64,
  pub started_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TakeSidecar {
  version: u32,
  text_key: String,
  duration_ms: u64,
  created_at: i64,
  peaks: Vec<f32>,
  mime: String,
}

pub fn scan_unfinished(root: &Path) -> Result<Vec<RecoveredSession>, RecorderError> {
  if !root.exists() {
    return Ok(Vec::new());
  }
  let entries = fs::read_dir(root).map_err(|error| {
    RecorderError::Session(format!("could not read {}: {error}", root.display()))
  })?;
  let mut found = Vec::new();
  for entry in entries {
    let entry = entry.map_err(|error| RecorderError::Session(error.to_string()))?;
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let Some(id) = entry.file_name().to_str().map(str::to_string) else {
      continue;
    };
    if id.starts_with('.') || id.contains(['/', '\\']) {
      continue;
    }
    let Ok(record) = read_session_file(&path) else {
      continue;
    };
    if is_finished_state(&record.state) {
      continue;
    }
    found.push(RecoveredSession {
      session_id: id,
      text_key: record.text_key.clone(),
      duration_ms: measured_duration(&path, &record),
      started_at: record.started_at,
    });
  }
  found.sort_by(|left, right| {
    left
      .started_at
      .cmp(&right.started_at)
      .then(left.session_id.cmp(&right.session_id))
  });
  Ok(found)
}

pub fn apply(
  sessions_root: &Path,
  takes_dir: &Path,
  session_id: &str,
  action: &str,
) -> Result<(), RecorderError> {
  let directory = session_dir(sessions_root, session_id)?;
  let record = read_session_file(&directory)?;
  if is_finished_state(&record.state) {
    return Err(RecorderError::Session(
      "that recording is already finished".into(),
    ));
  }
  match action {
    "discard" => {
      fs::remove_dir_all(&directory).map_err(|error| {
        RecorderError::Session(format!("could not delete {}: {error}", directory.display()))
      })?;
      Ok(())
    }
    "save" => save_take(takes_dir, &directory, record),
    _ => Err(RecorderError::Session(
      "the recovery action is not save or discard".into(),
    )),
  }
}

fn measured_duration(directory: &Path, record: &SessionRecord) -> u64 {
  let names = segment_list(directory, record);
  let mut frames = 0u64;
  let mut any = false;
  for name in names {
    match repair_wav_header(&directory.join(&name)) {
      Ok(repaired) => {
        frames += repaired.frames;
        any = true;
      }
      Err(_) => {}
    }
  }
  if any {
    duration_ms(frames)
  } else {
    record.last_written_ms
  }
}

fn save_take(takes_dir: &Path, directory: &Path, mut record: SessionRecord) -> Result<(), RecorderError> {
  fs::create_dir_all(takes_dir).map_err(|error| {
    RecorderError::Session(format!("could not create {}: {error}", takes_dir.display()))
  })?;
  let names = segment_list(directory, &record);
  if names.is_empty() {
    return Err(RecorderError::Session(
      "that recording has no audio to save".into(),
    ));
  }
  let stem = take_stem(&record);
  let name = unique_take_name(takes_dir, &stem)?;
  let partial = takes_dir.join(format!(".{name}.partial"));
  let saved = match write_concat(directory, &names, &partial) {
    Ok(saved) => saved,
    Err(error) => {
      let _ = fs::remove_file(&partial);
      return Err(error);
    }
  };
  if let Err(error) = verify_wav(&partial, saved.frames) {
    let _ = fs::remove_file(&partial);
    return Err(error);
  }
  let sidecar = TakeSidecar {
    version: SIDECAR_VERSION,
    text_key: record.text_key.clone(),
    duration_ms: duration_ms(saved.frames),
    created_at: started_millis(&record.started_at),
    peaks: saved.peaks,
    mime: "audio/wav".into(),
  };
  let sidecar_partial = takes_dir.join(format!(".{stem}.json.partial"));
  if let Err(error) = write_sidecar(&sidecar_partial, &sidecar) {
    let _ = fs::remove_file(&partial);
    let _ = fs::remove_file(&sidecar_partial);
    return Err(error);
  }
  let audio_path = takes_dir.join(&name);
  let sidecar_path = takes_dir.join(sidecar_name(&name));
  if let Err(error) = fs::rename(&partial, &audio_path) {
    let _ = fs::remove_file(&partial);
    let _ = fs::remove_file(&sidecar_partial);
    return Err(RecorderError::Write(format!(
      "could not save {}: {error}",
      audio_path.display()
    )));
  }
  if let Err(error) = fs::rename(&sidecar_partial, &sidecar_path) {
    let _ = fs::remove_file(&audio_path);
    let _ = fs::remove_file(&sidecar_partial);
    return Err(RecorderError::Write(format!(
      "could not save {}: {error}",
      sidecar_path.display()
    )));
  }
  verify_wav(&audio_path, saved.frames)?;
  if !sidecar_path.is_file() {
    return Err(RecorderError::Write(format!(
      "could not save {}",
      sidecar_path.display()
    )));
  }
  record.state = "finished".into();
  record.last_written_ms = duration_ms(saved.frames);
  write_session_atomic(directory, &record)?;
  fs::remove_dir_all(directory).map_err(|error| {
    RecorderError::Session(format!(
      "the take was saved but {} could not be removed: {error}",
      directory.display()
    ))
  })?;
  Ok(())
}

struct SavedAudio {
  frames: u64,
  peaks: Vec<f32>,
}

fn write_concat(directory: &Path, names: &[String], dest: &Path) -> Result<SavedAudio, RecorderError> {
  let spec = WavSpec {
    channels: 1,
    sample_rate: OUTPUT_SAMPLE_RATE,
    bits_per_sample: 16,
    sample_format: SampleFormat::Int,
  };
  let mut writer = WavWriter::create(dest, spec).map_err(|error| {
    RecorderError::Write(format!("could not create {}: {error}", dest.display()))
  })?;
  let mut frames = 0u64;
  let mut peaks = PeakFold::default();
  for name in names {
    let path = directory.join(name);
    if !path.is_file() {
      return Err(RecorderError::Write(format!(
        "missing segment {}",
        path.display()
      )));
    }
    repair_wav_header(&path)?;
    let mut reader = hound::WavReader::open(&path).map_err(|error| {
      RecorderError::Write(format!("could not read {}: {error}", path.display()))
    })?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != OUTPUT_SAMPLE_RATE || spec.bits_per_sample != 16 {
      return Err(RecorderError::Write(format!(
        "{} is not 48 kHz mono 16-bit audio",
        path.display()
      )));
    }
    for sample in reader.samples::<i16>() {
      let sample = sample.map_err(|error| RecorderError::Write(error.to_string()))?;
      writer
        .write_sample(sample)
        .map_err(|error| RecorderError::Write(error.to_string()))?;
      peaks.push(sample);
      frames += 1;
    }
  }
  writer
    .finalize()
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  Ok(SavedAudio {
    frames,
    peaks: peaks.finish(),
  })
}

fn verify_wav(path: &Path, frames: u64) -> Result<(), RecorderError> {
  let mut reader = hound::WavReader::open(path).map_err(|error| {
    RecorderError::Write(format!("could not read {}: {error}", path.display()))
  })?;
  let spec = reader.spec();
  if spec.channels != 1 || spec.sample_rate != OUTPUT_SAMPLE_RATE || spec.bits_per_sample != 16 {
    return Err(RecorderError::Write(format!(
      "{} is not 48 kHz mono 16-bit audio",
      path.display()
    )));
  }
  if u64::from(reader.duration()) != frames {
    return Err(RecorderError::Write(format!(
      "{} does not have the recorded length",
      path.display()
    )));
  }
  let mut count = 0u64;
  for sample in reader.samples::<i16>() {
    sample.map_err(|error| RecorderError::Write(error.to_string()))?;
    count += 1;
  }
  if count != frames {
    return Err(RecorderError::Write(format!(
      "{} could not be read back",
      path.display()
    )));
  }
  let bytes = fs::metadata(path)
    .map(|meta| meta.len())
    .unwrap_or(0);
  if bytes < 44 + frames.saturating_mul(2) {
    return Err(RecorderError::Write(format!(
      "{} is shorter than the audio it claims",
      path.display()
    )));
  }
  Ok(())
}

fn write_sidecar(path: &Path, sidecar: &TakeSidecar) -> Result<(), RecorderError> {
  let bytes = serde_json::to_vec_pretty(sidecar)
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  let mut file = File::create(path).map_err(|error| RecorderError::Write(error.to_string()))?;
  file
    .write_all(&bytes)
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  file
    .sync_all()
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  let read: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|error| {
    RecorderError::Write(error.to_string())
  })?)
  .map_err(|error| RecorderError::Write(error.to_string()))?;
  if read["textKey"] != sidecar.text_key || read["mime"] != "audio/wav" {
    return Err(RecorderError::Write(format!(
      "could not read back {}",
      path.display()
    )));
  }
  Ok(())
}

fn session_dir(root: &Path, session_id: &str) -> Result<PathBuf, RecorderError> {
  if session_id.is_empty()
    || session_id.len() > 80
    || session_id.starts_with('.')
    || session_id.contains(['/', '\\', '.', '\0'])
  {
    return Err(RecorderError::Session("that recording was not found".into()));
  }
  let path = root.join(session_id);
  if path.parent() != Some(root) || !path.is_dir() {
    return Err(RecorderError::Session("that recording was not found".into()));
  }
  Ok(path)
}

fn take_stem(record: &SessionRecord) -> String {
  let code_source = if record.code.is_empty() {
    record.text_key.as_str()
  } else {
    record.code.as_str()
  };
  let code = file_token(code_source, "take");
  let slug = title_slug(&record.title);
  format!("{code}-{slug}-{}", stamp_local(&record.started_at))
}

fn file_token(value: &str, fallback: &str) -> String {
  let mut out = String::new();
  for ch in value.chars() {
    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
      out.push(ch);
    }
    if out.len() >= 80 {
      break;
    }
  }
  let out = out.trim_matches('-');
  if out.is_empty() {
    fallback.to_string()
  } else {
    out.to_string()
  }
}

fn title_slug(title: &str) -> String {
  let mut slug = String::new();
  let mut dash = false;
  for ch in title.chars() {
    if ch.is_ascii_alphanumeric() {
      slug.push(ch.to_ascii_lowercase());
      dash = false;
    } else if !slug.is_empty() && !dash {
      slug.push('-');
      dash = true;
    }
    if slug.len() >= 80 {
      break;
    }
  }
  let slug = slug.trim_matches('-');
  if slug.is_empty() {
    "untitled".into()
  } else {
    slug.to_string()
  }
}

fn stamp_local(started_at: &str) -> String {
  let local = chrono::DateTime::parse_from_rfc3339(started_at)
    .map(|time| time.with_timezone(&chrono::Local))
    .unwrap_or_else(|_| chrono::Local::now());
  format!(
    "{:04}{:02}{:02}-{:02}{:02}",
    local.year(),
    local.month(),
    local.day(),
    local.hour(),
    local.minute()
  )
}

fn started_millis(started_at: &str) -> i64 {
  chrono::DateTime::parse_from_rfc3339(started_at)
    .map(|time| time.timestamp_millis())
    .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

fn unique_take_name(dir: &Path, stem: &str) -> Result<String, RecorderError> {
  let first = format!("{stem}.wav");
  if !dir.join(&first).exists() {
    return Ok(first);
  }
  for index in 2..1000 {
    let name = format!("{stem}-{index}.wav");
    if !dir.join(&name).exists() {
      return Ok(name);
    }
  }
  Err(RecorderError::Write(
    "could not choose a name for the recovered take".into(),
  ))
}

fn sidecar_name(audio: &str) -> String {
  match audio.rsplit_once('.') {
    Some((stem, _)) if !stem.is_empty() => format!("{stem}.json"),
    _ => format!("{audio}.json"),
  }
}

#[derive(Default)]
struct PeakFold {
  window: f32,
  count: usize,
  peaks: Vec<f32>,
}

impl PeakFold {
  fn push(&mut self, sample: i16) {
    let value = (sample as f32 / i16::MAX as f32).abs();
    if value > self.window {
      self.window = value;
    }
    self.count += 1;
    if self.count >= PEAK_FRAMES {
      self.peaks.push(self.window.clamp(0.0, 1.0));
      self.window = 0.0;
      self.count = 0;
    }
  }

  fn finish(mut self) -> Vec<f32> {
    if self.count > 0 {
      self.peaks.push(self.window.clamp(0.0, 1.0));
    }
    downsample(&self.peaks, MAX_PEAKS)
  }
}

fn downsample(peaks: &[f32], max: usize) -> Vec<f32> {
  if peaks.len() <= max {
    return peaks.to_vec();
  }
  let mut out = Vec::with_capacity(max);
  for index in 0..max {
    let start = index * peaks.len() / max;
    let end = ((index + 1) * peaks.len() / max).max(start + 1);
    let peak = peaks[start..end]
      .iter()
      .copied()
      .fold(0.0f32, f32::max);
    out.push(peak.clamp(0.0, 1.0));
  }
  out
}

#[cfg(test)]
mod tests {
  use super::super::session::{self, duration_ms, write_session_atomic, SessionRecord};
  use super::super::wav::f32_to_i16;
  use super::*;

  #[test]
  fn a_killed_process_repairs_saves_and_discard_leaves_no_take() {
    let root = scratch("killed");
    let takes = root.takes();
    let save_id = "11111111-1111-4111-8111-111111111111";
    let discard_id = "22222222-2222-4222-8222-222222222222";
    let first = [0.25f32, -0.5, 0.75];
    let second = [0.5f32, -0.25];
    let third = [1.0f32, 0.0, -1.0, 0.5];
    write_killed_session(
      &root.sessions().join(save_id),
      "E01",
      "E01",
      "How I stay productive and calm",
      &[&first, &second],
      &third,
    );
    write_killed_session(
      &root.sessions().join(discard_id),
      "E02",
      "E02",
      "Other",
      &[&[0.2f32]],
      &[0.3],
    );
    fs::create_dir_all(root.sessions().join("finished-one")).unwrap();
    let finished = SessionRecord {
      state: "stopped".into(),
      ..SessionRecord::new(
        "2020-01-01T00:00:00.000Z".into(),
        "E09".into(),
        "E09".into(),
        "Done".into(),
        "Mic".into(),
        vec![session::segment_name(0)],
      )
    };
    write_session_atomic(&root.sessions().join("finished-one"), &finished).unwrap();

    let found = scan_unfinished(root.sessions()).unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].session_id, save_id);
    assert_eq!(found[0].text_key, "E01");
    assert_eq!(found[0].duration_ms, duration_ms(3 + 2 + 4));
    assert!(found[0].started_at.ends_with('Z'));
    assert_eq!(found[1].session_id, discard_id);

    apply(root.sessions(), takes, save_id, "save").unwrap();
    assert!(!root.sessions().join(save_id).exists());
    let saved: Vec<_> = fs::read_dir(takes)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .filter(|name| !name.starts_with('.'))
      .collect();
    let audio = saved
      .iter()
      .find(|name| name.ends_with(".wav"))
      .expect("saved wav");
    assert!(audio.starts_with("E01-how-i-stay-productive-and-calm-"));
    assert!(audio.ends_with(".wav"));
    let sidecar_name = format!("{}.json", audio.trim_end_matches(".wav"));
    assert!(saved.iter().any(|name| name == &sidecar_name));
    let mut reader = hound::WavReader::open(takes.join(audio)).unwrap();
    assert_eq!(reader.spec().sample_rate, OUTPUT_SAMPLE_RATE);
    assert_eq!(reader.spec().channels, 1);
    assert_eq!(reader.spec().bits_per_sample, 16);
    let pcm: Vec<i16> = reader.samples::<i16>().map(|sample| sample.unwrap()).collect();
    let mut expected = Vec::new();
    expected.extend(first.iter().copied().map(f32_to_i16));
    expected.extend(second.iter().copied().map(f32_to_i16));
    expected.extend(third.iter().copied().map(f32_to_i16));
    assert_eq!(pcm, expected);
    let sidecar: serde_json::Value =
      serde_json::from_slice(&fs::read(takes.join(&sidecar_name)).unwrap()).unwrap();
    assert_eq!(sidecar["version"], 1);
    assert_eq!(sidecar["textKey"], "E01");
    assert_eq!(sidecar["mime"], "audio/wav");
    assert_eq!(sidecar["durationMs"], duration_ms(expected.len() as u64));
    assert!(sidecar["createdAt"].as_i64().unwrap() > 0);
    assert!(sidecar["peaks"].as_array().unwrap().len() >= 1);

    apply(root.sessions(), takes, discard_id, "discard").unwrap();
    assert!(!root.sessions().join(discard_id).exists());
    let wavs = fs::read_dir(takes)
      .unwrap()
      .filter_map(|entry| entry.ok())
      .filter(|entry| {
        entry
          .path()
          .extension()
          .and_then(|ext| ext.to_str())
          == Some("wav")
      })
      .count();
    assert_eq!(wavs, 1);
    assert!(scan_unfinished(root.sessions()).unwrap().is_empty());
  }

  #[test]
  fn save_keeps_the_session_when_the_audio_cannot_be_read() {
    let root = scratch("broken");
    let id = "33333333-3333-4333-8333-333333333333";
    let dir = root.sessions().join(id);
    fs::create_dir_all(&dir).unwrap();
    let record = SessionRecord::new(
      "2026-11-23T12:00:00.000Z".into(),
      "E01".into(),
      "E01".into(),
      "Broken".into(),
      "Mic".into(),
      vec![session::segment_name(0)],
    );
    write_session_atomic(&dir, &record).unwrap();
    fs::write(dir.join(session::segment_name(0)), b"not a wav").unwrap();
    let error = apply(root.sessions(), root.takes(), id, "save").unwrap_err();
    assert!(matches!(error, RecorderError::Write(_)));
    assert!(dir.join(session::SESSION_FILE).exists());
    assert!(dir.join(session::segment_name(0)).exists());
    let leftovers: Vec<_> = fs::read_dir(root.takes())
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .filter(|name| !name.starts_with('.'))
      .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
  }

  #[test]
  fn a_second_save_in_the_same_minute_gets_a_suffix() {
    let root = scratch("clash");
    let id = "44444444-4444-4444-8444-444444444444";
    write_killed_session(
      &root.sessions().join(id),
      "E01",
      "E01",
      "Calm",
      &[&[0.5f32, -0.5]],
      &[],
    );
    let record = read_session_file(&root.sessions().join(id)).unwrap();
    let stem = take_stem(&record);
    fs::write(root.takes().join(format!("{stem}.wav")), b"taken").unwrap();
    apply(root.sessions(), root.takes(), id, "save").unwrap();
    let suffixed = root.takes().join(format!("{stem}-2.wav"));
    assert!(suffixed.is_file());
    let reader = hound::WavReader::open(&suffixed).unwrap();
    assert_eq!(reader.duration(), 2);
    assert!(root.takes().join(format!("{stem}-2.json")).is_file());
  }

  fn write_killed_session(
    dir: &Path,
    text_key: &str,
    code: &str,
    title: &str,
    closed: &[&[f32]],
    open_tail: &[f32],
  ) {
    fs::create_dir_all(dir).unwrap();
    let mut names = Vec::new();
    for (index, samples) in closed.iter().enumerate() {
      let name = session::segment_name(index as u32);
      write_final_wav(&dir.join(&name), samples);
      names.push(name);
    }
    if !open_tail.is_empty() || closed.is_empty() {
      let name = session::segment_name(names.len() as u32);
      write_unfinalized_wav(&dir.join(&name), open_tail);
      names.push(name);
    }
    let record = SessionRecord {
      state: "recording".into(),
      last_written_ms: 0,
      ..SessionRecord::new(
        "2026-11-23T17:04:05.000Z".into(),
        text_key.into(),
        code.into(),
        title.into(),
        "Mic".into(),
        names,
      )
    };
    write_session_atomic(dir, &record).unwrap();
  }

  fn write_final_wav(path: &Path, samples: &[f32]) {
    let spec = WavSpec {
      channels: 1,
      sample_rate: OUTPUT_SAMPLE_RATE,
      bits_per_sample: 16,
      sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).unwrap();
    for sample in samples {
      writer.write_sample(f32_to_i16(*sample)).unwrap();
    }
    writer.finalize().unwrap();
  }

  /// Header still says the data chunk is empty. The PCM bytes are on disk.
  fn write_unfinalized_wav(path: &Path, samples: &[f32]) {
    write_final_wav(path, samples);
    let mut bytes = fs::read(path).unwrap();
    bytes[40..44].copy_from_slice(&0u32.to_le_bytes());
    let riff = 36u32;
    bytes[4..8].copy_from_slice(&riff.to_le_bytes());
    if !samples.is_empty() {
      bytes.push(0x80);
    }
    fs::write(path, bytes).unwrap();
  }

  struct Scratch {
    path: PathBuf,
  }

  impl Scratch {
    fn sessions(&self) -> &Path {
      &self.path
    }

    fn takes(&self) -> &Path {
      self.path.parent().unwrap()
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      if let Some(parent) = self.path.parent() {
        let _ = fs::remove_dir_all(parent);
      }
    }
  }

  fn scratch(label: &str) -> Scratch {
    let root = std::env::temp_dir().join(format!(
      "teleprompter-recover-{label}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    let sessions = root.join(".sessions");
    fs::create_dir_all(&sessions).unwrap();
    Scratch { path: sessions }
  }
}
