//! PCM WAV writing.
//!
//! The file is always mono, 16-bit little-endian, at [`OUTPUT_SAMPLE_RATE`].
//! [`WavFile::checkpoint`] rewrites the header so a later crash-recovery pass
//! can read a partial take, and [`WavFile::finalize`] closes it.
//! [`repair_wav_header`] rebuilds that header from the bytes actually on disk
//! when the process died before the last checkpoint.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
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

pub struct RepairedWav {
  pub frames: u64,
  /// Byte offset of the PCM. The repair test reads this; the library itself does not.
  #[allow(dead_code)]
  pub data_start: u64,
}

/// Point the header at the PCM that is actually in the file.
///
/// Data length is the file size minus the header, trimmed down to a whole
/// number of frames. A trailing partial frame is cut off. The RIFF size is
/// rewritten to match.
pub fn repair_wav_header(path: &Path) -> Result<RepairedWav, RecorderError> {
  let mut file = OpenOptions::new()
    .read(true)
    .write(true)
    .open(path)
    .map_err(|error| RecorderError::Write(format!("could not open {}: {error}", path.display())))?;
  let len = file
    .metadata()
    .map_err(|error| RecorderError::Write(error.to_string()))?
    .len();
  if len < 12 {
    return Err(RecorderError::Write(format!(
      "{} is too short to be a WAV file",
      path.display()
    )));
  }
  let mut riff = [0u8; 12];
  file
    .read_exact(&mut riff)
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
    return Err(RecorderError::Write(format!(
      "{} is not a WAV file",
      path.display()
    )));
  }
  let mut offset = 12u64;
  let mut channels = 1u16;
  let mut bits = 16u16;
  let mut data_start = None;
  while offset + 8 <= len {
    file
      .seek(SeekFrom::Start(offset))
      .map_err(|error| RecorderError::Write(error.to_string()))?;
    let mut chunk = [0u8; 8];
    file
      .read_exact(&mut chunk)
      .map_err(|error| RecorderError::Write(error.to_string()))?;
    let size = u64::from(u32::from_le_bytes(chunk[4..8].try_into().unwrap()));
    if &chunk[0..4] == b"fmt " && size >= 16 && offset + 8 + 16 <= len {
      let mut fmt = [0u8; 16];
      file
        .read_exact(&mut fmt)
        .map_err(|error| RecorderError::Write(error.to_string()))?;
      channels = u16::from_le_bytes(fmt[2..4].try_into().unwrap()).max(1);
      bits = u16::from_le_bytes(fmt[14..16].try_into().unwrap());
    }
    if &chunk[0..4] == b"data" {
      data_start = Some(offset + 8);
      break;
    }
    let padded = size + (size & 1);
    offset = offset.saturating_add(8).saturating_add(padded);
  }
  let data_start = data_start.ok_or_else(|| {
    RecorderError::Write(format!("{} has no data chunk", path.display()))
  })?;
  if bits < 8 || bits % 8 != 0 {
    return Err(RecorderError::Write(format!(
      "{} has an unsupported sample width",
      path.display()
    )));
  }
  let frame = u64::from(channels) * u64::from(bits / 8);
  let available = len.saturating_sub(data_start);
  let data_len = available - (available % frame.max(1));
  if data_len > u64::from(u32::MAX) {
    return Err(RecorderError::Write(format!(
      "{} is too long for a WAV header",
      path.display()
    )));
  }
  file
    .seek(SeekFrom::Start(data_start - 4))
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  file
    .write_all(&(data_len as u32).to_le_bytes())
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  let riff_end = data_start.saturating_add(data_len);
  let riff_size = riff_end.saturating_sub(8) as u32;
  file
    .seek(SeekFrom::Start(4))
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  file
    .write_all(&riff_size.to_le_bytes())
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  file
    .set_len(riff_end)
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  file
    .sync_all()
    .map_err(|error| RecorderError::Write(error.to_string()))?;
  Ok(RepairedWav {
    frames: data_len / frame.max(1),
    data_start,
  })
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

  #[test]
  fn repair_trims_a_truncated_file_to_whole_frames() {
    let path = std::env::temp_dir().join(format!(
      "teleprompter-repair-{}-{}.wav",
      std::process::id(),
      unique_suffix()
    ));
    let samples = [1i16, -2, 3, -4, 5];
    let mut wav = WavFile::create(&path).unwrap();
    for sample in samples {
      wav.write_i16(sample).unwrap();
    }
    wav.finalize().unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.push(0x7f);
    let claim = 100u32;
    let riff_size = (bytes.len() as u32).saturating_sub(8);
    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
    bytes[40..44].copy_from_slice(&claim.to_le_bytes());
    std::fs::write(&path, &bytes).unwrap();

    let repaired = repair_wav_header(&path).unwrap();
    assert_eq!(repaired.frames, samples.len() as u64);
    assert_eq!(repaired.data_start, 44);
    let mut reader = hound::WavReader::open(&path).unwrap();
    assert_eq!(reader.duration(), samples.len() as u32);
    let pcm: Vec<i16> = reader.samples::<i16>().map(|sample| sample.unwrap()).collect();
    assert_eq!(pcm, samples);
    let fixed = std::fs::read(&path).unwrap();
    assert_eq!(fixed.len(), 44 + samples.len() * 2);
    assert_eq!(&fixed[36..40], b"data");
    let data_bytes = u32::from_le_bytes(fixed[40..44].try_into().unwrap());
    assert_eq!(data_bytes, samples.len() as u32 * 2);
    let _ = std::fs::remove_file(&path);
  }

  fn unique_suffix() -> u64 {
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos() as u64
  }
}
