//! Writer thread.
//!
//! Pops mono `f32` frames from the ring, resamples to 48 kHz when the device
//! rate is different, and writes PCM. Resampling, peak folds, and event
//! emission all happen on this thread. The capture callback never calls it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use rtrb::{Consumer, PopError};

use super::events::{ErrorEvent, RecorderEmit};
use super::levels::{LevelTick, LevelWindow};
use super::wav::WavFile;
use super::{RecorderError, OUTPUT_SAMPLE_RATE};

const RESAMPLE_CHUNK: usize = 1024;
const PUMP_LIMIT: usize = 64;

fn expected_output_frames(input_frames: u64, input_rate: u32) -> u64 {
  let input_rate = u64::from(input_rate.max(1));
  input_frames
    .saturating_mul(u64::from(OUTPUT_SAMPLE_RATE))
    .saturating_add(input_rate / 2)
    / input_rate
}

pub struct WriterDone {
  pub frames: u64,
  pub bytes: u64,
  pub dropped_samples: u64,
  pub peaks: Vec<f32>,
}

pub struct WriterHandle {
  stop: Arc<AtomicBool>,
  join: Option<JoinHandle<Result<WriterDone, RecorderError>>>,
  emit: Arc<dyn RecorderEmit>,
}

impl WriterHandle {
  pub fn finish(mut self) -> Result<WriterDone, RecorderError> {
    self.stop.store(true, Ordering::Release);
    let join = self
      .join
      .take()
      .ok_or_else(|| RecorderError::Write("the writer thread was already joined".into()))?;
    match join.join() {
      Ok(result) => result,
      Err(_) => {
        let error = RecorderError::Write("the writer thread panicked".into());
        self.emit.error(&ErrorEvent::from_recorder(&error));
        Err(error)
      }
    }
  }
}

impl Drop for WriterHandle {
  fn drop(&mut self) {
    if self.join.is_some() {
      self.stop.store(true, Ordering::Release);
      if let Some(join) = self.join.take() {
        let _ = join.join();
      }
    }
  }
}

pub fn spawn_writer(
  consumer: Consumer<f32>,
  dropped: Arc<AtomicU64>,
  path: PathBuf,
  capture_rate: u32,
  written: Arc<AtomicU64>,
  emit: Arc<dyn RecorderEmit>,
  fault: Arc<AtomicBool>,
) -> Result<WriterHandle, RecorderError> {
  let stop = Arc::new(AtomicBool::new(false));
  let stop_flag = Arc::clone(&stop);
  let emit_thread = Arc::clone(&emit);
  let join = std::thread::Builder::new()
    .name("teleprompter-wav".into())
    .spawn(move || {
      write_loop(
        consumer,
        dropped,
        path,
        capture_rate,
        written,
        stop_flag,
        emit_thread,
        fault,
      )
    })
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  Ok(WriterHandle {
    stop,
    join: Some(join),
    emit,
  })
}

fn write_loop(
  consumer: Consumer<f32>,
  dropped: Arc<AtomicU64>,
  path: PathBuf,
  capture_rate: u32,
  written: Arc<AtomicU64>,
  stop: Arc<AtomicBool>,
  emit: Arc<dyn RecorderEmit>,
  fault: Arc<AtomicBool>,
) -> Result<WriterDone, RecorderError> {
  match write_audio(
    consumer, dropped, path, capture_rate, written, stop, &emit, &fault,
  ) {
    Ok(done) => Ok(done),
    Err(error) => {
      emit.error(&ErrorEvent::from_recorder(&error));
      Err(error)
    }
  }
}

fn write_audio(
  mut consumer: Consumer<f32>,
  dropped: Arc<AtomicU64>,
  path: PathBuf,
  capture_rate: u32,
  written: Arc<AtomicU64>,
  stop: Arc<AtomicBool>,
  emit: &Arc<dyn RecorderEmit>,
  fault: &AtomicBool,
) -> Result<WriterDone, RecorderError> {
  let mut wav = WavFile::create(&path)?;
  let mut stage = OutputStage::new(capture_rate)?;
  let mut levels = LevelWindow::new(OUTPUT_SAMPLE_RATE);
  let mut batch = [0.0f32; 256];
  let mut last_second = 0u64;
  let mut fault_sent = false;
  loop {
    publish_fault(emit.as_ref(), fault, &mut fault_sent);
    let mut count = 0;
    while count < batch.len() {
      match consumer.pop() {
        Ok(sample) => {
          batch[count] = sample;
          count += 1;
        }
        Err(PopError::Empty) => break,
      }
    }
    if count > 0 {
      stage.push(&batch[..count], &mut wav, &mut levels)?;
      publish_levels(emit.as_ref(), levels.drain());
      written.store(wav.frames(), Ordering::Relaxed);
      checkpoint_if_due(&mut wav, &mut last_second)?;
      continue;
    }
    if stop.load(Ordering::Acquire) {
      while let Ok(sample) = consumer.pop() {
        stage.push(std::slice::from_ref(&sample), &mut wav, &mut levels)?;
      }
      publish_levels(emit.as_ref(), levels.drain());
      break;
    }
    std::thread::sleep(Duration::from_millis(2));
  }
  stage.finish(&mut wav, &mut levels)?;
  publish_levels(emit.as_ref(), levels.drain());
  if let Some(tail) = levels.finish() {
    publish_tick(emit.as_ref(), tail);
  }
  publish_fault(emit.as_ref(), fault, &mut fault_sent);
  written.store(wav.frames(), Ordering::Relaxed);
  let peaks = levels.take_peaks();
  let finalized = wav.finalize()?;
  // Capture is already stopped, and that stop happens-before the release
  // store this loop observed, so every overflow increment is visible.
  let dropped_samples = dropped.load(Ordering::Acquire);
  Ok(WriterDone {
    frames: finalized.frames,
    bytes: finalized.bytes,
    dropped_samples,
    peaks,
  })
}

fn publish_levels(emit: &dyn RecorderEmit, ticks: Vec<LevelTick>) {
  for tick in ticks {
    publish_tick(emit, tick);
  }
}

fn publish_tick(emit: &dyn RecorderEmit, tick: LevelTick) {
  if let Some(meter) = tick.meter.as_ref() {
    emit.meter(meter);
  }
  if let Some(peaks) = tick.peaks.as_ref() {
    emit.peaks(peaks);
  }
}

fn publish_fault(emit: &dyn RecorderEmit, fault: &AtomicBool, sent: &mut bool) {
  if *sent || !fault.load(Ordering::Acquire) {
    return;
  }
  *sent = true;
  emit.error(&ErrorEvent::capture_fault());
}

fn checkpoint_if_due(wav: &mut WavFile, last_second: &mut u64) -> Result<(), RecorderError> {
  let second = wav.frames() / u64::from(OUTPUT_SAMPLE_RATE);
  if second != *last_second {
    wav.checkpoint()?;
    *last_second = second;
  }
  Ok(())
}

enum OutputStage {
  Direct,
  Resample(StreamResampler),
}

impl OutputStage {
  fn new(capture_rate: u32) -> Result<Self, RecorderError> {
    if capture_rate == OUTPUT_SAMPLE_RATE || capture_rate == 0 {
      Ok(Self::Direct)
    } else {
      Ok(Self::Resample(StreamResampler::new(capture_rate)?))
    }
  }

  fn push(
    &mut self,
    samples: &[f32],
    wav: &mut WavFile,
    levels: &mut LevelWindow,
  ) -> Result<(), RecorderError> {
    match self {
      Self::Direct => {
        for sample in samples {
          wav.write_f32(*sample)?;
        }
        levels.push_slice(samples);
        Ok(())
      }
      Self::Resample(stage) => stage.push(samples, wav, levels),
    }
  }

  fn finish(&mut self, wav: &mut WavFile, levels: &mut LevelWindow) -> Result<(), RecorderError> {
    match self {
      Self::Direct => Ok(()),
      Self::Resample(stage) => stage.finish(wav, levels),
    }
  }
}

fn write_sample(wav: &mut WavFile, levels: &mut LevelWindow, sample: f32) -> Result<(), RecorderError> {
  wav.write_f32(sample)?;
  levels.push_sample(sample);
  Ok(())
}

struct StreamResampler {
  resampler: Fft<f32>,
  pending: Vec<f32>,
  input_frames: u64,
  input_rate: u32,
  trim_left: usize,
  in_scratch: Vec<f32>,
  out_scratch: Vec<f32>,
}

impl StreamResampler {
  fn new(capture_rate: u32) -> Result<Self, RecorderError> {
    let resampler = Fft::<f32>::new(
      capture_rate as usize,
      OUTPUT_SAMPLE_RATE as usize,
      RESAMPLE_CHUNK,
      1,
      FixedSync::Input,
    )
    .map_err(|error| RecorderError::Write(error.to_string()))?;
    let trim_left = resampler.output_delay();
    let in_len = resampler.input_frames_max().max(RESAMPLE_CHUNK);
    let out_len = resampler.output_frames_max().max(1);
    Ok(Self {
      resampler,
      pending: Vec::with_capacity(in_len * 2),
      input_frames: 0,
      input_rate: capture_rate,
      trim_left,
      in_scratch: vec![0.0; in_len],
      out_scratch: vec![0.0; out_len],
    })
  }

  fn push(
    &mut self,
    samples: &[f32],
    wav: &mut WavFile,
    levels: &mut LevelWindow,
  ) -> Result<(), RecorderError> {
    self.pending.extend_from_slice(samples);
    self.input_frames += samples.len() as u64;
    while self.pending.len() >= self.resampler.input_frames_next() {
      let count = self.resampler.input_frames_next();
      self.process(count, None, wav, levels, None)?;
    }
    Ok(())
  }

  fn finish(
    &mut self,
    wav: &mut WavFile,
    levels: &mut LevelWindow,
  ) -> Result<(), RecorderError> {
    let expected = expected_output_frames(self.input_frames, self.input_rate);
    if !self.pending.is_empty() {
      let count = self.pending.len();
      self.process(count, Some(count), wav, levels, Some(expected))?;
    }
    let mut pumps = 0;
    while wav.frames() < expected && pumps < PUMP_LIMIT {
      let before = wav.frames();
      self.process(0, Some(0), wav, levels, Some(expected))?;
      pumps += 1;
      if wav.frames() == before && self.trim_left == 0 {
        break;
      }
    }
    Ok(())
  }

  fn process(
    &mut self,
    count: usize,
    partial: Option<usize>,
    wav: &mut WavFile,
    levels: &mut LevelWindow,
    cap: Option<u64>,
  ) -> Result<(), RecorderError> {
    if count > self.in_scratch.len() {
      return Err(RecorderError::Write(
        "the resampler chunk is larger than its input buffer".into(),
      ));
    }
    if count > 0 {
      self.in_scratch[..count].copy_from_slice(&self.pending[..count]);
    }
    let frames_in_buf = if partial == Some(0) { 0 } else { count };
    let indexing = partial.map(|frames| Indexing::new().partial_len(frames));
    let input_buf: &[f32] = if frames_in_buf == 0 {
      &[]
    } else {
      &self.in_scratch[..frames_in_buf]
    };
    let out_len = self.out_scratch.len();
    let produced = {
      let input = InterleavedSlice::new(input_buf, 1, frames_in_buf)
        .map_err(|error| RecorderError::Write(format!("resampler input: {error:?}")))?;
      let mut output = InterleavedSlice::new_mut(&mut self.out_scratch[..], 1, out_len)
        .map_err(|error| RecorderError::Write(format!("resampler output: {error:?}")))?;
      let (_read, written) = self
        .resampler
        .process_into_buffer(&input, &mut output, indexing.as_ref())
        .map_err(|error| RecorderError::Write(error.to_string()))?;
      written
    };
    if produced > self.out_scratch.len() {
      return Err(RecorderError::Write(
        "the resampler wrote past its output buffer".into(),
      ));
    }
    self.emit(produced, wav, levels, cap)?;
    if count > 0 {
      self.pending.drain(..count);
    }
    Ok(())
  }

  fn emit(
    &mut self,
    frames: usize,
    wav: &mut WavFile,
    levels: &mut LevelWindow,
    cap: Option<u64>,
  ) -> Result<(), RecorderError> {
    let mut start = 0;
    if self.trim_left > 0 {
      let skip = self.trim_left.min(frames);
      self.trim_left -= skip;
      start = skip;
    }
    for sample in &self.out_scratch[start..frames] {
      if cap.is_some_and(|limit| wav.frames() >= limit) {
        break;
      }
      write_sample(wav, levels, *sample)?;
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;

  use super::*;
  use crate::recorder::events::{ErrorEvent, MeterEvent, PeaksEvent, RecorderEmit, StateNotice};
  use rtrb::RingBuffer;

  struct MemoryEmit {
    meters: Mutex<Vec<MeterEvent>>,
    peaks: Mutex<Vec<PeaksEvent>>,
    errors: Mutex<Vec<ErrorEvent>>,
    threads: Mutex<Vec<String>>,
  }

  impl MemoryEmit {
    fn new() -> Self {
      Self {
        meters: Mutex::new(Vec::new()),
        peaks: Mutex::new(Vec::new()),
        errors: Mutex::new(Vec::new()),
        threads: Mutex::new(Vec::new()),
      }
    }

    fn note_thread(&self) {
      let name = std::thread::current().name().unwrap_or("").to_string();
      self.threads.lock().unwrap().push(name);
    }
  }

  impl RecorderEmit for MemoryEmit {
    fn meter(&self, event: &MeterEvent) {
      self.note_thread();
      self.meters.lock().unwrap().push(event.clone());
    }

    fn peaks(&self, event: &PeaksEvent) {
      self.note_thread();
      self.peaks.lock().unwrap().push(event.clone());
    }

    fn state(&self, _event: &StateNotice) {}

    fn error(&self, event: &ErrorEvent) {
      self.note_thread();
      self.errors.lock().unwrap().push(event.clone());
    }
  }

  fn test_emit() -> (Arc<dyn RecorderEmit>, Arc<AtomicBool>) {
    (
      Arc::new(super::super::events::NopEmit),
      Arc::new(AtomicBool::new(false)),
    )
  }

  #[test]
  fn resampling_44100_to_48000_is_near_the_ratio() {
    let input_frames = 44_100usize;
    let input = sine(44_100, 440.0, input_frames);
    let path = temp_wav("resample");
    let (mut producer, consumer) = RingBuffer::new(input_frames + 8);
    let dropped = std::sync::Arc::new(AtomicU64::new(0));
    let mut missed = 0u64;
    for sample in &input {
      if producer.push(*sample).is_err() {
        missed += 1;
      }
    }
    assert_eq!(missed, 0);
    drop(producer);
    let written = std::sync::Arc::new(AtomicU64::new(0));
    let (emit, fault) = test_emit();
    let handle = spawn_writer(
      consumer,
      std::sync::Arc::clone(&dropped),
      path.clone(),
      44_100,
      written,
      emit,
      fault,
    )
    .unwrap();
    let done = handle.finish().unwrap();
    let expected = (48_000.0 / 44_100.0 * input_frames as f64).round() as u64;
    let delta = done.frames.abs_diff(expected);
    assert!(
      delta < expected / 100,
      "resampled length {} vs {expected} (delta {delta})",
      done.frames
    );
    let mut reader = hound::WavReader::open(&path).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 1);
    assert_eq!(spec.sample_rate, OUTPUT_SAMPLE_RATE);
    assert_eq!(spec.bits_per_sample, 16);
    assert_eq!(reader.duration() as u64, done.frames);
    let mut peak = 0u16;
    for sample in reader.samples::<i16>() {
      peak = peak.max(sample.unwrap().unsigned_abs());
    }
    assert!(peak > 1_000, "resampled sine collapsed to {peak}");
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn same_rate_keeps_every_frame() {
    let frames = 480usize;
    let input = sine(48_000, 440.0, frames);
    let path = temp_wav("direct");
    let (mut producer, consumer) = RingBuffer::new(frames);
    for sample in &input {
      producer.push(*sample).unwrap();
    }
    drop(producer);
    let dropped = std::sync::Arc::new(AtomicU64::new(3));
    let written = std::sync::Arc::new(AtomicU64::new(0));
    let (emit, fault) = test_emit();
    let handle = spawn_writer(consumer, dropped, path.clone(), 48_000, written, emit, fault).unwrap();
    let done = handle.finish().unwrap();
    assert_eq!(done.frames, frames as u64);
    assert_eq!(done.dropped_samples, 3);
    assert_eq!(done.bytes, 44 + frames as u64 * 2);
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn meter_and_peaks_are_emitted_on_the_writer_thread() {
    let frames = 4_800usize;
    let input = vec![0.25f32; frames];
    let path = temp_wav("levels");
    let (mut producer, consumer) = RingBuffer::new(frames + 8);
    for sample in &input {
      producer.push(*sample).unwrap();
    }
    drop(producer);
    let emit = Arc::new(MemoryEmit::new());
    let fault = Arc::new(AtomicBool::new(true));
    let dropped = std::sync::Arc::new(AtomicU64::new(0));
    let written = std::sync::Arc::new(AtomicU64::new(0));
    let handle = spawn_writer(
      consumer,
      dropped,
      path.clone(),
      48_000,
      written,
      Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      fault,
    )
    .unwrap();
    let done = handle.finish().unwrap();
    assert_eq!(done.frames, frames as u64);
    assert_eq!(done.peaks.len(), 5);
    for value in &done.peaks {
      assert!((value - 0.625).abs() < 1.0e-5);
    }
    let meters = emit.meters.lock().unwrap();
    let peaks = emit.peaks.lock().unwrap();
    assert_eq!(meters.len(), 2);
    assert!(!meters[0].clipped);
    assert!((meters[0].peak - 0.25).abs() < 1.0e-6);
    assert_eq!(peaks.len(), 2);
    assert_eq!(peaks[0].start_index, 0);
    assert_eq!(peaks[0].values.len(), 2);
    assert_eq!(peaks[1].start_index, 2);
    assert_eq!(peaks[1].values.len(), 3);
    let errors = emit.errors.lock().unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, "capture");
    let threads = emit.threads.lock().unwrap();
    assert!(!threads.is_empty());
    assert!(threads.iter().all(|name| name == "teleprompter-wav"));
    let _ = std::fs::remove_file(&path);
  }

  fn sine(rate: u32, hz: f32, frames: usize) -> Vec<f32> {
    let step = std::f32::consts::TAU * hz / rate as f32;
    (0..frames)
      .map(|index| (step * index as f32).sin() * 0.5)
      .collect()
  }

  fn temp_wav(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
      "teleprompter-{label}-{}-{}.wav",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ))
  }
}
