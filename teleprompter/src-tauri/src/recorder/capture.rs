//! Microphone capture.
//!
//! The cpal callback converts each frame to one mono `f32` and pushes it into
//! the ring. It does not lock, allocate, resample, or touch the filesystem.
//! A later peak meter can publish an atomic from this same callback.

#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
#[cfg(test)]
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, StreamTrait};
use rtrb::Producer;

use super::device::{OpenedInput, SampleFormatKind};
use super::RecorderError;

/// One second of mono frames, with a floor so a brief disk stall does not
/// drop the take. The capacity is the capture rate, not the 48 kHz file rate.
pub fn ring_capacity(capture_rate: u32) -> usize {
  (capture_rate as usize).clamp(8 * 1024, 192_000)
}

/// Down-mix interleaved frames to mono and push them.
///
/// Samples that do not fit are counted in `dropped` and are not written over
/// older frames. `missed` is published once per call so the callback does not
/// touch the atomic unless the ring overflowed.
pub fn push_frames<T: Copy>(
  data: &[T],
  channels: u16,
  producer: &mut Producer<f32>,
  dropped: &AtomicU64,
  to_f32: fn(T) -> f32,
) {
  let channels = usize::from(channels.max(1));
  if data.len() < channels {
    return;
  }
  let frames = data.len() / channels;
  let mut missed = 0u64;
  for frame in 0..frames {
    let start = frame * channels;
    let mut sum = 0.0f32;
    for sample in &data[start..start + channels] {
      sum += to_f32(*sample);
    }
    let mono = sum / channels as f32;
    if producer.push(mono).is_err() {
      missed += 1;
    }
  }
  if missed != 0 {
    dropped.fetch_add(missed, Ordering::Relaxed);
  }
}

pub fn f32_sample(sample: f32) -> f32 {
  sample
}

pub fn i16_to_f32(sample: i16) -> f32 {
  if sample == i16::MIN {
    -1.0
  } else {
    f32::from(sample) / f32::from(i16::MAX)
  }
}

pub fn u16_to_f32(sample: u16) -> f32 {
  let centered = f32::from(sample) - 32768.0;
  (centered / 32768.0).clamp(-1.0, 1.0)
}

pub fn start_input(
  opened: OpenedInput,
  producer: Producer<f32>,
  dropped: Arc<AtomicU64>,
) -> Result<cpal::Stream, RecorderError> {
  let channels = opened.channels;
  let config = opened.stream_config;
  let stream = match opened.format {
    SampleFormatKind::F32 => build_stream::<f32>(
      &opened.device,
      config,
      producer,
      dropped,
      channels,
      f32_sample,
    )?,
    SampleFormatKind::I16 => build_stream::<i16>(
      &opened.device,
      config,
      producer,
      dropped,
      channels,
      i16_to_f32,
    )?,
    SampleFormatKind::U16 => build_stream::<u16>(
      &opened.device,
      config,
      producer,
      dropped,
      channels,
      u16_to_f32,
    )?,
  };
  stream
    .play()
    .map_err(|error| RecorderError::Capture(error.to_string()))?;
  Ok(stream)
}

fn build_stream<T>(
  device: &cpal::Device,
  config: cpal::StreamConfig,
  mut producer: Producer<f32>,
  dropped: Arc<AtomicU64>,
  channels: u16,
  to_f32: fn(T) -> f32,
) -> Result<cpal::Stream, RecorderError>
where
  T: cpal::SizedSample + 'static,
{
  device
    .build_input_stream(
      config,
      move |data: &[T], _| {
        push_frames(data, channels, &mut producer, &dropped, to_f32);
      },
      |error| log::error!("microphone stream error: {error}"),
      None,
    )
    .map_err(|error| RecorderError::Capture(error.to_string()))
}

/// Stops the capture callback. Dropping it stops the callback too.
pub struct CapturePump {
  stop: Option<Box<dyn FnOnce() + Send>>,
}

impl CapturePump {
  pub fn from_stream(stream: cpal::Stream) -> Self {
    Self {
      stop: Some(Box::new(move || {
        let _ = stream.pause();
        drop(stream);
      })),
    }
  }

  pub fn stop(&mut self) {
    if let Some(stop) = self.stop.take() {
      stop();
    }
  }

  #[cfg(test)]
  pub fn from_sine(producer: Producer<f32>, sample_rate: u32) -> Self {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop_flag);
    let thread = std::thread::spawn(move || {
      let mut producer = producer;
      let mut frame = 0u32;
      let step = std::f32::consts::TAU * 440.0 / sample_rate.max(1) as f32;
      while !flag.load(Ordering::Relaxed) {
        let sample = (step * frame as f32).sin();
        if producer.push(sample).is_err() {
          std::thread::sleep(std::time::Duration::from_millis(1));
          continue;
        }
        frame = frame.wrapping_add(1);
      }
    });
    Self::from_thread(stop_flag, thread)
  }

  #[cfg(test)]
  pub fn already_stopped() -> Self {
    Self { stop: None }
  }

  #[cfg(test)]
  fn from_thread(stop_flag: Arc<AtomicBool>, thread: JoinHandle<()>) -> Self {
    Self {
      stop: Some(Box::new(move || {
        stop_flag.store(true, Ordering::Relaxed);
        let _ = thread.join();
      })),
    }
  }
}

impl Drop for CapturePump {
  fn drop(&mut self) {
    self.stop();
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use rtrb::RingBuffer;

  #[test]
  fn ring_overflow_counts_frames_that_do_not_fit() {
    let (mut producer, mut consumer) = RingBuffer::new(4);
    let dropped = AtomicU64::new(0);
    let samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    push_frames(&samples, 1, &mut producer, &dropped, f32_sample);
    assert_eq!(dropped.load(Ordering::Relaxed), 2);
    assert_eq!(consumer.pop().unwrap(), 0.1);
    assert_eq!(consumer.pop().unwrap(), 0.2);
    assert_eq!(consumer.pop().unwrap(), 0.3);
    assert_eq!(consumer.pop().unwrap(), 0.4);
    assert!(consumer.pop().is_err());
  }

  #[test]
  fn stereo_downmix_averages_each_frame() {
    let (mut producer, mut consumer) = RingBuffer::new(8);
    let dropped = AtomicU64::new(0);
    let interleaved = [1.0, -1.0, 0.5, 0.5, 0.0, 1.0];
    push_frames(&interleaved, 2, &mut producer, &dropped, f32_sample);
    assert_eq!(dropped.load(Ordering::Relaxed), 0);
    assert!(near(consumer.pop().unwrap(), 0.0));
    assert!(near(consumer.pop().unwrap(), 0.5));
    assert!(near(consumer.pop().unwrap(), 0.5));
    assert!(consumer.pop().is_err());
  }

  #[test]
  fn integer_frames_downmix_after_conversion() {
    let (mut producer, mut consumer) = RingBuffer::new(4);
    let dropped = AtomicU64::new(0);
    push_frames(
      &[i16::MAX, i16::MIN],
      2,
      &mut producer,
      &dropped,
      i16_to_f32,
    );
    assert!(near(consumer.pop().unwrap(), 0.0));

    let (mut producer, mut consumer) = RingBuffer::new(4);
    push_frames(&[0u16, 65535], 2, &mut producer, &dropped, u16_to_f32);
    assert!(near(consumer.pop().unwrap(), 0.0));
    assert_eq!(dropped.load(Ordering::Relaxed), 0);
  }

  #[test]
  fn a_partial_trailing_frame_is_not_a_dropped_sample() {
    let (mut producer, mut consumer) = RingBuffer::new(4);
    let dropped = AtomicU64::new(0);
    push_frames(&[0.25, 0.75, 1.0], 2, &mut producer, &dropped, f32_sample);
    assert_eq!(dropped.load(Ordering::Relaxed), 0);
    assert!(near(consumer.pop().unwrap(), 0.5));
    assert!(consumer.pop().is_err());
  }

  fn near(actual: f32, expected: f32) -> bool {
    (actual - expected).abs() < 1.0e-4
  }
}
