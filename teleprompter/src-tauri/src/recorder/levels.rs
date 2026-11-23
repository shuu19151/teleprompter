//! Peak and RMS math for the recorder meter.
//!
//! The capture callback never calls this. The writer thread folds already
//! converted mono `f32` samples into a 20 ms peak and a 50 ms meter.

use super::events::{MeterEvent, PeaksEvent};

/// One waveform bar. Matches the page, which stores a sample every 20 ms.
pub const PEAK_INTERVAL_MS: u32 = 20;
/// How often the writer publishes a meter and the peaks collected since the last one.
pub const METER_INTERVAL_MS: u32 = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct LevelTick {
  pub meter: Option<MeterEvent>,
  pub peaks: Option<PeaksEvent>,
}

pub struct LevelWindow {
  peak_frames: usize,
  meter_frames: usize,
  peak_buf: Vec<f32>,
  meter_buf: Vec<f32>,
  next_index: u64,
  pending_start: u64,
  pending: Vec<f32>,
  peaks: Vec<f32>,
  ready: Vec<LevelTick>,
}

impl LevelWindow {
  pub fn new(sample_rate: u32) -> Self {
    let peak_frames = frames_for_ms(sample_rate, PEAK_INTERVAL_MS);
    let meter_frames = frames_for_ms(sample_rate, METER_INTERVAL_MS);
    Self {
      peak_frames,
      meter_frames,
      peak_buf: Vec::with_capacity(peak_frames),
      meter_buf: Vec::with_capacity(meter_frames),
      next_index: 0,
      pending_start: 0,
      pending: Vec::new(),
      peaks: Vec::new(),
      ready: Vec::new(),
    }
  }

  pub fn push_sample(&mut self, sample: f32) {
    self.peak_buf.push(sample);
    self.meter_buf.push(sample);
    if self.peak_buf.len() >= self.peak_frames {
      self.close_peak();
    }
    if self.meter_buf.len() >= self.meter_frames {
      let tick = self.close_meter();
      self.ready.push(tick);
    }
  }

  pub fn push_slice(&mut self, samples: &[f32]) {
    for sample in samples {
      self.push_sample(*sample);
    }
  }

  pub fn drain(&mut self) -> Vec<LevelTick> {
    std::mem::take(&mut self.ready)
  }

  /// Emit a short tail so the end of a take still has a peak and a meter.
  pub fn finish(&mut self) -> Option<LevelTick> {
    if !self.peak_buf.is_empty() {
      self.close_peak();
    }
    let meter = if self.meter_buf.is_empty() {
      None
    } else {
      let meter = meter_event(&self.meter_buf);
      self.meter_buf.clear();
      Some(meter)
    };
    let peaks = self.take_pending();
    if meter.is_none() && peaks.is_none() {
      None
    } else {
      Some(LevelTick { meter, peaks })
    }
  }

  pub fn take_peaks(&mut self) -> Vec<f32> {
    std::mem::take(&mut self.peaks)
  }

  fn close_peak(&mut self) {
    let value = waveform_level(&self.peak_buf);
    self.peak_buf.clear();
    if self.pending.is_empty() {
      self.pending_start = self.next_index;
    }
    self.pending.push(value);
    self.peaks.push(value);
    self.next_index += 1;
  }

  fn close_meter(&mut self) -> LevelTick {
    let meter = meter_event(&self.meter_buf);
    self.meter_buf.clear();
    LevelTick {
      meter: Some(meter),
      peaks: self.take_pending(),
    }
  }

  fn take_pending(&mut self) -> Option<PeaksEvent> {
    if self.pending.is_empty() {
      return None;
    }
    let values = std::mem::take(&mut self.pending);
    let start_index = self.pending_start;
    Some(PeaksEvent {
      start_index,
      values,
    })
  }
}

pub fn frames_for_ms(sample_rate: u32, ms: u32) -> usize {
  let frames = u64::from(sample_rate.max(1)).saturating_mul(u64::from(ms)) / 1_000;
  usize::try_from(frames).unwrap_or(usize::MAX).max(1)
}

/// Largest absolute finite sample. Non-finite samples are ignored.
pub fn peak_abs(samples: &[f32]) -> f32 {
  let mut peak = 0.0f32;
  for sample in samples {
    if sample.is_finite() {
      peak = peak.max(sample.abs());
    }
  }
  peak
}

/// Root mean square of the finite samples. An empty window is silence.
pub fn rms(samples: &[f32]) -> f32 {
  let mut sum = 0.0f64;
  let mut count = 0u64;
  for sample in samples {
    if sample.is_finite() {
      let value = f64::from(*sample);
      sum += value * value;
      count += 1;
    }
  }
  if count == 0 {
    0.0
  } else {
    (sum / count as f64).sqrt() as f32
  }
}

/// True when a sample is non-finite or reaches full scale.
pub fn is_clipped(samples: &[f32]) -> bool {
  samples
    .iter()
    .any(|sample| !sample.is_finite() || sample.abs() >= 1.0)
}

/// Bar height stored by the live waveform: `min(1, max(peak, rms * 2.5))`.
pub fn waveform_level(samples: &[f32]) -> f32 {
  waveform_level_from(peak_abs(samples), rms(samples))
}

pub fn waveform_level_from(peak: f32, rms_value: f32) -> f32 {
  let peak = if peak.is_finite() { peak.abs() } else { 0.0 };
  let rms_value = if rms_value.is_finite() {
    rms_value.max(0.0)
  } else {
    0.0
  };
  peak.max(rms_value * 2.5).clamp(0.0, 1.0)
}

pub fn meter_event(samples: &[f32]) -> MeterEvent {
  MeterEvent {
    rms: rms(samples),
    peak: peak_abs(samples),
    clipped: is_clipped(samples),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn silence_and_empty_windows_are_zero() {
    assert_eq!(peak_abs(&[]), 0.0);
    assert_eq!(rms(&[]), 0.0);
    assert!(!is_clipped(&[]));
    assert_eq!(waveform_level(&[]), 0.0);
    let meter = meter_event(&[]);
    assert_eq!(meter.rms, 0.0);
    assert_eq!(meter.peak, 0.0);
    assert!(!meter.clipped);
  }

  #[test]
  fn a_full_scale_sample_is_clipped_and_the_bar_stays_at_one() {
    let samples = [0.0, 1.0, -1.2, 0.25];
    assert!(is_clipped(&samples));
    assert!((peak_abs(&samples) - 1.2).abs() < 1.0e-6);
    assert_eq!(waveform_level(&samples), 1.0);
    assert!(!is_clipped(&[0.25, -0.5, 0.999]));
  }

  #[test]
  fn non_finite_samples_do_not_move_the_rms() {
    assert!(is_clipped(&[f32::NAN]));
    assert_eq!(peak_abs(&[f32::NAN, -0.25]), 0.25);
    assert!((rms(&[f32::INFINITY, 0.5, -0.5]) - rms(&[0.5, -0.5])).abs() < 1.0e-6);
  }

  #[test]
  fn sine_peak_and_rms_match_the_amplitude() {
    let amplitude = 0.5f32;
    let samples = sine(48_000, 440.0, 48_000, amplitude);
    let peak = peak_abs(&samples);
    let power = rms(&samples);
    assert!(
      (peak - amplitude).abs() < 1.0e-3,
      "peak {peak} vs {amplitude}"
    );
    let expected = amplitude / std::f32::consts::SQRT_2;
    assert!(
      (power - expected).abs() < 1.0e-3,
      "rms {power} vs {expected}"
    );
    assert!(!is_clipped(&samples));
    let bar = waveform_level(&samples);
    let mixed = waveform_level_from(peak, power);
    assert!((bar - mixed).abs() < 1.0e-6);
    assert!(bar > amplitude && bar < 1.0);
  }

  #[test]
  fn a_constant_window_uses_the_waveform_mix() {
    let samples = [0.25f32; 64];
    let level = waveform_level(&samples);
    assert!((level - 0.625).abs() < 1.0e-5);
    let meter = meter_event(&samples);
    assert!((meter.peak - 0.25).abs() < 1.0e-6);
    assert!((meter.rms - 0.25).abs() < 1.0e-6);
    assert!(!meter.clipped);
  }

  #[test]
  fn peaks_land_every_20ms_and_meters_every_50ms() {
    let mut window = LevelWindow::new(48_000);
    assert_eq!(window.peak_frames, 960);
    assert_eq!(window.meter_frames, 2_400);
    let samples = vec![0.25f32; 4_800];
    window.push_slice(&samples);
    let ticks = window.drain();
    assert!(window.finish().is_none());
    assert_eq!(ticks.len(), 2);

    let first = ticks[0].peaks.as_ref().unwrap();
    assert_eq!(first.start_index, 0);
    assert_eq!(first.values.len(), 2);
    let second = ticks[1].peaks.as_ref().unwrap();
    assert_eq!(second.start_index, 2);
    assert_eq!(second.values.len(), 3);
    for value in first.values.iter().chain(second.values.iter()) {
      assert!((value - 0.625).abs() < 1.0e-5);
    }
    assert!((ticks[0].meter.as_ref().unwrap().rms - 0.25).abs() < 1.0e-6);
    assert!(!ticks[0].meter.as_ref().unwrap().clipped);
    assert!(!ticks[1].meter.as_ref().unwrap().clipped);
    assert_eq!(window.take_peaks().len(), 5);
  }

  #[test]
  fn a_short_tail_is_still_one_peak() {
    let mut window = LevelWindow::new(48_000);
    window.push_slice(&[0.5, -0.5, 0.5, -0.5]);
    assert!(window.drain().is_empty());
    let tail = window.finish().unwrap();
    let peaks = tail.peaks.unwrap();
    assert_eq!(peaks.start_index, 0);
    assert_eq!(peaks.values.len(), 1);
    assert!(peaks.values[0] > 0.5);
    assert!((tail.meter.unwrap().peak - 0.5).abs() < 1.0e-6);
    assert_eq!(window.take_peaks(), peaks.values);
  }

  fn sine(rate: u32, hz: f32, frames: usize, amplitude: f32) -> Vec<f32> {
    let step = std::f32::consts::TAU * hz / rate as f32;
    (0..frames)
      .map(|index| (step * index as f32).sin() * amplitude)
      .collect()
  }
}
