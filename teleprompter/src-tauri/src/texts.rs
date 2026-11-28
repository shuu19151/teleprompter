//! Unified text library stored in the user's selected directory.
//!
//! Each text is a `.md` or `.txt` file plus a `<stem>.json` sidecar. The sidecar
//! holds the id, the display code, the title, and the timestamps. The text file
//! is the script alone, byte for byte. A sidecar leaves a hand-dropped file
//! untouched: the list still shows it, with a stable id derived from the file
//! name and a title taken from that name. The id is the take text key, so a
//! rename done by the app keeps existing takes attached to the essay.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::DateTime;
use notify::Watcher;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::FsExt;

use crate::takes::ChangeDebounce;

/// How long the texts folder must stay quiet before `texts://changed` is emitted.
pub const TEXTS_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// The import dialog rejects anything larger than this. Writes use the same cap.
pub const MAX_TEXT_BYTES: usize = 200 * 1024;

/// A hand-dropped file above this size is listed with an empty script.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

const TEXT_EXTENSIONS: &[&str] = &["md", "txt"];

const SMALL_WORDS: &[&str] = &[
  "a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "vs",
];

#[derive(Debug, thiserror::Error)]
pub enum TextsError {
  #[error("could not read texts: {0}")]
  Io(String),
  #[error("that text was not found")]
  NotFound,
  #[error("that text name is not allowed")]
  BadName,
  #[error("that text is larger than 200 KB")]
  TooLarge,
}

impl Serialize for TextsError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    serializer.serialize_str(&self.to_string())
  }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListedText {
  pub id: String,
  pub code: String,
  pub title: String,
  pub body: String,
  pub created_at: Value,
  pub updated_at: Option<Value>,
  pub name: String,
  pub path: String,
  pub extension: String,
  pub sidecar: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDraft {
  pub id: String,
  pub code: String,
  pub title: String,
  pub body: String,
  #[serde(default)]
  pub created_at: Value,
  #[serde(default)]
  pub updated_at: Option<Value>,
  #[serde(default)]
  pub extension: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
  version: u32,
  id: String,
  #[serde(default)]
  code: String,
  #[serde(default)]
  title: String,
  #[serde(default)]
  created_at: Value,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  updated_at: Option<Value>,
}

#[derive(Clone, Serialize)]
struct TextsChanged {}

struct TextPaths {
  name: String,
  body: PathBuf,
  sidecar: PathBuf,
}

pub fn scan_texts(dir: &Path) -> Result<Vec<ListedText>, TextsError> {
  Ok(dedupe_ids(collect_texts(dir)?))
}

fn collect_texts(dir: &Path) -> Result<Vec<ListedText>, TextsError> {
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let mut texts = Vec::new();
  let entries = fs::read_dir(dir).map_err(|error| TextsError::Io(error.to_string()))?;
  for entry in entries {
    let entry = entry.map_err(|error| TextsError::Io(error.to_string()))?;
    let Some(name) = entry.file_name().to_str().map(str::to_string) else {
      continue;
    };
    if name.starts_with('.') {
      continue;
    }
    let Some(extension) = text_extension(&name) else {
      continue;
    };
    let file_type = entry
      .file_type()
      .map_err(|error| TextsError::Io(error.to_string()))?;
    if !file_type.is_file() {
      continue;
    }
    let path = entry.path();
    let modified = entry
      .metadata()
      .ok()
      .and_then(|meta| meta.modified().ok())
      .map(system_time_ms)
      .unwrap_or(0);
    let len = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len > MAX_READ_BYTES {
      return Err(TextsError::Io(format!("Text is too large to read: {name}")));
    }
    let mut body = fs::read_to_string(&path).map_err(|error| TextsError::Io(format!("{name}: {error}")))?;
    let parsed = read_sidecar(&dir.join(sidecar_name(&name)));
    let sidecar = parsed.as_ref().is_some_and(|side| !side.id.trim().is_empty());
    let side = parsed.filter(|side| !side.id.trim().is_empty());
    let stem = file_stem(&name);
    let (name_code, name_title) = title_and_code_from_stem(&stem);
    let legacy_essay = !sidecar && extension == "txt" && name_code.starts_with('E');
    let id = side
      .as_ref()
      .map(|side| side.id.clone())
      .filter(|id| !id.trim().is_empty())
      .unwrap_or_else(|| if legacy_essay { name.clone() } else { stable_file_id(&name) });
    let code = side
      .as_ref()
      .map(|side| side.code.clone())
      .filter(|code| !code.trim().is_empty())
      .unwrap_or(name_code);
    let mut title = side
      .as_ref()
      .map(|side| side.title.clone())
      .filter(|title| !title.trim().is_empty())
      .unwrap_or(name_title);
    if legacy_essay {
      let normalized = body.replace("\r\n", "\n");
      let (heading, script) = normalized.trim().split_once("\n\n").unwrap_or((normalized.trim(), ""));
      title = title_case(heading);
      body = script.to_string();
    }
    let created_at = side
      .as_ref()
      .map(|side| side.created_at.clone())
      .filter(|value| !value.is_null())
      .unwrap_or_else(|| Value::from(modified));
    let updated_at = side.and_then(|side| side.updated_at).filter(|value| !value.is_null());
    texts.push(ListedText {
      id,
      code,
      title,
      body,
      created_at,
      updated_at,
      name,
      path: path.to_string_lossy().into_owned(),
      extension,
      sidecar,
    });
  }
  texts.sort_by(|left, right| {
    created_millis(&left.created_at)
      .cmp(&created_millis(&right.created_at))
      .then_with(|| left.name.cmp(&right.name))
  });
  Ok(texts)
}

pub fn read_text(dir: &Path, id: &str) -> Result<ListedText, TextsError> {
  validate_id(id)?;
  scan_texts(dir)?
    .into_iter()
    .find(|text| text.id == id)
    .ok_or(TextsError::NotFound)
}

pub fn delete_text(dir: &Path, id: &str) -> Result<(), TextsError> {
  validate_id(id)?;
  if !dir.exists() {
    return Ok(());
  }
  let matches = collect_texts(dir)?
    .into_iter()
    .filter(|text| text.id == id)
    .collect::<Vec<_>>();
  for text in matches {
    remove_leaf(dir, &text.name)?;
    remove_leaf(dir, &sidecar_name(&text.name))?;
  }
  Ok(())
}

pub fn write_text(dir: &Path, draft: &TextDraft) -> Result<ListedText, TextsError> {
  validate_id(&draft.id)?;
  let code = normalize_code(&draft.code)?;
  let title = normalize_title(&draft.title);
  let extension = normalize_extension(&draft.extension)?;
  if draft.body.len() > MAX_TEXT_BYTES {
    return Err(TextsError::TooLarge);
  }
  fs::create_dir_all(dir).map_err(|error| TextsError::Io(error.to_string()))?;
  let existing = collect_texts(dir)?
    .into_iter()
    .filter(|text| text.id == draft.id)
    .collect::<Vec<_>>();
  let own_names = existing
    .iter()
    .flat_map(|text| [text.name.clone(), sidecar_name(&text.name)])
    .collect::<HashSet<_>>();
  let file_name = unique_name(dir, &code, &title, &extension, &own_names)?;
  let paths = paths_for(dir, &file_name)?;
  let created_at = stored_created_at(&draft.created_at, &existing);
  let updated_at = draft.updated_at.clone().filter(|value| !value.is_null());
  let sidecar = Sidecar {
    version: 1,
    id: draft.id.clone(),
    code,
    title,
    created_at,
    updated_at,
  };
  let sidecar_bytes = serde_json::to_vec_pretty(&sidecar).map_err(|error| TextsError::Io(error.to_string()))?;
  write_leaf(&paths.body, draft.body.as_bytes())?;
  if let Err(error) = write_leaf(&paths.sidecar, &sidecar_bytes) {
    if !own_names.contains(&paths.name) {
      let _ = fs::remove_file(&paths.body);
    }
    return Err(error);
  }
  for old in &existing {
    if old.name != paths.name {
      remove_leaf(dir, &old.name)?;
    }
    let old_side = sidecar_name(&old.name);
    if old_side != sidecar_name(&paths.name) {
      remove_leaf(dir, &old_side)?;
    }
  }
  read_text(dir, &draft.id)
}

/// True when a watch event might be a text file or its sidecar. Empty paths
/// are a rescan. A hidden name, including a temp file, is ignored.
pub fn event_touches_text(paths: &[PathBuf]) -> bool {
  if paths.is_empty() {
    return true;
  }
  paths.iter().any(|path| {
    if path_is_hidden(path) {
      return false;
    }
    let Some(name) = path.file_name().and_then(|part| part.to_str()) else {
      return true;
    };
    text_extension(name).is_some() || is_sidecar_name(name) || !name.contains('.')
  })
}

fn dedupe_ids(texts: Vec<ListedText>) -> Vec<ListedText> {
  let mut index: HashMap<String, usize> = HashMap::new();
  let mut out: Vec<ListedText> = Vec::new();
  for text in texts {
    if let Some(slot) = index.get(&text.id).copied() {
      if text.sidecar && !out[slot].sidecar {
        out[slot] = text;
      }
      continue;
    }
    index.insert(text.id.clone(), out.len());
    out.push(text);
  }
  out
}

fn paths_for(dir: &Path, name: &str) -> Result<TextPaths, TextsError> {
  validate_leaf(name)?;
  let body = dir.join(name);
  if body.parent() != Some(dir) {
    return Err(TextsError::BadName);
  }
  Ok(TextPaths {
    name: name.to_string(),
    sidecar: dir.join(sidecar_name(name)),
    body,
  })
}

fn unique_name(
  dir: &Path,
  code: &str,
  title: &str,
  extension: &str,
  own_names: &HashSet<String>,
) -> Result<String, TextsError> {
  let slug = slug(title);
  for index in 1..1000 {
    let stem = if index == 1 {
      format!("{code}-{slug}")
    } else {
      format!("{code}-{slug}-{index}")
    };
    if reserved_stem(&stem) {
      continue;
    }
    let name = format!("{stem}.{extension}");
    if name.len() > 180 {
      return Err(TextsError::BadName);
    }
    if stem_taken(dir, &stem, own_names) {
      continue;
    }
    validate_leaf(&name)?;
    return Ok(name);
  }
  Err(TextsError::BadName)
}

fn stem_taken(dir: &Path, stem: &str, own_names: &HashSet<String>) -> bool {
  for extension in ["md", "txt", "json"] {
    let name = format!("{stem}.{extension}");
    if own_names.contains(&name) {
      continue;
    }
    if dir.join(&name).exists() {
      return true;
    }
  }
  false
}

fn write_leaf(path: &Path, bytes: &[u8]) -> Result<(), TextsError> {
  let Some(name) = path.file_name().and_then(|part| part.to_str()) else {
    return Err(TextsError::BadName);
  };
  let tmp = path.with_file_name(format!(".{name}.tmp"));
  fs::write(&tmp, bytes).map_err(|error| TextsError::Io(error.to_string()))?;
  if fs::rename(&tmp, path).is_ok() {
    return Ok(());
  }
  // Windows refuses to rename over a file that is already there. Copying
  // leaves the previous bytes in place when the copy itself fails.
  let copied = fs::copy(&tmp, path);
  let _ = fs::remove_file(&tmp);
  copied
    .map(|_| ())
    .map_err(|error| TextsError::Io(error.to_string()))
}

fn remove_leaf(dir: &Path, name: &str) -> Result<(), TextsError> {
  validate_leaf(name)?;
  let path = dir.join(name);
  if path.parent() != Some(dir) {
    return Err(TextsError::BadName);
  }
  let canon_dir = match dir.canonicalize() {
    Ok(path) => path,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(error) => return Err(TextsError::Io(error.to_string())),
  };
  let canon = match path.canonicalize() {
    Ok(path) => path,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(error) => return Err(TextsError::Io(error.to_string())),
  };
  if symlink_metadata_is_link(&path) {
    return Err(TextsError::BadName);
  }
  let parent = canon.parent().ok_or(TextsError::BadName)?;
  if !paths_equal(parent, &canon_dir) || !canon.is_file() {
    return Err(TextsError::BadName);
  }
  fs::remove_file(&canon).map_err(|error| TextsError::Io(error.to_string()))
}

fn symlink_metadata_is_link(path: &Path) -> bool {
  fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

fn validate_id(id: &str) -> Result<(), TextsError> {
  if id.is_empty() || id.len() > 200 || id.trim().is_empty() {
    return Err(TextsError::BadName);
  }
  if id.contains(['/', '\\', '\0']) || id == "." || id == ".." || id.starts_with('.') {
    return Err(TextsError::BadName);
  }
  if id.chars().any(|ch| ch.is_control()) {
    return Err(TextsError::BadName);
  }
  Ok(())
}

fn validate_leaf(name: &str) -> Result<(), TextsError> {
  if name.is_empty() || name.len() > 180 {
    return Err(TextsError::BadName);
  }
  if name.contains(['/', '\\', '\0']) || name.starts_with('.') || name == "." || name == ".." {
    return Err(TextsError::BadName);
  }
  if Path::new(name).components().count() != 1 {
    return Err(TextsError::BadName);
  }
  Ok(())
}

fn normalize_code(code: &str) -> Result<String, TextsError> {
  let code = code.trim();
  if !is_display_code(code) {
    return Err(TextsError::BadName);
  }
  Ok(code.to_string())
}

fn normalize_title(title: &str) -> String {
  let clean = title.split_whitespace().collect::<Vec<_>>().join(" ");
  if clean.is_empty() {
    return "Untitled".to_string();
  }
  if clean.chars().count() <= 180 {
    return clean;
  }
  let trimmed = clean.chars().take(179).collect::<String>();
  format!("{trimmed}…")
}

fn normalize_extension(extension: &str) -> Result<String, TextsError> {
  let clean = extension.trim().trim_start_matches('.').to_ascii_lowercase();
  if clean.is_empty() {
    return Ok("md".to_string());
  }
  if TEXT_EXTENSIONS.contains(&clean.as_str()) {
    Ok(clean)
  } else {
    Err(TextsError::BadName)
  }
}

fn stored_created_at(value: &Value, existing: &[ListedText]) -> Value {
  if !value.is_null() && !(value.as_str().is_some_and(|text| text.trim().is_empty())) {
    return value.clone();
  }
  if let Some(text) = existing.first() {
    if !text.created_at.is_null() {
      return text.created_at.clone();
    }
  }
  Value::from(now_ms())
}

fn read_sidecar(path: &Path) -> Option<Sidecar> {
  let bytes = fs::read(path).ok()?;
  serde_json::from_slice(&bytes).ok()
}

fn sidecar_name(text_name: &str) -> String {
  format!("{}.json", file_stem(text_name))
}

fn file_stem(name: &str) -> String {
  match name.rsplit_once('.') {
    Some((stem, ext)) if !stem.is_empty() && (text_extension(name).is_some() || ext.eq_ignore_ascii_case("json")) => {
      stem.to_string()
    }
    _ => name.to_string(),
  }
}

fn text_extension(name: &str) -> Option<String> {
  let (_, ext) = name.rsplit_once('.')?;
  let ext = ext.to_ascii_lowercase();
  if TEXT_EXTENSIONS.contains(&ext.as_str()) {
    Some(ext)
  } else {
    None
  }
}

fn is_sidecar_name(name: &str) -> bool {
  name.to_ascii_lowercase().ends_with(".json") && !name.starts_with('.')
}

fn is_display_code(value: &str) -> bool {
  let mut chars = value.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  if !first.is_ascii_alphabetic() || value.len() > 16 {
    return false;
  }
  let rest: Vec<char> = chars.collect();
  !rest.is_empty() && rest.iter().all(|ch| ch.is_ascii_digit())
}

fn title_and_code_from_stem(stem: &str) -> (String, String) {
  let (code, rest) = split_code(stem);
  let spaced = rest.replace(['-', '_'], " ");
  let title = title_case(spaced.trim());
  let title = if title.is_empty() {
    "Untitled".to_string()
  } else {
    title
  };
  (code, clamp_title(title))
}

fn split_code(stem: &str) -> (String, &str) {
  let (head, tail) = match stem.split_once('-') {
    Some((head, tail)) => (head, tail),
    None => (stem, ""),
  };
  if is_display_code(head) {
    (head.to_string(), tail)
  } else {
    (String::new(), stem)
  }
}

fn title_case(raw: &str) -> String {
  let lower = raw.to_lowercase();
  let mut out = String::new();
  for (index, word) in lower.split_whitespace().enumerate() {
    if index > 0 {
      out.push(' ');
    }
    if index > 0 && SMALL_WORDS.contains(&word) {
      out.push_str(word);
      continue;
    }
    let mut chars = word.chars();
    if let Some(first) = chars.next() {
      for ch in first.to_uppercase() {
        out.push(ch);
      }
      out.push_str(chars.as_str());
    }
  }
  out
}

fn clamp_title(title: String) -> String {
  if title.chars().count() <= 180 {
    return title;
  }
  let trimmed = title.chars().take(179).collect::<String>();
  format!("{trimmed}…")
}

fn slug(title: &str) -> String {
  let mut out = String::new();
  let mut hyphen = false;
  for ch in title.chars() {
    if out.len() >= 80 {
      break;
    }
    if ch.is_ascii_alphanumeric() {
      out.push(ch.to_ascii_lowercase());
      hyphen = false;
      continue;
    }
    if ch.is_alphanumeric() {
      for lower in ch.to_lowercase() {
        if out.len() >= 80 {
          break;
        }
        out.push(lower);
      }
      hyphen = false;
      continue;
    }
    if !out.is_empty() && !hyphen {
      out.push('-');
      hyphen = true;
    }
  }
  while out.ends_with('-') {
    out.pop();
  }
  if out.is_empty() {
    "untitled".to_string()
  } else {
    out
  }
}

fn reserved_stem(stem: &str) -> bool {
  let head = stem.split('.').next().unwrap_or(stem);
  matches!(
    head.to_ascii_uppercase().as_str(),
    "CON"
      | "PRN"
      | "AUX"
      | "NUL"
      | "COM1"
      | "COM2"
      | "COM3"
      | "COM4"
      | "COM5"
      | "COM6"
      | "COM7"
      | "COM8"
      | "COM9"
      | "LPT1"
      | "LPT2"
      | "LPT3"
      | "LPT4"
      | "LPT5"
      | "LPT6"
      | "LPT7"
      | "LPT8"
      | "LPT9"
  )
}

/// Same file name, same id, across restarts. The hash is the file name only,
/// so an edit of the script does not detach takes. A rename with no sidecar
/// is a different file and gets a different id.
pub fn stable_file_id(name: &str) -> String {
  let mut hash: u64 = 0xcbf29ce484222325;
  for byte in name.as_bytes() {
    hash ^= u64::from(*byte);
    hash = hash.wrapping_mul(0x100000001b3);
  }
  format!("file-{hash:016x}")
}

fn created_millis(value: &Value) -> i64 {
  match value {
    Value::Number(number) => number.as_i64().unwrap_or(0),
    Value::String(text) => DateTime::parse_from_rfc3339(text)
      .map(|parsed| parsed.timestamp_millis())
      .unwrap_or(0),
    _ => 0,
  }
}

fn now_ms() -> i64 {
  system_time_ms(SystemTime::now())
}

fn system_time_ms(time: SystemTime) -> i64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as i64)
    .unwrap_or(0)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
  if left == right {
    return true;
  }
  cfg!(windows) && left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

fn path_is_hidden(path: &Path) -> bool {
  path.components().any(|component| match component {
    std::path::Component::Normal(part) => part.to_string_lossy().starts_with('.'),
    _ => false,
  })
}

fn legacy_texts_dir(app: &AppHandle) -> Result<PathBuf, TextsError> {
  let documents = app.path().document_dir().map_err(|error| {
    TextsError::Io(format!("could not find the Documents folder: {error}"))
  })?;
  Ok(documents.join("Teleprompter").join("texts"))
}

fn library_config(app: &AppHandle) -> Result<PathBuf, TextsError> {
  Ok(app.path().app_data_dir().map_err(|e| TextsError::Io(e.to_string()))?.join("text-library.json"))
}

#[tauri::command(async)]
pub fn texts_folder(app: AppHandle) -> Result<Option<String>, TextsError> {
  let path = library_config(&app)?;
  match fs::read(&path) {
    Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| TextsError::Io(e.to_string())),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(TextsError::Io(e.to_string())),
  }
}

fn texts_dir(app: &AppHandle) -> Result<PathBuf, TextsError> {
  let path = texts_folder(app.clone())?.ok_or_else(|| TextsError::Io("Choose a library folder first.".into()))?;
  let dir = PathBuf::from(path);
  // Never recreate a missing selected folder: it may be a disconnected drive.
  fs::read_dir(&dir).map_err(|e| TextsError::Io(e.to_string()))?;
  Ok(dir)
}

#[tauri::command(async)]
pub fn texts_set_folder(app: AppHandle, path: String) -> Result<(), TextsError> {
  let dir = PathBuf::from(&path);
  if !dir.is_absolute() || !app.fs_scope().is_allowed(&dir) {
    return Err(TextsError::Io("Choose this folder using Folder first.".into()));
  }
  fs::read_dir(&dir).map_err(|e| TextsError::Io(e.to_string()))?;
  let config = library_config(&app)?;
  fs::create_dir_all(config.parent().unwrap()).map_err(|e| TextsError::Io(e.to_string()))?;
  write_leaf(&config, &serde_json::to_vec(&path).map_err(|e| TextsError::Io(e.to_string()))?)
}

#[tauri::command(async)]
pub fn texts_legacy_list(app: AppHandle) -> Result<Vec<ListedText>, TextsError> {
  scan_texts(&legacy_texts_dir(&app)?)
}

pub fn spawn_texts_watch(app: AppHandle) {
  let built = std::thread::Builder::new()
    .name("teleprompter-texts".into())
    .spawn(move || {
      if let Err(error) = watch_texts(app) {
        log::warn!("could not watch texts: {error}");
      }
    });
  if let Err(error) = built {
    log::warn!("could not start the texts watcher: {error}");
  }
}

fn watch_texts(app: AppHandle) -> Result<(), String> {
  let mut watched: Option<PathBuf> = None;
  let (tx, rx) = std::sync::mpsc::channel();
  let mut watcher = notify::recommended_watcher(move |result| {
    let _ = tx.send(result);
  })
  .map_err(|error| error.to_string())?;
  let mut debounce = ChangeDebounce::new(TEXTS_WATCH_DEBOUNCE);
  let mut checked = Instant::now() - Duration::from_secs(1);
  loop {
    if checked.elapsed() >= Duration::from_millis(500) {
      checked = Instant::now();
      let next = texts_dir(&app).ok();
      if next != watched {
        if let Some(old) = watched.take() { let _ = watcher.unwatch(&old); }
        if let Some(dir) = next {
          if watcher.watch(&dir, notify::RecursiveMode::NonRecursive).is_ok() { watched = Some(dir); }
        }
        debounce.note(Instant::now());
      }
    }
    match rx.recv_timeout(Duration::from_millis(50)) {
      Ok(Ok(event)) => {
        if event_touches_text(&event.paths) {
          debounce.note(Instant::now());
        }
      }
      Ok(Err(_)) => debounce.note(Instant::now()),
      Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
    }
    if debounce.poll(Instant::now()) {
      let _ = app.emit("texts://changed", TextsChanged {});
    }
  }
  Ok(())
}

#[tauri::command(async)]
pub fn texts_list(app: AppHandle) -> Result<Vec<ListedText>, TextsError> {
  let dir = texts_dir(&app)?;
  scan_texts(&dir)
}

#[tauri::command(async)]
pub fn texts_read(app: AppHandle, id: String) -> Result<ListedText, TextsError> {
  read_text(&texts_dir(&app)?, &id)
}

#[tauri::command(async)]
pub fn texts_write(app: AppHandle, text: TextDraft) -> Result<ListedText, TextsError> {
  write_text(&texts_dir(&app)?, &text)
}

#[tauri::command(async)]
pub fn texts_delete(app: AppHandle, id: String) -> Result<(), TextsError> {
  delete_text(&texts_dir(&app)?, &id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU64, Ordering};

  fn temp_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
      "teleprompter-texts-{}-{}",
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

  fn draft(id: &str, code: &str, title: &str, body: &str) -> TextDraft {
    TextDraft {
      id: id.to_string(),
      code: code.to_string(),
      title: title.to_string(),
      body: body.to_string(),
      created_at: serde_json::json!("2026-11-23T04:50:00.000Z"),
      updated_at: None,
      extension: "md".to_string(),
    }
  }

  #[test]
  fn scan_reads_the_sidecar_and_skips_hidden_and_other_files() {
    let dir = TempDir::new();
    fs::write(dir.path().join("U1-market-notes.md"), "Apples\n\nLine").unwrap();
    let sidecar = serde_json::json!({
      "version": 1,
      "id": "import-9",
      "code": "U1",
      "title": "Market Notes",
      "createdAt": "2026-11-23T04:50:00.000Z"
    });
    fs::write(
      dir.path().join("U1-market-notes.json"),
      serde_json::to_vec(&sidecar).unwrap(),
    )
    .unwrap();
    fs::write(dir.path().join("E01-take.m4a"), b"audio").unwrap();
    fs::write(dir.path().join("E01-take.json"), b"{}").unwrap();
    fs::write(dir.path().join(".secret.md"), b"hidden").unwrap();
    let nested = dir.path().join(".sessions");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("note.md"), b"nope").unwrap();

    let texts = scan_texts(dir.path()).unwrap();
    assert_eq!(texts.len(), 1);
    let text = &texts[0];
    assert_eq!(text.id, "import-9");
    assert_eq!(text.code, "U1");
    assert_eq!(text.title, "Market Notes");
    assert_eq!(text.body, "Apples\n\nLine");
    assert_eq!(text.extension, "md");
    assert!(text.sidecar);
    assert_eq!(text.created_at, serde_json::json!("2026-11-23T04:50:00.000Z"));
    assert_eq!(text.updated_at, None);
    assert_eq!(Path::new(&text.path).parent(), Some(dir.path()));
    assert!(dir.path().join("E01-take.m4a").exists());
  }

  #[test]
  fn legacy_essay_keeps_reading_id_and_title_when_edited() {
    let dir = TempDir::new();
    let name = "E01-original.txt";
    fs::write(dir.path().join(name), "MY TITLE\r\n\r\nBody\r\n").unwrap();
    let before = read_text(dir.path(), name).unwrap();
    assert_eq!(before.title, "My Title");
    assert_eq!(before.body, "Body");
    assert_eq!(before.code, "E01");
    let after = write_text(dir.path(), &draft(name, "E01", "Edited Title", "New body")).unwrap();
    assert_eq!(after.id, name);
    assert_eq!(after.title, "Edited Title");
    assert_eq!(after.body, "New body");
    assert_eq!(scan_texts(dir.path()).unwrap().len(), 1);
  }

  #[test]
  fn unreadable_text_is_an_error_instead_of_an_empty_script() {
    let dir = TempDir::new();
    fs::write(dir.path().join("broken.txt"), [0xff, 0xfe]).unwrap();
    assert!(scan_texts(dir.path()).is_err());
  }

  #[test]
  fn a_file_without_metadata_gets_a_stable_id_and_a_title_from_its_name() {
    let dir = TempDir::new();
    fs::write(dir.path().join("market-notes.md"), "hello").unwrap();
    fs::write(dir.path().join("U3-daily_log.txt"), "body\r\nline").unwrap();
    fs::write(dir.path().join("U3-daily_log.json"), b"{").unwrap();

    let first = scan_texts(dir.path()).unwrap();
    let second = scan_texts(dir.path()).unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first, second);

    let notes = first.iter().find(|text| text.name == "market-notes.md").unwrap();
    assert!(!notes.sidecar);
    assert_eq!(notes.id, stable_file_id("market-notes.md"));
    assert!(notes.id.starts_with("file-"));
    assert_eq!(notes.id.len(), "file-".len() + 16);
    assert_eq!(notes.title, "Market Notes");
    assert_eq!(notes.code, "");
    assert_eq!(notes.body, "hello");
    assert_eq!(notes.extension, "md");
    assert!(notes.created_at.as_i64().unwrap() > 0);

    let daily = first.iter().find(|text| text.name == "U3-daily_log.txt").unwrap();
    assert!(!daily.sidecar);
    assert_eq!(daily.code, "U3");
    assert_eq!(daily.title, "Daily Log");
    assert_eq!(daily.body, "body\r\nline");
    assert_eq!(daily.extension, "txt");
    assert_eq!(daily.id, stable_file_id("U3-daily_log.txt"));
    assert_ne!(notes.id, daily.id);
    assert_eq!(stable_file_id("notes.md"), stable_file_id("notes.md"));
    assert_ne!(stable_file_id("notes.md"), stable_file_id("Notes.md"));
  }

  #[test]
  fn write_reads_back_the_same_id_and_renames_when_the_title_changes() {
    let dir = TempDir::new();
    let mut first = draft("import-9", "U1", "Market Notes", "Apples\n\nLine");
    first.updated_at = Some(serde_json::json!(1_700_000_000_000_i64));
    let written = write_text(dir.path(), &first).unwrap();
    assert_eq!(written.id, "import-9");
    assert_eq!(written.name, "U1-market-notes.md");
    assert_eq!(written.body, "Apples\n\nLine");
    assert_eq!(written.title, "Market Notes");
    assert_eq!(written.created_at, serde_json::json!("2026-11-23T04:50:00.000Z"));
    assert_eq!(written.updated_at, Some(serde_json::json!(1_700_000_000_000_i64)));
    assert!(written.sidecar);

    let read = read_text(dir.path(), "import-9").unwrap();
    assert_eq!(read, written);

    let mut edited = first.clone();
    edited.body = "Changed".to_string();
    let updated = write_text(dir.path(), &edited).unwrap();
    assert_eq!(updated.name, "U1-market-notes.md");
    assert_eq!(updated.body, "Changed");
    assert_eq!(updated.id, "import-9");
    assert_eq!(scan_texts(dir.path()).unwrap().len(), 1);

    let mut renamed = draft("import-9", "U1", "Ghi chú", "Xin chào");
    renamed.extension = "txt".to_string();
    renamed.created_at = serde_json::json!("2026-11-23T04:50:00.000Z");
    let next = write_text(dir.path(), &renamed).unwrap();
    assert_eq!(next.id, "import-9");
    assert_eq!(next.name, "U1-ghi-chú.txt");
    assert_eq!(next.body, "Xin chào");
    assert_eq!(next.extension, "txt");
    assert!(!dir.path().join("U1-market-notes.md").exists());
    assert!(!dir.path().join("U1-market-notes.json").exists());
    assert!(dir.path().join("U1-ghi-chú.txt").exists());
    assert!(dir.path().join("U1-ghi-chú.json").exists());
  }

  #[test]
  fn write_keeps_a_taken_name_and_a_path_inside_the_folder() {
    let dir = TempDir::new();
    fs::write(dir.path().join("U1-market-notes.md"), "other").unwrap();
    fs::write(
      dir.path().join("U1-market-notes.json"),
      br#"{"version":1,"id":"other-id","code":"U1","title":"Other","createdAt":1}"#,
    )
    .unwrap();
    let written = write_text(dir.path(), &draft("import-9", "U1", "Market Notes", "body")).unwrap();
    assert_eq!(written.name, "U1-market-notes-2.md");
    assert_eq!(written.id, "import-9");
    assert_eq!(Path::new(&written.path).parent(), Some(dir.path()));
    assert!(dir.path().join("U1-market-notes.md").exists());
    assert_eq!(fs::read_to_string(dir.path().join("U1-market-notes.md")).unwrap(), "other");

    let escaped = write_text(dir.path(), &draft("import-11", "U4", "../secret", "body")).unwrap();
    assert_eq!(escaped.name, "U4-secret.md");
    assert_eq!(Path::new(&escaped.path).parent(), Some(dir.path()));
    let outside = dir.path().parent().unwrap().join("secret.md");
    assert!(!outside.exists());
    assert!(matches!(read_text(dir.path(), "missing-id"), Err(TextsError::NotFound)));
  }

  #[test]
  fn delete_removes_the_text_and_the_sidecar_only() {
    let dir = TempDir::new();
    write_text(dir.path(), &draft("import-9", "U1", "Market Notes", "Apples")).unwrap();
    write_text(dir.path(), &draft("import-10", "U2", "Second", "Keep")).unwrap();
    fs::write(dir.path().join("E01-take.m4a"), b"audio").unwrap();
    fs::write(dir.path().join("E01-take.json"), b"{}").unwrap();

    delete_text(dir.path(), "import-9").unwrap();
    assert!(!dir.path().join("U1-market-notes.md").exists());
    assert!(!dir.path().join("U1-market-notes.json").exists());
    assert_eq!(fs::read_to_string(dir.path().join("U2-second.md")).unwrap(), "Keep");
    assert_eq!(fs::read(dir.path().join("E01-take.m4a")).unwrap(), b"audio");
    assert_eq!(fs::read(dir.path().join("E01-take.json")).unwrap(), b"{}");

    delete_text(dir.path(), "import-9").unwrap();
    assert!(matches!(delete_text(dir.path(), "../secret"), Err(TextsError::BadName)));
    assert!(matches!(delete_text(dir.path(), "..\\secret"), Err(TextsError::BadName)));
    assert!(matches!(delete_text(dir.path(), "import-9/../../x"), Err(TextsError::BadName)));
    assert!(matches!(read_text(dir.path(), "../secret"), Err(TextsError::BadName)));
    assert!(matches!(
      write_text(dir.path(), &draft("../import", "U1", "Title", "body")),
      Err(TextsError::BadName)
    ));
  }

  #[test]
  fn delete_of_a_dropped_file_uses_its_stable_id() {
    let dir = TempDir::new();
    fs::write(dir.path().join("notes.md"), "hello").unwrap();
    let id = stable_file_id("notes.md");
    assert_eq!(read_text(dir.path(), &id).unwrap().body, "hello");
    delete_text(dir.path(), &id).unwrap();
    assert!(!dir.path().join("notes.md").exists());
    assert!(scan_texts(dir.path()).unwrap().is_empty());
  }

  #[test]
  fn a_missing_folder_lists_nothing_and_an_oversize_write_is_refused() {
    let dir = TempDir::new();
    let missing = dir.path().join("nope");
    assert!(scan_texts(&missing).unwrap().is_empty());
    let mut huge = draft("import-9", "U1", "Big", "");
    huge.body = "a".repeat(MAX_TEXT_BYTES + 1);
    assert!(matches!(write_text(dir.path(), &huge), Err(TextsError::TooLarge)));
    assert!(scan_texts(dir.path()).unwrap().is_empty());
  }

  #[test]
  fn texts_sort_by_created_time_then_name() {
    let dir = TempDir::new();
    let mut later = draft("import-2", "U2", "Later", "b");
    later.created_at = serde_json::json!("2026-11-24T00:00:00.000Z");
    let mut earlier = draft("import-1", "U1", "Earlier", "a");
    earlier.created_at = serde_json::json!(1_700_000_000_000_i64);
    write_text(dir.path(), &later).unwrap();
    write_text(dir.path(), &earlier).unwrap();
    let texts = scan_texts(dir.path()).unwrap();
    assert_eq!(texts[0].id, "import-1");
    assert_eq!(texts[1].id, "import-2");
  }

  #[cfg(unix)]
  #[test]
  fn delete_and_read_refuse_a_symlink_that_leaves_the_folder() {
    let dir = TempDir::new();
    let outside = TempDir::new();
    let secret = outside.path().join("secret.md");
    fs::write(&secret, b"secret-bytes").unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("link.md")).unwrap();
    let listed = scan_texts(dir.path()).unwrap();
    assert!(listed.iter().all(|text| text.name != "link.md"));
    assert!(matches!(
      remove_leaf(dir.path(), "link.md"),
      Err(TextsError::BadName)
    ));
    assert_eq!(fs::read(&secret).unwrap(), b"secret-bytes");
  }

  #[test]
  fn hidden_paths_and_unrelated_files_do_not_count_as_text_changes() {
    assert!(!event_touches_text(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/texts/.U1-notes.md.tmp"
    )]));
    assert!(event_touches_text(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/texts/U1-notes.md"
    )]));
    assert!(event_touches_text(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/texts/U1-notes.json"
    )]));
    assert!(!event_touches_text(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/texts/E01-take.m4a"
    )]));
    assert!(event_touches_text(&[PathBuf::from(
      "/home/me/Documents/Teleprompter/texts"
    )]));
    assert!(event_touches_text(&[]));
  }
}
