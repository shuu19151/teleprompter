//! Input devices and stream-config negotiation.
//!
//! Device ids come from cpal (`alsa:hw:0,0`, `wasapi:{…}.{guid}`) so a saved
//! choice survives re-enumeration. Matching a saved id, picking one channel
//! or down-mixing, and noticing that the default device changed are pure
//! functions. Opening a device is the only part that talks to the host.

use std::collections::BTreeSet;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{SampleFormat, StreamConfig, SupportedStreamConfigRange};
use serde::{Deserialize, Serialize};

use super::{RecorderError, OUTPUT_SAMPLE_RATE};

/// How often the idle watcher may look at the host. A few times a second at most.
pub const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(400);

/// Sample formats the capture callback knows how to turn into `f32`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleFormatKind {
  F32,
  I16,
  U16,
}

impl SampleFormatKind {
  pub fn from_cpal(format: SampleFormat) -> Option<Self> {
    match format {
      SampleFormat::F32 => Some(Self::F32),
      SampleFormat::I16 => Some(Self::I16),
      SampleFormat::U16 => Some(Self::U16),
      _ => None,
    }
  }
}

/// One supported (channels, rate range, format) triple, detached from cpal
/// so negotiation can be tested without a microphone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigRange {
  pub channels: u16,
  pub min_rate: u32,
  pub max_rate: u32,
  pub format: SampleFormatKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChosenConfig {
  pub sample_rate: u32,
  pub channels: u16,
  pub format: SampleFormatKind,
}

/// Prefer 48 kHz, then fewer channels (mono first), then `f32` over `i16`
/// over `u16`. A rate that is not 48 kHz is still accepted; the writer
/// resamples it.
pub fn choose_config(ranges: &[ConfigRange], target_rate: u32) -> Option<ChosenConfig> {
  let mut best: Option<(i64, ChosenConfig)> = None;
  for range in ranges {
    if range.channels == 0 || range.min_rate == 0 || range.max_rate < range.min_rate {
      continue;
    }
    let sample_rate = if target_rate >= range.min_rate && target_rate <= range.max_rate {
      target_rate
    } else if target_rate < range.min_rate {
      range.min_rate
    } else {
      range.max_rate
    };
    let rate_distance = i64::from(sample_rate).abs_diff(i64::from(target_rate)) as i64;
    let format_rank = match range.format {
      SampleFormatKind::F32 => 0,
      SampleFormatKind::I16 => 1,
      SampleFormatKind::U16 => 2,
    };
    let channel_rank = if range.channels == 1 {
      0
    } else {
      1_000 + i64::from(range.channels)
    };
    let score = rate_distance * 1_000_000 + channel_rank * 10 + format_rank;
    let chosen = ChosenConfig {
      sample_rate,
      channels: range.channels,
      format: range.format,
    };
    match best {
      Some((best_score, _)) if score >= best_score => {}
      _ => best = Some((score, chosen)),
    }
  }
  best.map(|(_, chosen)| chosen)
}

/// One input the page can put in the microphone menu.
///
/// `id` is the cpal device id, not the position in the host's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
  pub id: String,
  pub name: String,
  pub is_default: bool,
  pub channels: u16,
  pub sample_rates: Vec<u32>,
}

/// Which listed device `recorder_start` will open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevicePick<'a> {
  /// The requested id was in the list.
  Requested(&'a InputDevice),
  /// No id was given, or the id was missing and the default is used instead.
  Default(&'a InputDevice),
}

impl<'a> DevicePick<'a> {
  pub fn device(self) -> &'a InputDevice {
    match self {
      Self::Requested(device) | Self::Default(device) => device,
    }
  }
}

/// Why capture cannot continue on the device that was opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceLoss {
  Stream,
  Missing,
}

pub fn normalize_device_id(device_id: Option<&str>) -> Option<&str> {
  device_id.map(str::trim).filter(|id| !id.is_empty())
}

/// Resolve the device a take should open.
///
/// An empty id uses the default. An id that is not in `devices` also uses the
/// default. [`RecorderError::DeviceMissing`] is only returned when that
/// fallback has no device left to open. [`RecorderError::NoDevice`] is the
/// same situation when the caller did not name a device.
pub fn match_device<'a>(
  devices: &'a [InputDevice],
  device_id: Option<&str>,
) -> Result<DevicePick<'a>, RecorderError> {
  let Some(id) = normalize_device_id(device_id) else {
    return default_device(devices)
      .map(DevicePick::Default)
      .ok_or(RecorderError::NoDevice);
  };
  if let Some(found) = devices.iter().find(|device| device.id == id) {
    return Ok(DevicePick::Requested(found));
  }
  default_device(devices)
    .map(DevicePick::Default)
    .ok_or(RecorderError::DeviceMissing)
}

fn default_device(devices: &[InputDevice]) -> Option<&InputDevice> {
  devices
    .iter()
    .find(|device| device.is_default)
    .or_else(|| devices.first())
}

/// `None` down-mixes every channel. `Some(index)` keeps that channel, 0-based.
pub fn validate_channel(channels: u16, channel: Option<u16>) -> Result<Option<u16>, RecorderError> {
  match channel {
    None => Ok(None),
    Some(index) if channels > 0 && index < channels => Ok(Some(index)),
    Some(_) => Err(RecorderError::InvalidChannel),
  }
}

/// Boundary rates plus 48 kHz when a range includes it. Continuous ranges are
/// not expanded into every integer.
pub fn sample_rates_from(ranges: &[ConfigRange]) -> Vec<u32> {
  let mut rates = BTreeSet::new();
  for range in ranges {
    if !usable_range(range) {
      continue;
    }
    rates.insert(range.min_rate);
    rates.insert(range.max_rate);
    if OUTPUT_SAMPLE_RATE >= range.min_rate && OUTPUT_SAMPLE_RATE <= range.max_rate {
      rates.insert(OUTPUT_SAMPLE_RATE);
    }
  }
  rates.into_iter().collect()
}

pub fn channel_count(ranges: &[ConfigRange]) -> u16 {
  ranges
    .iter()
    .filter(|range| usable_range(range))
    .map(|range| range.channels)
    .max()
    .unwrap_or(0)
}

fn usable_range(range: &ConfigRange) -> bool {
  range.channels > 0 && range.min_rate > 0 && range.max_rate >= range.min_rate
}

/// True when the menu should refresh: a device appeared, left, or the default moved.
pub fn devices_changed(previous: &[InputDevice], next: &[InputDevice]) -> bool {
  previous != next
}

/// A stream error wins over a missing id. An empty id is not treated as missing,
/// so a take that never recorded a device id is left alone.
pub fn device_loss<S: AsRef<str>>(
  fault: bool,
  device_id: &str,
  present_ids: &[S],
) -> Option<DeviceLoss> {
  if fault {
    return Some(DeviceLoss::Stream);
  }
  if device_id.is_empty() {
    return None;
  }
  if present_ids.iter().any(|id| id.as_ref() == device_id) {
    None
  } else {
    Some(DeviceLoss::Missing)
  }
}

pub struct OpenedInput {
  pub device: cpal::Device,
  pub device_id: String,
  pub device_name: String,
  pub capture_rate: u32,
  pub channels: u16,
  /// `None` down-mixes. `Some` is the 0-based channel kept by the callback.
  pub channel: Option<u16>,
  pub format: SampleFormatKind,
  pub stream_config: StreamConfig,
}

pub fn list_inputs() -> Result<Vec<InputDevice>, RecorderError> {
  let host = cpal::default_host();
  let devices = host
    .input_devices()
    .map_err(|error| RecorderError::Capture(error.to_string()))?;
  let default_id = host
    .default_input_device()
    .and_then(|device| stable_id(&device).ok());
  let mut listed = Vec::new();
  let mut seen = BTreeSet::new();
  for device in devices {
    let Some(info) = describe_input(&device, default_id.as_deref()) else {
      continue;
    };
    if !seen.insert(info.id.clone()) {
      continue;
    }
    listed.push(info);
  }
  listed.sort_by(|left, right| {
    right
      .is_default
      .cmp(&left.is_default)
      .then_with(|| left.name.cmp(&right.name))
      .then_with(|| left.id.cmp(&right.id))
  });
  Ok(listed)
}

pub fn open_input(
  device_id: Option<&str>,
  channel: Option<u16>,
) -> Result<OpenedInput, RecorderError> {
  let listed = list_inputs()?;
  let pick = match_device(&listed, device_id)?;
  if matches!(pick, DevicePick::Default(_)) && normalize_device_id(device_id).is_some() {
    log::warn!(
      "microphone {} is not connected; using {}",
      normalize_device_id(device_id).unwrap_or(""),
      pick.device().name
    );
  }
  let chosen = pick.device();
  let parsed = chosen
    .id
    .parse::<cpal::DeviceId>()
    .map_err(|_| RecorderError::DeviceMissing)?;
  let host = cpal::default_host();
  let device = host
    .device_by_id(&parsed)
    .ok_or(RecorderError::DeviceMissing)?;
  let (capture_rate, channels, format, stream_config) = negotiate(&device)?;
  let channel = validate_channel(channels, channel)?;
  let device_name = if chosen.name.trim().is_empty() {
    device_label(&device)
  } else {
    chosen.name.clone()
  };
  log::info!(
    "microphone {device_name} ({}): {capture_rate} Hz, {channels} ch, {format:?}, channel {}",
    chosen.id,
    channel
      .map(|index| index.to_string())
      .unwrap_or_else(|| "downmix".to_string())
  );
  Ok(OpenedInput {
    device,
    device_id: chosen.id.clone(),
    device_name,
    capture_rate,
    channels,
    channel,
    format,
    stream_config,
  })
}

fn describe_input(device: &cpal::Device, default_id: Option<&str>) -> Option<InputDevice> {
  let id = stable_id(device).ok()?;
  let ranges = config_ranges(device);
  Some(InputDevice {
    is_default: default_id == Some(id.as_str()),
    name: device_label(device),
    channels: channel_count(&ranges),
    sample_rates: sample_rates_from(&ranges),
    id,
  })
}

fn stable_id(device: &cpal::Device) -> Result<String, RecorderError> {
  let id = device
    .id()
    .map_err(|error| RecorderError::Capture(error.to_string()))?;
  let text = id.to_string();
  if text.trim().is_empty() {
    return Err(RecorderError::Capture("the microphone has no id".into()));
  }
  Ok(text)
}

fn config_ranges(device: &cpal::Device) -> Vec<ConfigRange> {
  let ranges = match device.supported_input_configs() {
    Ok(configs) => configs.collect::<Vec<_>>(),
    Err(error) => {
      log::warn!("could not list microphone formats: {error}");
      return Vec::new();
    }
  };
  ranges
    .iter()
    .filter_map(|range| {
      Some(ConfigRange {
        channels: range.channels(),
        min_rate: range.min_sample_rate(),
        max_rate: range.max_sample_rate(),
        format: SampleFormatKind::from_cpal(range.sample_format())?,
      })
    })
    .collect()
}

fn device_label(device: &cpal::Device) -> String {
  let described = device
    .description()
    .ok()
    .map(|description| description.name().trim().to_string())
    .filter(|name| !name.is_empty());
  if let Some(name) = described {
    return name;
  }
  let fallback = device.to_string();
  if fallback.trim().is_empty() {
    "Default microphone".to_string()
  } else {
    fallback
  }
}

fn negotiate(
  device: &cpal::Device,
) -> Result<(u32, u16, SampleFormatKind, StreamConfig), RecorderError> {
  let ranges = match device.supported_input_configs() {
    Ok(configs) => configs.collect::<Vec<_>>(),
    Err(error) => {
      log::warn!("could not list microphone formats: {error}");
      Vec::new()
    }
  };
  if let Some(config) = select_range(&ranges) {
    return Ok(config);
  }
  let default = device
    .default_input_config()
    .map_err(|error| RecorderError::Capture(error.to_string()))?;
  config_from_supported(default)
}

fn select_range(
  ranges: &[SupportedStreamConfigRange],
) -> Option<(u32, u16, SampleFormatKind, StreamConfig)> {
  let described = ranges
    .iter()
    .filter_map(|range| {
      Some(ConfigRange {
        channels: range.channels(),
        min_rate: range.min_sample_rate(),
        max_rate: range.max_sample_rate(),
        format: SampleFormatKind::from_cpal(range.sample_format())?,
      })
    })
    .collect::<Vec<_>>();
  let chosen = choose_config(&described, OUTPUT_SAMPLE_RATE)?;
  let matched = ranges.iter().copied().find(|range| {
    SampleFormatKind::from_cpal(range.sample_format()) == Some(chosen.format)
      && range.channels() == chosen.channels
      && range.min_sample_rate() <= chosen.sample_rate
      && range.max_sample_rate() >= chosen.sample_rate
  })?;
  let supported = matched.try_with_sample_rate(chosen.sample_rate)?;
  config_from_supported(supported).ok()
}

fn config_from_supported(
  config: cpal::SupportedStreamConfig,
) -> Result<(u32, u16, SampleFormatKind, StreamConfig), RecorderError> {
  let format = SampleFormatKind::from_cpal(config.sample_format())
    .ok_or(RecorderError::UnsupportedFormat)?;
  let capture_rate = config.sample_rate();
  let channels = config.channels();
  if channels == 0 || capture_rate == 0 {
    return Err(RecorderError::UnsupportedFormat);
  }
  Ok((capture_rate, channels, format, config.config()))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn range(channels: u16, min_rate: u32, max_rate: u32, format: SampleFormatKind) -> ConfigRange {
    ConfigRange {
      channels,
      min_rate,
      max_rate,
      format,
    }
  }

  #[test]
  fn prefers_48k_mono_f32() {
    let ranges = [
      range(2, 44_100, 48_000, SampleFormatKind::I16),
      range(1, 44_100, 48_000, SampleFormatKind::I16),
      range(1, 8_000, 48_000, SampleFormatKind::F32),
      range(1, 8_000, 48_000, SampleFormatKind::U16),
    ];
    assert_eq!(
      choose_config(&ranges, OUTPUT_SAMPLE_RATE),
      Some(ChosenConfig {
        sample_rate: 48_000,
        channels: 1,
        format: SampleFormatKind::F32,
      })
    );
  }

  #[test]
  fn keeps_48k_when_mono_is_only_available_at_44k() {
    let ranges = [
      range(1, 44_100, 44_100, SampleFormatKind::F32),
      range(2, 48_000, 48_000, SampleFormatKind::I16),
    ];
    assert_eq!(
      choose_config(&ranges, OUTPUT_SAMPLE_RATE),
      Some(ChosenConfig {
        sample_rate: 48_000,
        channels: 2,
        format: SampleFormatKind::I16,
      })
    );
  }

  #[test]
  fn picks_the_nearest_rate_when_48k_is_missing() {
    let below = [range(1, 8_000, 16_000, SampleFormatKind::F32)];
    assert_eq!(choose_config(&below, 48_000).unwrap().sample_rate, 16_000);
    let above = [range(2, 96_000, 192_000, SampleFormatKind::I16)];
    assert_eq!(choose_config(&above, 48_000).unwrap().sample_rate, 96_000);
  }

  #[test]
  fn ignores_empty_ranges() {
    let ranges = [range(0, 48_000, 48_000, SampleFormatKind::F32)];
    assert_eq!(choose_config(&ranges, OUTPUT_SAMPLE_RATE), None);
  }

  fn device(id: &str, name: &str, is_default: bool, channels: u16) -> InputDevice {
    InputDevice {
      id: id.to_string(),
      name: name.to_string(),
      is_default,
      channels,
      sample_rates: vec![48_000],
    }
  }

  #[test]
  fn a_saved_id_matches_that_device_and_not_its_list_position() {
    let devices = [
      device("wasapi:{default}", "Laptop mic", true, 2),
      device("wasapi:{usb}", "USB mic", false, 1),
    ];
    let pick = match_device(&devices, Some("wasapi:{usb}")).unwrap();
    assert_eq!(pick, DevicePick::Requested(&devices[1]));
    assert_eq!(pick.device().name, "USB mic");
    assert_eq!(normalize_device_id(Some("  ")), None);
    assert_eq!(normalize_device_id(None), None);
  }

  #[test]
  fn a_missing_id_falls_back_to_the_default_device() {
    let devices = [
      device("wasapi:{usb}", "USB mic", false, 1),
      device("wasapi:{default}", "Laptop mic", true, 2),
    ];
    assert_eq!(
      match_device(&devices, None).unwrap(),
      DevicePick::Default(&devices[1])
    );
    assert_eq!(
      match_device(&devices, Some("")).unwrap(),
      DevicePick::Default(&devices[1])
    );
    assert_eq!(
      match_device(&devices, Some("wasapi:{gone}")).unwrap(),
      DevicePick::Default(&devices[1])
    );
    assert!(matches!(
      match_device(&[], Some("wasapi:{gone}")),
      Err(RecorderError::DeviceMissing)
    ));
    assert!(matches!(
      match_device(&[], None),
      Err(RecorderError::NoDevice)
    ));
  }

  #[test]
  fn an_unmarked_list_still_has_a_default_to_open() {
    let devices = [device("alsa:hw:1,0", "Only mic", false, 1)];
    assert_eq!(
      match_device(&devices, Some("alsa:hw:0,0")).unwrap(),
      DevicePick::Default(&devices[0])
    );
  }

  #[test]
  fn channel_zero_is_kept_and_an_extra_channel_is_rejected() {
    assert_eq!(validate_channel(2, None).unwrap(), None);
    assert_eq!(validate_channel(2, Some(0)).unwrap(), Some(0));
    assert_eq!(validate_channel(2, Some(1)).unwrap(), Some(1));
    assert!(matches!(
      validate_channel(2, Some(2)),
      Err(RecorderError::InvalidChannel)
    ));
    assert!(matches!(
      validate_channel(0, Some(0)),
      Err(RecorderError::InvalidChannel)
    ));
  }

  #[test]
  fn sample_rates_keep_the_edges_and_48k_when_the_range_includes_it() {
    let ranges = [
      range(2, 8_000, 48_000, SampleFormatKind::F32),
      range(1, 44_100, 44_100, SampleFormatKind::I16),
      range(0, 48_000, 48_000, SampleFormatKind::F32),
    ];
    assert_eq!(sample_rates_from(&ranges), vec![8_000, 44_100, 48_000]);
    assert_eq!(channel_count(&ranges), 2);
    assert_eq!(channel_count(&[]), 0);
  }

  #[test]
  fn a_default_change_is_a_device_list_change() {
    let before = [device("wasapi:{a}", "A", true, 1)];
    let after = [device("wasapi:{a}", "A", false, 1)];
    assert!(!devices_changed(&before, &before));
    assert!(devices_changed(&before, &after));
    assert!(devices_changed(&before, &[]));
  }

  #[test]
  fn device_loss_is_a_stream_fault_or_a_missing_id() {
    let present = ["wasapi:{usb}"];
    assert_eq!(
      device_loss(true, "wasapi:{usb}", &present),
      Some(DeviceLoss::Stream)
    );
    assert_eq!(
      device_loss(false, "wasapi:{usb}", &present),
      None
    );
    assert_eq!(
      device_loss(false, "wasapi:{usb}", &[] as &[&str]),
      Some(DeviceLoss::Missing)
    );
    assert_eq!(device_loss(false, "", &[] as &[&str]), None);
    assert!(DEVICE_POLL_INTERVAL >= std::time::Duration::from_millis(200));
    assert!(DEVICE_POLL_INTERVAL <= std::time::Duration::from_millis(500));
  }
}
