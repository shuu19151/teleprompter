//! PCM WAV writing.
//!
//! The file is always mono, 16-bit little-endian, at [`OUTPUT_SAMPLE_RATE`].
//! [`WavFile::checkpoint`] rewrites the header so a later crash-recovery pass
//! can read a partial take, and [`WavFile::finalize`] closes it.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use hound::{SampleFormat, WavSpec, WavWriter};

use super::{RecorderError, OUTPUT_SAMPLE_RATE};

pub struct WavFile {
  writer: Option<WavWriter<BufWriter<File>>>,
  frames: u64,
  path: PathBuf,
}

pub struct FinalWav {
  pub frames: u64,
  pub bytes: u64,
}

impl WavFile {
  pub fn create(path: &Path) -> Result<Self, RecorderError> {
    let spec = WavSpec {
      channels: 1,
      sample_rate: OUTPUT_SAMPLE_RATE,
      bits_per_sample: 16,
      sample_format: SampleFormat::Int,
    };
    let writer = WavWriter::create(path, spec).map_err(|error| {
      RecorderError::Write(format!("could not create {}: {error}", path.display()))
    })?;
    Ok(Self {
      writer: Some(writer),
      frames: 0,
      path: path.to_path_buf(),
    })
  }

  pub fn frames(&self) -> u64 {
    self.frames
  }

  pub fn write_f32(&mut self, sample: f32) -> Result<(), RecorderError> {
    self.write_i16(f32_to_i16(sample))
  }

  pub fn write_i16(&mut self, sample: i16) -> Result<(), RecorderError> {
    self
      .writer
      .as_mut()
      .ok_or_else(|| RecorderError::Write("the WAV file is already finalized".into()))?
      .write_sample(sample)
      .map_err(|error| RecorderError::Write(error.to_string()))?;
    self.frames += 1;
    Ok(())
  }

  /// Rewrite the header with the length written so far.
  ///
  /// A later phase can call this on a timer, and after a crash the partial
  /// file is still a valid WAV up to the last checkpoint.
  pub fn checkpoint(&mut self) -> Result<(), RecorderError> {
    self
      .writer
      .as_mut()
      .ok_or_else(|| RecorderError::Write("the WAV file is already finalized".into()))?
      .flush()
      .map_err(|error| RecorderError::Write(error.to_string()))
  }

  pub fn finalize(mut self) -> Result<FinalWav, RecorderError> {
    let writer = self
      .writer
      .take()
      .ok_or_else(|| RecorderError::Write("the WAV file is already finalized".into()))?;
    writer
      .finalize()
      .map_err(|error| RecorderError::Write(error.to_string()))?;
    let bytes = std::fs::metadata(&self.path)
      .map(|meta| meta.len())
      .unwrap_or(0);
    Ok(FinalWav {
      frames: self.frames,
      bytes,
    })
  }
}

/// Map a full-scale float sample to signed 16-bit PCM.
pub fn f32_to_i16(sample: f32) -> i16 {
  if !sample.is_finite() {
    return 0;
  }
  let clamped = sample.clamp(-1.0, 1.0);
  (clamped * f32::from(i16::MAX)).round() as i16
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn finalize_writes_the_pcm_header_and_length() {
    let path = std::env::temp_dir().join(format!(
      "teleprompter-wav-{}-{}.wav",
      std::process::id(),
      unique_suffix()
    ));
    let mut wav = WavFile::create(&path).unwrap();
    let samples = [0.0, 1.0, -1.0, 0.5];
    for sample in samples {
      wav.write_f32(sample).unwrap();
    }
    wav.checkpoint().unwrap();
    let finalized = wav.finalize().unwrap();
    assert_eq!(finalized.frames, samples.len() as u64);
    assert_eq!(finalized.bytes, 44 + samples.len() as u64 * 2);

    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    assert_eq!(&bytes[12..16], b"fmt ");
    assert_eq!(u32::from_le_bytes(bytes[16..20].try_into().unwrap()), 16);
    assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
    assert_eq!(
      u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
      OUTPUT_SAMPLE_RATE
    );
    assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
    assert_eq!(&bytes[36..40], b"data");
    let data_bytes = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
    assert_eq!(data_bytes, samples.len() as u32 * 2);
    assert_eq!(bytes.len(), 44 + data_bytes as usize);
    let riff_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    assert_eq!(riff_size as usize, bytes.len() - 8);

    let mut reader = hound::WavReader::open(&path).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 1);
    assert_eq!(spec.sample_rate, OUTPUT_SAMPLE_RATE);
    assert_eq!(spec.bits_per_sample, 16);
    assert_eq!(spec.sample_format, SampleFormat::Int);
    assert_eq!(reader.duration(), samples.len() as u32);
    let pcm: Vec<i16> = reader.samples().map(|sample| sample.unwrap()).collect();
    assert_eq!(
      pcm,
      vec![f32_to_i16(0.0), f32_to_i16(1.0), f32_to_i16(-1.0), f32_to_i16(0.5)]
    );
    let _ = std::fs::remove_file(&path);
  }

  fn unique_suffix() -> u64 {
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos() as u64
  }
}
