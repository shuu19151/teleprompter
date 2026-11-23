//! Writer thread.
//!
//! Pops mono `f32` frames from the ring, resamples to 48 kHz when the device
//! rate is different, and writes PCM. Resampling, peak folds, and event
//! emission all happen on this thread. The capture callback never calls it.
//!
//! While the take is paused this thread still pops, and it drops what it pops.
//! That keeps the ring from filling, so the callback stays non-blocking. Those
//! discarded frames are not ring overflows. Meter and peak events stop for the
//! pause; the partial window is flushed into the segment being closed. Resume
//! opens a new file and does not trim leading zeros. That trim is only for the
//! silence a device can emit when the stream first opens.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use rtrb::{Consumer, PopError};

use super::events::{notify_device_lost, ErrorEvent, RecorderEmit};
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
  /// Frames popped and discarded while the take was paused. The ring overflow
  /// counter stays in `dropped_samples`. Tests read this; stop does not return it.
  #[allow(dead_code)]
  pub paused_samples: u64,
  pub peaks: Vec<f32>,
}

enum WriterCommand {
  Pause(Sender<Result<(), RecorderError>>),
  Resume(PathBuf, Sender<Result<(), RecorderError>>),
}

pub struct WriterHandle {
  stop: Arc<AtomicBool>,
  commands: Sender<WriterCommand>,
  join: Option<JoinHandle<Result<WriterDone, RecorderError>>>,
  emit: Arc<dyn RecorderEmit>,
}

impl WriterHandle {
  pub fn pause(&self) -> Result<(), RecorderError> {
    self.round_trip(WriterCommand::Pause)
  }

  pub fn resume(&self, path: PathBuf) -> Result<(), RecorderError> {
    self.round_trip(|reply| WriterCommand::Resume(path, reply))
  }

  fn round_trip(
    &self,
    command: impl FnOnce(Sender<Result<(), RecorderError>>) -> WriterCommand,
  ) -> Result<(), RecorderError> {
    let (sender, receiver) = mpsc::channel();
    self
      .commands
      .send(command(sender))
      .map_err(|_| RecorderError::Write("the writer thread has stopped".into()))?;
    receiver
      .recv()
      .map_err(|_| RecorderError::Write("the writer thread has stopped".into()))?
  }

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
  device_id: String,
  loss_notified: Arc<AtomicBool>,
) -> Result<WriterHandle, RecorderError> {
  let stop = Arc::new(AtomicBool::new(false));
  let stop_flag = Arc::clone(&stop);
  let emit_thread = Arc::clone(&emit);
  let (commands, command_rx) = mpsc::channel();
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
        device_id,
        loss_notified,
        command_rx,
      )
    })
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  Ok(WriterHandle {
    stop,
    commands,
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
  device_id: String,
  loss_notified: Arc<AtomicBool>,
  commands: Receiver<WriterCommand>,
) -> Result<WriterDone, RecorderError> {
  match write_audio(
    consumer,
    dropped,
    path,
    capture_rate,
    written,
    stop,
    &emit,
    &fault,
    &device_id,
    &loss_notified,
    commands,
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
  device_id: &str,
  loss_notified: &AtomicBool,
  commands: Receiver<WriterCommand>,
) -> Result<WriterDone, RecorderError> {
  let mut session = SessionWriter::open(&path, capture_rate)?;
  let mut batch = [0.0f32; 256];
  let mut fault_sent = false;
  loop {
    while let Ok(command) = commands.try_recv() {
      apply_command(&mut consumer, &mut session, &written, emit.as_ref(), command);
    }
    publish_fault(
      emit.as_ref(),
      fault,
      &mut fault_sent,
      device_id,
      loss_notified,
    );
    if session.is_paused() {
      session.discard(discard_available(&mut consumer));
      // The open segment was finalized when the pause landed. A fault or a
      // stop while paused must not open it again.
      if stop.load(Ordering::Acquire) || fault.load(Ordering::Acquire) {
        break;
      }
      match commands.recv_timeout(Duration::from_millis(2)) {
        Ok(command) => apply_command(&mut consumer, &mut session, &written, emit.as_ref(), command),
        Err(RecvTimeoutError::Timeout) => {}
        Err(RecvTimeoutError::Disconnected) => break,
      }
      continue;
    }
    let count = pop_batch(&mut consumer, &mut batch);
    if count > 0 {
      session.push_slice(&batch[..count])?;
      publish_levels(emit.as_ref(), session.drain_levels());
      written.store(session.recorded_frames(), Ordering::Relaxed);
      continue;
    }
    // A stream fault finalizes the WAV here, on this thread, so the file stays
    // playable even if the page never calls stop. The callback itself only
    // sets `fault`.
    if stop.load(Ordering::Acquire) || fault.load(Ordering::Acquire) {
      drain_write(&mut consumer, &mut session, &written, emit.as_ref())?;
      break;
    }
    match commands.recv_timeout(Duration::from_millis(2)) {
      Ok(command) => apply_command(&mut consumer, &mut session, &written, emit.as_ref(), command),
      Err(RecvTimeoutError::Timeout) => {}
      Err(RecvTimeoutError::Disconnected) => break,
    }
  }
  let done = session.finish()?;
  if let Some(tail) = done.tail {
    publish_tick(emit.as_ref(), tail);
  }
  publish_fault(
    emit.as_ref(),
    fault,
    &mut fault_sent,
    device_id,
    loss_notified,
  );
  written.store(done.frames, Ordering::Relaxed);
  // Capture is already stopped, and that stop happens-before the release
  // store this loop observed, so every overflow increment is visible.
  let dropped_samples = dropped.load(Ordering::Acquire);
  Ok(WriterDone {
    frames: done.frames,
    bytes: done.bytes,
    dropped_samples,
    paused_samples: done.paused_samples,
    peaks: done.peaks,
  })
}

fn apply_command(
  consumer: &mut Consumer<f32>,
  session: &mut SessionWriter,
  written: &AtomicU64,
  emit: &dyn RecorderEmit,
  command: WriterCommand,
) {
  match command {
    WriterCommand::Pause(reply) => {
      let result = pause_session(consumer, session, written, emit);
      let _ = reply.send(result);
    }
    WriterCommand::Resume(path, reply) => {
      if session.is_paused() {
        session.discard(discard_available(consumer));
      }
      let result = session.resume(&path);
      let _ = reply.send(result);
    }
  }
}

fn pause_session(
  consumer: &mut Consumer<f32>,
  session: &mut SessionWriter,
  written: &AtomicU64,
  emit: &dyn RecorderEmit,
) -> Result<(), RecorderError> {
  if session.is_paused() {
    return Err(RecorderError::AlreadyPaused);
  }
  // Samples already in the ring were captured before this pause was observed.
  drain_write(consumer, session, written, emit)?;
  if let Some(tail) = session.pause()? {
    publish_tick(emit, tail);
  }
  written.store(session.recorded_frames(), Ordering::Relaxed);
  Ok(())
}

fn drain_write(
  consumer: &mut Consumer<f32>,
  session: &mut SessionWriter,
  written: &AtomicU64,
  emit: &dyn RecorderEmit,
) -> Result<(), RecorderError> {
  let mut batch = [0.0f32; 256];
  loop {
    let count = pop_batch(consumer, &mut batch);
    if count == 0 {
      break;
    }
    session.push_slice(&batch[..count])?;
    publish_levels(emit, session.drain_levels());
  }
  written.store(session.recorded_frames(), Ordering::Relaxed);
  Ok(())
}

fn pop_batch(consumer: &mut Consumer<f32>, batch: &mut [f32]) -> usize {
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
  count
}

fn discard_available(consumer: &mut Consumer<f32>) -> u64 {
  let mut count = 0u64;
  while consumer.pop().is_ok() {
    count += 1;
  }
  count
}

struct SessionDone {
  frames: u64,
  bytes: u64,
  paused_samples: u64,
  peaks: Vec<f32>,
  tail: Option<LevelTick>,
}

struct SessionWriter {
  wav: Option<WavFile>,
  stage: OutputStage,
  levels: LevelWindow,
  paused: bool,
  paused_samples: u64,
  closed_frames: u64,
  closed_bytes: u64,
  last_second: u64,
  capture_rate: u32,
}

impl SessionWriter {
  fn open(path: &Path, capture_rate: u32) -> Result<Self, RecorderError> {
    Ok(Self {
      wav: Some(WavFile::create(path)?),
      stage: OutputStage::new(capture_rate)?,
      levels: LevelWindow::new(OUTPUT_SAMPLE_RATE),
      paused: false,
      paused_samples: 0,
      closed_frames: 0,
      closed_bytes: 0,
      last_second: 0,
      capture_rate,
    })
  }

  fn is_paused(&self) -> bool {
    self.paused
  }

  fn recorded_frames(&self) -> u64 {
    self.closed_frames + self.wav.as_ref().map(WavFile::frames).unwrap_or(0)
  }

  fn discard(&mut self, frames: u64) {
    self.paused_samples += frames;
  }

  fn drain_levels(&mut self) -> Vec<LevelTick> {
    self.levels.drain()
  }

  fn push_slice(&mut self, samples: &[f32]) -> Result<(), RecorderError> {
    if samples.is_empty() {
      return Ok(());
    }
    if self.paused {
      self.paused_samples += samples.len() as u64;
      return Ok(());
    }
    let Self {
      wav,
      stage,
      levels,
      last_second,
      ..
    } = self;
    let Some(wav) = wav.as_mut() else {
      return Err(RecorderError::Write("the segment is not open".into()));
    };
    stage.push(samples, wav, levels)?;
    checkpoint_if_due(wav, last_second)?;
    Ok(())
  }

  fn pause(&mut self) -> Result<Option<LevelTick>, RecorderError> {
    if self.paused {
      return Err(RecorderError::AlreadyPaused);
    }
    let tail = self.close_open_segment()?;
    self.paused = true;
    Ok(tail)
  }

  fn resume(&mut self, path: &Path) -> Result<(), RecorderError> {
    if !self.paused {
      return Err(RecorderError::NotPaused);
    }
    let wav = WavFile::create(path)?;
    let stage = OutputStage::continuing(self.capture_rate)?;
    self.wav = Some(wav);
    self.stage = stage;
    self.last_second = 0;
    self.paused = false;
    Ok(())
  }

  fn finish(mut self) -> Result<SessionDone, RecorderError> {
    let tail = if self.paused {
      None
    } else {
      self.close_open_segment()?
    };
    Ok(SessionDone {
      frames: self.closed_frames,
      bytes: self.closed_bytes,
      paused_samples: self.paused_samples,
      peaks: self.levels.take_peaks(),
      tail,
    })
  }

  fn close_open_segment(&mut self) -> Result<Option<LevelTick>, RecorderError> {
    let Some(mut wav) = self.wav.take() else {
      return Ok(None);
    };
    if let Err(error) = self.stage.finish(&mut wav, &mut self.levels) {
      self.wav = Some(wav);
      return Err(error);
    }
    let tail = self.levels.finish();
    match wav.finalize() {
      Ok(done) => {
        self.closed_frames += done.frames;
        self.closed_bytes += done.bytes;
        Ok(tail)
      }
      Err(error) => Err(error),
    }
  }
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

fn publish_fault(
  emit: &dyn RecorderEmit,
  fault: &AtomicBool,
  sent: &mut bool,
  device_id: &str,
  loss_notified: &AtomicBool,
) {
  if *sent || !fault.load(Ordering::Acquire) {
    return;
  }
  *sent = true;
  emit.error(&ErrorEvent::capture_fault());
  notify_device_lost(emit, loss_notified, device_id);
}

fn checkpoint_if_due(wav: &mut WavFile, last_second: &mut u64) -> Result<(), RecorderError> {
  let second = wav.frames() / u64::from(OUTPUT_SAMPLE_RATE);
  if second != *last_second {
    wav.checkpoint()?;
    *last_second = second;
  }
  Ok(())
}

/// Keep a sample unless it is an exact zero at the very start of the take.
/// Later zeros, including a zero that follows speech, are kept.
fn accept_leading(drop_leading: &mut bool, sample: f32) -> bool {
  if !*drop_leading {
    return true;
  }
  if sample == 0.0 {
    return false;
  }
  *drop_leading = false;
  true
}

struct OutputStage {
  /// Exact digital zeros before the first real sample. The device can deliver
  /// these for most of a second after the stream opens.
  drop_leading: bool,
  kind: OutputKind,
}

enum OutputKind {
  Direct,
  Resample(StreamResampler),
}

impl OutputStage {
  fn new(capture_rate: u32) -> Result<Self, RecorderError> {
    let kind = if capture_rate == OUTPUT_SAMPLE_RATE || capture_rate == 0 {
      OutputKind::Direct
    } else {
      OutputKind::Resample(StreamResampler::new(capture_rate)?)
    };
    Ok(Self {
      drop_leading: true,
      kind,
    })
  }

  /// A later segment. The stream is already open, so exact zeros are real
  /// silence and stay in the file. A fresh resampler still trims its warmup.
  fn continuing(capture_rate: u32) -> Result<Self, RecorderError> {
    let mut stage = Self::new(capture_rate)?;
    stage.drop_leading = false;
    if let OutputKind::Resample(resampler) = &mut stage.kind {
      resampler.drop_leading = false;
    }
    Ok(stage)
  }

  /// Index of the first sample that should be written. Leading exact zeros
  /// stay out of the WAV and out of the resampler.
  fn leading_skip(&mut self, samples: &[f32]) -> usize {
    if !self.drop_leading {
      return 0;
    }
    let mut start = 0;
    while start < samples.len() && samples[start] == 0.0 {
      start += 1;
    }
    if start < samples.len() {
      self.drop_leading = false;
    }
    start
  }

  fn push(
    &mut self,
    samples: &[f32],
    wav: &mut WavFile,
    levels: &mut LevelWindow,
  ) -> Result<(), RecorderError> {
    let start = self.leading_skip(samples);
    if start >= samples.len() {
      return Ok(());
    }
    let audible = &samples[start..];
    match &mut self.kind {
      OutputKind::Direct => {
        for sample in audible {
          write_sample(wav, levels, *sample)?;
        }
        Ok(())
      }
      OutputKind::Resample(stage) => stage.push(audible, wav, levels),
    }
  }

  fn finish(&mut self, wav: &mut WavFile, levels: &mut LevelWindow) -> Result<(), RecorderError> {
    match &mut self.kind {
      OutputKind::Direct => Ok(()),
      OutputKind::Resample(stage) => stage.finish(wav, levels),
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
  drop_leading: bool,
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
      drop_leading: true,
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
      if !accept_leading(&mut self.drop_leading, *sample) {
        continue;
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
  use crate::recorder::events::{
    DeviceLostEvent, DevicesChangedEvent, ErrorEvent, MeterEvent, PeaksEvent, RecorderEmit, StateNotice,
  };
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

    fn device_lost(&self, _event: &DeviceLostEvent) {
      self.note_thread();
    }

    fn devices_changed(&self, _event: &DevicesChangedEvent) {}
  }

  fn loss_args() -> (String, Arc<AtomicBool>) {
    ("test-input".into(), Arc::new(AtomicBool::new(false)))
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
    let (device_id, loss) = loss_args();
    let handle = spawn_writer(
      consumer,
      std::sync::Arc::clone(&dropped),
      path.clone(),
      44_100,
      written,
      emit,
      fault,
      device_id,
      loss,
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
    // A phase offset so the first sample is not the exact zero sin(0) produces.
    // Leading exact zeros are dropped on purpose; this fixture has none.
    let input: Vec<f32> = (0..frames)
      .map(|index| {
        let step = std::f32::consts::TAU * 440.0 / 48_000.0;
        (step * index as f32 + 0.4).sin() * 0.5
      })
      .collect();
    assert!(input[0].abs() > 1.0e-3);
    let path = temp_wav("direct");
    let (mut producer, consumer) = RingBuffer::new(frames);
    for sample in &input {
      producer.push(*sample).unwrap();
    }
    drop(producer);
    let dropped = std::sync::Arc::new(AtomicU64::new(3));
    let written = std::sync::Arc::new(AtomicU64::new(0));
    let (emit, fault) = test_emit();
    let (device_id, loss) = loss_args();
    let handle = spawn_writer(
      consumer,
      dropped,
      path.clone(),
      48_000,
      written,
      emit,
      fault,
      device_id,
      loss,
    )
    .unwrap();
    let done = handle.finish().unwrap();
    assert_eq!(done.frames, frames as u64);
    assert_eq!(done.dropped_samples, 3);
    assert_eq!(done.bytes, 44 + frames as u64 * 2);
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn leading_exact_zeros_are_dropped_and_later_zeros_stay() {
    let mut input = vec![0.0f32; 100];
    input.push(0.5);
    input.push(0.0);
    input.push(-0.25);
    input.extend(std::iter::repeat(0.0).take(10));
    let path = temp_wav("leading-zeros");
    let (mut producer, consumer) = RingBuffer::new(input.len() + 8);
    for sample in &input {
      producer.push(*sample).unwrap();
    }
    drop(producer);
    let dropped = std::sync::Arc::new(AtomicU64::new(0));
    let written = std::sync::Arc::new(AtomicU64::new(0));
    let (emit, fault) = test_emit();
    let (device_id, loss) = loss_args();
    let handle = spawn_writer(
      consumer,
      dropped,
      path.clone(),
      48_000,
      written,
      emit,
      fault,
      device_id,
      loss,
    )
    .unwrap();
    let done = handle.finish().unwrap();
    let kept = 13u64;
    assert_eq!(done.frames, kept);
    assert_eq!(done.bytes, 44 + kept * 2);
    let mut reader = hound::WavReader::open(&path).unwrap();
    let samples: Vec<f32> = reader
      .samples::<i16>()
      .map(|sample| sample.unwrap() as f32 / i16::MAX as f32)
      .collect();
    assert_eq!(samples.len(), kept as usize);
    assert!(samples[0] > 0.4, "first written sample {}", samples[0]);
    assert!(samples[1].abs() < 1.0e-4, "a zero after speech was dropped");
    assert!(samples[2] < -0.2, "third sample {}", samples[2]);
    assert!(samples[3..].iter().all(|sample| sample.abs() < 1.0e-4));
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn an_all_zero_take_writes_no_frames() {
    let input = vec![0.0f32; 64];
    let path = temp_wav("all-zeros");
    let (mut producer, consumer) = RingBuffer::new(input.len());
    for sample in &input {
      producer.push(*sample).unwrap();
    }
    drop(producer);
    let (emit, fault) = test_emit();
    let (device_id, loss) = loss_args();
    let handle = spawn_writer(
      consumer,
      std::sync::Arc::new(AtomicU64::new(0)),
      path.clone(),
      48_000,
      std::sync::Arc::new(AtomicU64::new(0)),
      emit,
      fault,
      device_id,
      loss,
    )
    .unwrap();
    let done = handle.finish().unwrap();
    assert_eq!(done.frames, 0);
    assert!(done.bytes >= 44);
    let reader = hound::WavReader::open(&path).unwrap();
    assert_eq!(reader.duration(), 0);
    let _ = std::fs::remove_file(&path);
  }

  #[test]
  fn pause_drops_ring_samples_and_resume_writes_a_new_file() {
    let dir = std::env::temp_dir().join(format!(
      "teleprompter-pause-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let first_path = dir.join("seg-000.wav");
    let second_path = dir.join("seg-001.wav");
    let (mut producer, consumer) = RingBuffer::new(64);
    let first = [0.5f32; 16];
    for sample in first {
      producer.push(sample).unwrap();
    }
    let (emit, fault) = test_emit();
    let (device_id, loss) = loss_args();
    let handle = spawn_writer(
      consumer,
      std::sync::Arc::new(AtomicU64::new(0)),
      first_path.clone(),
      48_000,
      std::sync::Arc::new(AtomicU64::new(0)),
      emit,
      fault,
      device_id,
      loss,
    )
    .unwrap();
    handle.pause().unwrap();
    for _ in 0..8 {
      producer.push(0.9).unwrap();
    }
    handle.resume(second_path.clone()).unwrap();
    let second = [-0.5f32; 16];
    for sample in second {
      producer.push(sample).unwrap();
    }
    drop(producer);
    let done = handle.finish().unwrap();
    assert_eq!(done.paused_samples, 8);
    assert_eq!(done.frames, 32);
    let mut first_reader = hound::WavReader::open(&first_path).unwrap();
    let mut second_reader = hound::WavReader::open(&second_path).unwrap();
    assert_eq!(first_reader.duration(), 16);
    assert_eq!(second_reader.duration(), 16);
    let first_pcm: Vec<i16> = first_reader.samples::<i16>().map(|sample| sample.unwrap()).collect();
    let second_pcm: Vec<i16> = second_reader.samples::<i16>().map(|sample| sample.unwrap()).collect();
    assert!(first_pcm.iter().all(|sample| *sample > 0));
    assert!(second_pcm.iter().all(|sample| *sample < 0));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn accept_leading_drops_only_the_opening_zeros() {
    let mut dropping = true;
    assert!(!accept_leading(&mut dropping, 0.0));
    assert!(!accept_leading(&mut dropping, -0.0));
    assert!(dropping);
    assert!(accept_leading(&mut dropping, 0.25));
    assert!(!dropping);
    assert!(accept_leading(&mut dropping, 0.0));
    assert!(accept_leading(&mut dropping, -0.5));
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
    let (device_id, loss) = loss_args();
    let handle = spawn_writer(
      consumer,
      dropped,
      path.clone(),
      48_000,
      written,
      Arc::clone(&emit) as Arc<dyn RecorderEmit>,
      fault,
      device_id,
      loss,
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
