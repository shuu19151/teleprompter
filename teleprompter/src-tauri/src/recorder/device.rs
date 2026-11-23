//! Default input device and stream-config negotiation.
//!
//! Device selection comes later. The choice itself is a pure function of the
//! ranges the host reports, so a named device can reuse [`choose_config`]
//! without changing the capture or writer path.

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{SampleFormat, StreamConfig, SupportedStreamConfigRange};

use super::{RecorderError, OUTPUT_SAMPLE_RATE};

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

pub struct OpenedInput {
  pub device: cpal::Device,
  pub device_name: String,
  pub capture_rate: u32,
  pub channels: u16,
  pub format: SampleFormatKind,
  pub stream_config: StreamConfig,
}

pub fn open_default() -> Result<OpenedInput, RecorderError> {
  let host = cpal::default_host();
  let device = host
    .default_input_device()
    .ok_or(RecorderError::NoDevice)?;
  let device_name = device_label(&device);
  let (capture_rate, channels, format, stream_config) = negotiate(&device)?;
  log::info!(
    "microphone {device_name}: {capture_rate} Hz, {channels} ch, {format:?}"
  );
  Ok(OpenedInput {
    device,
    device_name,
    capture_rate,
    channels,
    format,
    stream_config,
  })
}

fn device_label(device: &cpal::Device) -> String {
  let name = device.to_string();
  if name.trim().is_empty() {
    "Default microphone".to_string()
  } else {
    name
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
}
