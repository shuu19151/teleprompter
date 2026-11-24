//! AAC-LC in a faststart M4A file.
//!
//! Fraunhofer FDK AAC encodes mono 48 kHz PCM at 96 kbps. A live take feeds
//! [`AacStream`] on the writer thread while the WAV segments are written, then
//! [`mux_encoded`] builds the container when the take stops. [`encode_aac_lc`]
//! still encodes a whole buffer in one pass for crash recovery, which has no
//! streamed frames. The container is written here, not by ffmpeg: `ftyp`
//! major brand `M4A `, `moov` before `mdat`, and an edit list so the duration
//! stays on the recorded length instead of the encoder delay. The license
//! notice ships in `licenses/FDK-AAC-NOTICE`.

use fdk_aac::dec::{Decoder, DecoderError, Transport as DecTransport};
use fdk_aac::enc::{AudioObjectType, BitRate, ChannelMode, Encoder, EncoderParams, Transport};

use super::RecorderError;

pub const BITRATE: u32 = 96_000;
pub const SAMPLE_RATE: u32 = 48_000;
/// AAC-LC frame, in samples. The encoder is asked for this and rejected otherwise.
pub const FRAME_SAMPLES: u64 = 1_024;
/// Presented duration may sit this far from the PCM length. 50 ms at 48 kHz.
pub const DURATION_TOLERANCE: u64 = 2_400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M4aInfo {
  pub major_brand: [u8; 4],
  pub faststart: bool,
  pub channels: u16,
  pub sample_rate: u32,
  pub audio_object_type: u8,
  pub presented_samples: u64,
  pub media_samples: u64,
  pub payload_bytes: u64,
  pub avg_bitrate: u32,
}

/// AAC access units produced while a take was recording.
///
/// `pcm_frames` counts samples fed to the encoder, not the delay padding.
/// `delay` is the priming the edit list skips.
#[derive(Debug, Clone)]
pub struct EncodedAac {
  pub frames: Vec<Vec<u8>>,
  pub pcm_frames: u64,
  pub delay: u64,
  pub asc: Vec<u8>,
}

impl EncodedAac {
  pub fn is_empty(&self) -> bool {
    self.pcm_frames == 0 || self.frames.is_empty()
  }
}

/// Incremental AAC-LC encoder.
///
/// Push the same PCM the WAV writer stores. A pause is a gap between pushes:
/// the encoder is not reset, so resume continues the same bitstream. Call
/// [`AacStream::finish`] once, on the writer thread, when the take stops.
pub struct AacStream {
  encoder: Encoder,
  frame_len: usize,
  delay: usize,
  asc: Vec<u8>,
  packet: Vec<u8>,
  pending: Vec<i16>,
  frames: Vec<Vec<u8>>,
  pcm_frames: u64,
}

impl AacStream {
  pub fn new() -> Result<Self, RecorderError> {
    let (encoder, frame_len, delay, asc, packet) = open_encoder()?;
    Ok(Self {
      encoder,
      frame_len,
      delay,
      asc,
      packet,
      pending: Vec::with_capacity(frame_len * 2),
      frames: Vec::new(),
      pcm_frames: 0,
    })
  }

  #[cfg(test)]
  pub fn push(&mut self, samples: &[i16]) -> Result<(), RecorderError> {
    if samples.is_empty() {
      return Ok(());
    }
    self.pcm_frames = self.pcm_frames.saturating_add(samples.len() as u64);
    self.pending.extend_from_slice(samples);
    self.drain()
  }

  pub fn push_sample(&mut self, sample: i16) -> Result<(), RecorderError> {
    self.pcm_frames = self.pcm_frames.saturating_add(1);
    self.pending.push(sample);
    if self.pending.len() >= self.frame_len {
      self.drain()?;
    }
    Ok(())
  }

  fn drain(&mut self) -> Result<(), RecorderError> {
    while self.pending.len() >= self.frame_len {
      self.pump()?;
    }
    Ok(())
  }

  /// Encode one access unit from the front of `pending`.
  ///
  /// The call is given only one frame. FDK reads `numInSamples` from the
  /// slice length, and a longer slice would let a one-shot encode see samples
  /// the live encoder has not received yet.
  fn pump(&mut self) -> Result<(), RecorderError> {
    let view_len = self.pending.len().min(self.frame_len);
    let encoded = self
      .encoder
      .encode(&self.pending[..view_len], &mut self.packet)
      .map_err(|error| RecorderError::Write(format!("could not encode AAC: {error}")))?;
    if encoded.input_consumed == 0 || encoded.input_consumed > view_len {
      return Err(RecorderError::Write(
        "the AAC encoder stopped consuming audio".into(),
      ));
    }
    if encoded.output_size > self.packet.len() {
      return Err(RecorderError::Write(
        "the AAC encoder wrote past its output buffer".into(),
      ));
    }
    if encoded.output_size > 0 {
      self
        .frames
        .push(self.packet[..encoded.output_size].to_vec());
    }
    self.pending.drain(..encoded.input_consumed);
    Ok(())
  }

  pub fn finish(mut self) -> Result<EncodedAac, RecorderError> {
    if self.pcm_frames > 0 {
      let total = (self.pcm_frames as usize).saturating_add(self.delay);
      let padded = total.div_ceil(self.frame_len) * self.frame_len;
      let extra = padded.saturating_sub(self.pcm_frames as usize);
      self.pending.extend(std::iter::repeat(0).take(extra));
      while !self.pending.is_empty() {
        self.pump()?;
      }
    }
    if self.pcm_frames > 0 && self.frames.is_empty() {
      return Err(RecorderError::Write(
        "the AAC encoder produced no audio".into(),
      ));
    }
    Ok(EncodedAac {
      frames: self.frames,
      pcm_frames: self.pcm_frames,
      delay: self.delay as u64,
      asc: self.asc,
    })
  }
}

fn open_encoder() -> Result<(Encoder, usize, usize, Vec<u8>, Vec<u8>), RecorderError> {
  let encoder = Encoder::new(EncoderParams {
    bit_rate: BitRate::Cbr(BITRATE),
    sample_rate: SAMPLE_RATE,
    transport: Transport::Raw,
    channels: ChannelMode::Mono,
    audio_object_type: AudioObjectType::Mpeg4LowComplexity,
  })
  .map_err(|error| RecorderError::Write(format!("could not start the AAC encoder: {error}")))?;
  let info = encoder
    .info()
    .map_err(|error| RecorderError::Write(format!("could not read the AAC encoder: {error}")))?;
  let frame_len = info.frameLength as usize;
  if frame_len == 0 || frame_len as u64 != FRAME_SAMPLES {
    return Err(RecorderError::Write(format!(
      "the AAC encoder frame is {frame_len} samples, not {FRAME_SAMPLES}"
    )));
  }
  let delay = info.nDelay as usize;
  let conf_size = info.confSize as usize;
  if conf_size == 0 || conf_size > info.confBuf.len() {
    return Err(RecorderError::Write(
      "the AAC encoder did not return a config".into(),
    ));
  }
  let asc = info.confBuf[..conf_size].to_vec();
  if audio_object_type(&asc) != Some(2) {
    return Err(RecorderError::Write("the AAC encoder is not AAC-LC".into()));
  }
  let packet = vec![0u8; info.maxOutBufBytes.max(8192) as usize];
  Ok((encoder, frame_len, delay, asc, packet))
}

pub fn mux_encoded(encoded: &EncodedAac) -> Result<Vec<u8>, RecorderError> {
  if encoded.is_empty() {
    return Err(RecorderError::Write("there is no audio to encode".into()));
  }
  mux_m4a(
    &encoded.frames,
    encoded.pcm_frames,
    encoded.delay,
    &encoded.asc,
  )
}

pub fn encode_aac_lc(pcm: &[i16]) -> Result<Vec<u8>, RecorderError> {
  if pcm.is_empty() {
    return Err(RecorderError::Write("there is no audio to encode".into()));
  }
  let encoder = Encoder::new(EncoderParams {
    bit_rate: BitRate::Cbr(BITRATE),
    sample_rate: SAMPLE_RATE,
    transport: Transport::Raw,
    channels: ChannelMode::Mono,
    audio_object_type: AudioObjectType::Mpeg4LowComplexity,
  })
  .map_err(|error| RecorderError::Write(format!("could not start the AAC encoder: {error}")))?;
  let info = encoder
    .info()
    .map_err(|error| RecorderError::Write(format!("could not read the AAC encoder: {error}")))?;
  let frame_len = info.frameLength as usize;
  if frame_len == 0 || frame_len as u64 != FRAME_SAMPLES {
    return Err(RecorderError::Write(format!(
      "the AAC encoder frame is {frame_len} samples, not {FRAME_SAMPLES}"
    )));
  }
  let delay = info.nDelay as usize;
  let conf_size = info.confSize as usize;
  if conf_size == 0 || conf_size > info.confBuf.len() {
    return Err(RecorderError::Write(
      "the AAC encoder did not return a config".into(),
    ));
  }
  let asc = info.confBuf[..conf_size].to_vec();
  if audio_object_type(&asc) != Some(2) {
    return Err(RecorderError::Write("the AAC encoder is not AAC-LC".into()));
  }

  // Padding by the encoder delay pushes the real samples out of the codec.
  // The edit list skips that delay and keeps the recorded length.
  let total = pcm.len().saturating_add(delay);
  let padded_len = total.div_ceil(frame_len) * frame_len;
  let mut input = vec![0i16; padded_len];
  input[..pcm.len()].copy_from_slice(pcm);

  let mut packet = vec![0u8; info.maxOutBufBytes.max(8192) as usize];
  let mut frames = Vec::new();
  let mut offset = 0;
  while offset < input.len() {
    let encoded = encoder
      .encode(&input[offset..], &mut packet)
      .map_err(|error| RecorderError::Write(format!("could not encode AAC: {error}")))?;
    if encoded.input_consumed == 0 {
      return Err(RecorderError::Write(
        "the AAC encoder stopped consuming audio".into(),
      ));
    }
    if encoded.output_size > 0 {
      frames.push(packet[..encoded.output_size].to_vec());
    }
    offset += encoded.input_consumed;
  }
  if frames.is_empty() {
    return Err(RecorderError::Write(
      "the AAC encoder produced no audio".into(),
    ));
  }
  mux_m4a(&frames, pcm.len() as u64, delay as u64, &asc)
}

#[cfg(test)]
pub fn verify_m4a(bytes: &[u8], pcm_frames: u64) -> Result<M4aInfo, RecorderError> {
  let info = check_container(bytes, pcm_frames)?;
  let decoded = decode_payload(bytes)?;
  check_decoded(&decoded)?;
  Ok(info)
}

/// Container parse plus the first and last few access units.
///
/// Stop uses this once, on the file that was just renamed into place. It does
/// not decode the rest of the take.
pub fn verify_m4a_light(bytes: &[u8], pcm_frames: u64) -> Result<M4aInfo, RecorderError> {
  let info = check_container(bytes, pcm_frames)?;
  let decoded = decode_edges(bytes)?;
  check_decoded(&decoded)?;
  Ok(info)
}

fn check_container(bytes: &[u8], pcm_frames: u64) -> Result<M4aInfo, RecorderError> {
  if bytes.is_empty() {
    return Err(RecorderError::Write("the m4a file is empty".into()));
  }
  let info = inspect(bytes)?;
  if info.major_brand != *b"M4A " {
    return Err(RecorderError::Write("the m4a brand is not M4A".into()));
  }
  if !info.faststart {
    return Err(RecorderError::Write("the m4a is not faststart".into()));
  }
  if info.channels != 1 || info.sample_rate != SAMPLE_RATE {
    return Err(RecorderError::Write("the m4a is not 48 kHz mono".into()));
  }
  if info.audio_object_type != 2 {
    return Err(RecorderError::Write("the m4a is not AAC-LC".into()));
  }
  if pcm_frames > 0 && info.presented_samples == 0 {
    return Err(RecorderError::Write("the m4a duration is empty".into()));
  }
  if info.presented_samples.abs_diff(pcm_frames) > DURATION_TOLERANCE {
    return Err(RecorderError::Write(format!(
      "the m4a duration is {} samples, the recording is {pcm_frames}",
      info.presented_samples
    )));
  }
  Ok(info)
}

fn check_decoded(decoded: &Decoded) -> Result<(), RecorderError> {
  if decoded.samples == 0 {
    return Err(RecorderError::Write("the m4a could not be decoded".into()));
  }
  if decoded.rate != SAMPLE_RATE as i32 || decoded.channels != 1 {
    return Err(RecorderError::Write(
      "the decoded m4a is not 48 kHz mono".into(),
    ));
  }
  Ok(())
}

pub fn inspect(bytes: &[u8]) -> Result<M4aInfo, RecorderError> {
  let top = read_boxes(bytes).map_err(|error| RecorderError::Write(error))?;
  let ftyp =
    find_box(&top, *b"ftyp").ok_or_else(|| RecorderError::Write("the m4a has no ftyp".into()))?;
  if ftyp.payload.len() < 4 {
    return Err(RecorderError::Write("the m4a brand is missing".into()));
  }
  let mut major_brand = [0u8; 4];
  major_brand.copy_from_slice(&ftyp.payload[..4]);
  let moov =
    find_box(&top, *b"moov").ok_or_else(|| RecorderError::Write("the m4a has no moov".into()))?;
  let mdat =
    find_box(&top, *b"mdat").ok_or_else(|| RecorderError::Write("the m4a has no mdat".into()))?;
  let faststart = moov.start < mdat.start;
  let moov_boxes = read_boxes(moov.payload).map_err(|error| RecorderError::Write(error))?;
  let mvhd = find_box(&moov_boxes, *b"mvhd")
    .ok_or_else(|| RecorderError::Write("the m4a has no mvhd".into()))?;
  let (movie_scale, movie_duration) = movie_header(mvhd.payload)?;
  let trak = find_box(&moov_boxes, *b"trak")
    .ok_or_else(|| RecorderError::Write("the m4a has no trak".into()))?;
  let trak_boxes = read_boxes(trak.payload).map_err(|error| RecorderError::Write(error))?;
  let presented_samples = if let Some(edts) = find_box(&trak_boxes, *b"edts") {
    let edit = read_boxes(edts.payload).map_err(|error| RecorderError::Write(error))?;
    let elst = find_box(&edit, *b"elst")
      .ok_or_else(|| RecorderError::Write("the m4a edit list is empty".into()))?;
    edit_samples(elst.payload, movie_scale)?
  } else if movie_scale == 0 {
    0
  } else {
    movie_duration.saturating_mul(u64::from(SAMPLE_RATE)) / u64::from(movie_scale)
  };

  let mdia = find_box(&trak_boxes, *b"mdia")
    .ok_or_else(|| RecorderError::Write("the m4a has no mdia".into()))?;
  let mdia_boxes = read_boxes(mdia.payload).map_err(|error| RecorderError::Write(error))?;
  let mdhd = find_box(&mdia_boxes, *b"mdhd")
    .ok_or_else(|| RecorderError::Write("the m4a has no mdhd".into()))?;
  let (media_scale, media_duration) = media_header(mdhd.payload)?;
  let media_samples = if media_scale == 0 {
    0
  } else {
    media_duration.saturating_mul(u64::from(SAMPLE_RATE)) / u64::from(media_scale)
  };
  let minf = find_box(&mdia_boxes, *b"minf")
    .ok_or_else(|| RecorderError::Write("the m4a has no minf".into()))?;
  let minf_boxes = read_boxes(minf.payload).map_err(|error| RecorderError::Write(error))?;
  let stbl = find_box(&minf_boxes, *b"stbl")
    .ok_or_else(|| RecorderError::Write("the m4a has no stbl".into()))?;
  let stbl_boxes = read_boxes(stbl.payload).map_err(|error| RecorderError::Write(error))?;
  let stsd = find_box(&stbl_boxes, *b"stsd")
    .ok_or_else(|| RecorderError::Write("the m4a has no stsd".into()))?;
  let (channels, sample_rate, asc, avg_bitrate) = audio_entry(stsd.payload)?;
  let audio_object_type = audio_object_type(&asc).unwrap_or(0);
  Ok(M4aInfo {
    major_brand,
    faststart,
    channels,
    sample_rate,
    audio_object_type,
    presented_samples,
    media_samples,
    payload_bytes: mdat.payload.len() as u64,
    avg_bitrate,
  })
}

fn mux_m4a(
  frames: &[Vec<u8>],
  pcm_frames: u64,
  delay: u64,
  asc: &[u8],
) -> Result<Vec<u8>, RecorderError> {
  let frame_samples = FRAME_SAMPLES;
  let media_samples = frames.len() as u64 * frame_samples;
  let delay = delay.min(media_samples);
  let presented = pcm_frames.min(media_samples.saturating_sub(delay));
  if presented == 0 {
    return Err(RecorderError::Write(
      "the encoded audio has no duration".into(),
    ));
  }
  let ftyp = ftyp();
  let moov_bytes = moov(frames, presented, delay, media_samples, asc, 0);
  let data_start = (ftyp.len() + moov_bytes.len() + 8) as u64;
  let moov_bytes = moov(frames, presented, delay, media_samples, asc, data_start);
  let mut bytes = Vec::with_capacity(
    ftyp.len() + moov_bytes.len() + 8 + frames.iter().map(Vec::len).sum::<usize>(),
  );
  bytes.extend_from_slice(&ftyp);
  bytes.extend_from_slice(&moov_bytes);
  let mut payload = Vec::new();
  for frame in frames {
    payload.extend_from_slice(frame);
  }
  bytes.extend_from_slice(&box_of(*b"mdat", &payload));
  Ok(bytes)
}

fn ftyp() -> Vec<u8> {
  let mut payload = Vec::new();
  payload.extend_from_slice(b"M4A ");
  push_u32(&mut payload, 0);
  for brand in [b"M4A ", b"isom", b"iso2", b"mp41"] {
    payload.extend_from_slice(brand);
  }
  box_of(*b"ftyp", &payload)
}

fn moov(
  frames: &[Vec<u8>],
  presented: u64,
  delay: u64,
  media_samples: u64,
  asc: &[u8],
  data_start: u64,
) -> Vec<u8> {
  let mvhd = full_box(*b"mvhd", 0, &{
    let mut body = Vec::new();
    push_u32(&mut body, 0);
    push_u32(&mut body, 0);
    push_u32(&mut body, SAMPLE_RATE);
    push_u32(&mut body, presented as u32);
    push_u32(&mut body, 0x0001_0000);
    push_u16(&mut body, 0x0100);
    push_u16(&mut body, 0);
    push_u32(&mut body, 0);
    push_u32(&mut body, 0);
    body.extend_from_slice(&matrix());
    body.extend_from_slice(&[0u8; 24]);
    push_u32(&mut body, 2);
    body
  });
  let trak = trak(frames, presented, delay, media_samples, asc, data_start);
  let mut payload = Vec::new();
  payload.extend_from_slice(&mvhd);
  payload.extend_from_slice(&trak);
  box_of(*b"moov", &payload)
}

fn trak(
  frames: &[Vec<u8>],
  presented: u64,
  delay: u64,
  media_samples: u64,
  asc: &[u8],
  data_start: u64,
) -> Vec<u8> {
  let tkhd = full_box(*b"tkhd", 0x3, &{
    let mut body = Vec::new();
    push_u32(&mut body, 0);
    push_u32(&mut body, 0);
    push_u32(&mut body, 1);
    push_u32(&mut body, 0);
    push_u32(&mut body, presented as u32);
    body.extend_from_slice(&[0u8; 8]);
    push_u16(&mut body, 0);
    push_u16(&mut body, 0);
    push_u16(&mut body, 0x0100);
    push_u16(&mut body, 0);
    body.extend_from_slice(&matrix());
    push_u32(&mut body, 0);
    push_u32(&mut body, 0);
    body
  });
  let elst = full_box(*b"elst", 0, &{
    let mut body = Vec::new();
    push_u32(&mut body, 1);
    push_u32(&mut body, presented as u32);
    push_i32(&mut body, delay as i32);
    push_u32(&mut body, 0x0001_0000);
    body
  });
  let edts = box_of(*b"edts", &elst);
  let mdia = mdia(frames, media_samples, asc, data_start);
  let mut payload = Vec::new();
  payload.extend_from_slice(&tkhd);
  payload.extend_from_slice(&edts);
  payload.extend_from_slice(&mdia);
  box_of(*b"trak", &payload)
}

fn mdia(frames: &[Vec<u8>], media_samples: u64, asc: &[u8], data_start: u64) -> Vec<u8> {
  let mdhd = full_box(*b"mdhd", 0, &{
    let mut body = Vec::new();
    push_u32(&mut body, 0);
    push_u32(&mut body, 0);
    push_u32(&mut body, SAMPLE_RATE);
    push_u32(&mut body, media_samples as u32);
    push_u16(&mut body, 0x55c4);
    push_u16(&mut body, 0);
    body
  });
  let name = b"SoundHandler\0";
  let mut hdlr_body = Vec::new();
  push_u32(&mut hdlr_body, 0);
  hdlr_body.extend_from_slice(b"soun");
  hdlr_body.extend_from_slice(&[0u8; 12]);
  hdlr_body.extend_from_slice(name);
  let hdlr = full_box(*b"hdlr", 0, &hdlr_body);
  let minf = minf(frames, asc, data_start);
  let mut payload = Vec::new();
  payload.extend_from_slice(&mdhd);
  payload.extend_from_slice(&hdlr);
  payload.extend_from_slice(&minf);
  box_of(*b"mdia", &payload)
}

fn minf(frames: &[Vec<u8>], asc: &[u8], data_start: u64) -> Vec<u8> {
  let smhd = full_box(*b"smhd", 0, &[0, 0, 0, 0]);
  let url = full_box(*b"url ", 1, &[]);
  let mut dref_body = Vec::new();
  push_u32(&mut dref_body, 1);
  dref_body.extend_from_slice(&url);
  let dref = full_box(*b"dref", 0, &dref_body);
  let dinf = box_of(*b"dinf", &dref);
  let stbl = stbl(frames, asc, data_start);
  let mut payload = Vec::new();
  payload.extend_from_slice(&smhd);
  payload.extend_from_slice(&dinf);
  payload.extend_from_slice(&stbl);
  box_of(*b"minf", &payload)
}

fn stbl(frames: &[Vec<u8>], asc: &[u8], data_start: u64) -> Vec<u8> {
  let entry = mp4a_entry(asc);
  let mut stsd_body = Vec::new();
  push_u32(&mut stsd_body, 1);
  stsd_body.extend_from_slice(&entry);
  let stsd = full_box(*b"stsd", 0, &stsd_body);
  let mut stts_body = Vec::new();
  push_u32(&mut stts_body, 1);
  push_u32(&mut stts_body, frames.len() as u32);
  push_u32(&mut stts_body, FRAME_SAMPLES as u32);
  let stts = full_box(*b"stts", 0, &stts_body);
  let mut stsc_body = Vec::new();
  push_u32(&mut stsc_body, 1);
  push_u32(&mut stsc_body, 1);
  push_u32(&mut stsc_body, frames.len() as u32);
  push_u32(&mut stsc_body, 1);
  let stsc = full_box(*b"stsc", 0, &stsc_body);
  let mut stsz_body = Vec::new();
  push_u32(&mut stsz_body, 0);
  push_u32(&mut stsz_body, frames.len() as u32);
  for frame in frames {
    push_u32(&mut stsz_body, frame.len() as u32);
  }
  let stsz = full_box(*b"stsz", 0, &stsz_body);
  let mut stco_body = Vec::new();
  push_u32(&mut stco_body, 1);
  push_u32(&mut stco_body, data_start as u32);
  let stco = full_box(*b"stco", 0, &stco_body);
  let mut payload = Vec::new();
  payload.extend_from_slice(&stsd);
  payload.extend_from_slice(&stts);
  payload.extend_from_slice(&stsc);
  payload.extend_from_slice(&stsz);
  payload.extend_from_slice(&stco);
  box_of(*b"stbl", &payload)
}

fn mp4a_entry(asc: &[u8]) -> Vec<u8> {
  let esds = esds(asc);
  let mut body = Vec::new();
  body.extend_from_slice(&[0u8; 6]);
  push_u16(&mut body, 1);
  push_u16(&mut body, 0);
  push_u16(&mut body, 0);
  push_u32(&mut body, 0);
  push_u16(&mut body, 1);
  push_u16(&mut body, 16);
  push_u16(&mut body, 0);
  push_u16(&mut body, 0);
  push_u32(&mut body, SAMPLE_RATE << 16);
  body.extend_from_slice(&esds);
  box_of(*b"mp4a", &body)
}

fn esds(asc: &[u8]) -> Vec<u8> {
  let specific = descriptor(0x05, asc);
  let mut decoder = Vec::new();
  decoder.push(0x40);
  decoder.push(0x15);
  decoder.extend_from_slice(&[0, 0, 0]);
  push_u32(&mut decoder, BITRATE);
  push_u32(&mut decoder, BITRATE);
  decoder.extend_from_slice(&specific);
  let config = descriptor(0x04, &decoder);
  let sl = descriptor(0x06, &[0x02]);
  let mut es = Vec::new();
  push_u16(&mut es, 0);
  es.push(0);
  es.extend_from_slice(&config);
  es.extend_from_slice(&sl);
  let es_desc = descriptor(0x03, &es);
  full_box(*b"esds", 0, &es_desc)
}

fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
  let mut out = vec![tag];
  let mut size = body.len();
  let mut bytes = [0u8; 4];
  let mut count = 0;
  loop {
    bytes[count] = (size & 0x7f) as u8;
    size >>= 7;
    count += 1;
    if size == 0 || count == 4 {
      break;
    }
  }
  for index in (0..count).rev() {
    let mut byte = bytes[index];
    if index != 0 {
      byte |= 0x80;
    }
    out.push(byte);
  }
  out.extend_from_slice(body);
  out
}

fn matrix() -> Vec<u8> {
  let mut out = Vec::with_capacity(36);
  for value in [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
    push_u32(&mut out, value);
  }
  out
}

fn audio_object_type(asc: &[u8]) -> Option<u8> {
  let first = *asc.first()?;
  Some(first >> 3)
}

struct Found<'a> {
  start: usize,
  payload: &'a [u8],
}

fn find_box<'a>(boxes: &[FoundBox<'a>], kind: [u8; 4]) -> Option<Found<'a>> {
  boxes
    .iter()
    .find(|item| item.kind == kind)
    .map(|item| Found {
      start: item.start,
      payload: item.payload,
    })
}

struct FoundBox<'a> {
  kind: [u8; 4],
  start: usize,
  payload: &'a [u8],
}

fn read_boxes(data: &[u8]) -> Result<Vec<FoundBox<'_>>, String> {
  let mut boxes = Vec::new();
  let mut offset = 0;
  while offset + 8 <= data.len() {
    let size = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
    let mut kind = [0u8; 4];
    kind.copy_from_slice(&data[offset + 4..offset + 8]);
    if size < 8 || offset + size > data.len() {
      return Err(format!(
        "a {} box is truncated",
        String::from_utf8_lossy(&kind)
      ));
    }
    boxes.push(FoundBox {
      kind,
      start: offset,
      payload: &data[offset + 8..offset + size],
    });
    offset += size;
  }
  Ok(boxes)
}

fn movie_header(payload: &[u8]) -> Result<(u32, u64), RecorderError> {
  versioned_time(payload, "mvhd")
}

fn media_header(payload: &[u8]) -> Result<(u32, u64), RecorderError> {
  versioned_time(payload, "mdhd")
}

fn versioned_time(payload: &[u8], name: &str) -> Result<(u32, u64), RecorderError> {
  if payload.is_empty() {
    return Err(RecorderError::Write(format!("the m4a {name} is empty")));
  }
  let version = payload[0];
  let body = &payload[4..];
  if version == 0 {
    if body.len() < 16 {
      return Err(RecorderError::Write(format!("the m4a {name} is short")));
    }
    let scale = u32::from_be_bytes(body[8..12].try_into().unwrap());
    let duration = u32::from_be_bytes(body[12..16].try_into().unwrap()) as u64;
    Ok((scale, duration))
  } else if version == 1 {
    if body.len() < 28 {
      return Err(RecorderError::Write(format!("the m4a {name} is short")));
    }
    let scale = u32::from_be_bytes(body[16..20].try_into().unwrap());
    let duration = u64::from_be_bytes(body[20..28].try_into().unwrap());
    Ok((scale, duration))
  } else {
    Err(RecorderError::Write(format!(
      "the m4a {name} version is unsupported"
    )))
  }
}

fn edit_samples(payload: &[u8], movie_scale: u32) -> Result<u64, RecorderError> {
  if payload.len() < 8 {
    return Err(RecorderError::Write("the m4a edit list is short".into()));
  }
  let version = payload[0];
  let body = &payload[4..];
  let count = u32::from_be_bytes(body[..4].try_into().unwrap());
  if count == 0 {
    return Ok(0);
  }
  let duration = if version == 0 {
    if body.len() < 16 {
      return Err(RecorderError::Write("the m4a edit list is short".into()));
    }
    u32::from_be_bytes(body[4..8].try_into().unwrap()) as u64
  } else if body.len() < 20 {
    return Err(RecorderError::Write("the m4a edit list is short".into()));
  } else {
    u64::from_be_bytes(body[4..12].try_into().unwrap())
  };
  if movie_scale == 0 {
    return Ok(0);
  }
  Ok(duration.saturating_mul(u64::from(SAMPLE_RATE)) / u64::from(movie_scale))
}

fn audio_entry(stsd: &[u8]) -> Result<(u16, u32, Vec<u8>, u32), RecorderError> {
  if stsd.len() < 8 {
    return Err(RecorderError::Write("the m4a sample table is short".into()));
  }
  let body = &stsd[4..];
  if body.len() < 4 {
    return Err(RecorderError::Write("the m4a sample table is short".into()));
  }
  let entry = &body[4..];
  if entry.len() < 36 {
    return Err(RecorderError::Write("the m4a sample entry is short".into()));
  }
  let kind = &entry[4..8];
  if kind != b"mp4a" {
    return Err(RecorderError::Write(
      "the m4a sample entry is not mp4a".into(),
    ));
  }
  let channels = u16::from_be_bytes(entry[24..26].try_into().unwrap());
  let rate_fixed = u32::from_be_bytes(entry[32..36].try_into().unwrap());
  let sample_rate = rate_fixed >> 16;
  let children = read_boxes(&entry[36..]).map_err(|error| RecorderError::Write(error))?;
  let esds = find_box(&children, *b"esds")
    .ok_or_else(|| RecorderError::Write("the m4a has no esds".into()))?;
  let (asc, avg_bitrate) = asc_and_bitrate(esds.payload)?;
  Ok((channels, sample_rate, asc, avg_bitrate))
}

fn asc_and_bitrate(esds: &[u8]) -> Result<(Vec<u8>, u32), RecorderError> {
  if esds.len() < 4 {
    return Err(RecorderError::Write("the m4a esds is short".into()));
  }
  let (tag, body, _) = read_descriptor(&esds[4..])
    .ok_or_else(|| RecorderError::Write("the m4a esds is short".into()))?;
  if tag != 0x03 || body.len() < 3 {
    return Err(RecorderError::Write(
      "the m4a elementary stream is missing".into(),
    ));
  }
  let (config_tag, config, _) = read_descriptor(&body[3..])
    .ok_or_else(|| RecorderError::Write("the m4a decoder config is missing".into()))?;
  if config_tag != 0x04 || config.len() < 13 {
    return Err(RecorderError::Write(
      "the m4a decoder config is short".into(),
    ));
  }
  let avg_bitrate = u32::from_be_bytes(config[9..13].try_into().unwrap());
  let (specific_tag, specific, _) = read_descriptor(&config[13..])
    .ok_or_else(|| RecorderError::Write("the m4a audio config is missing".into()))?;
  if specific_tag != 0x05 || specific.is_empty() {
    return Err(RecorderError::Write(
      "the m4a audio config is missing".into(),
    ));
  }
  Ok((specific.to_vec(), avg_bitrate))
}

fn read_descriptor(data: &[u8]) -> Option<(u8, &[u8], usize)> {
  if data.len() < 2 {
    return None;
  }
  let tag = data[0];
  let mut index = 1;
  let mut size = 0usize;
  for _ in 0..4 {
    if index >= data.len() {
      return None;
    }
    let byte = data[index];
    index += 1;
    size = (size << 7) | (byte & 0x7f) as usize;
    if byte & 0x80 == 0 {
      break;
    }
  }
  let end = index.checked_add(size)?;
  if end > data.len() {
    return None;
  }
  Some((tag, &data[index..end], end))
}

struct Decoded {
  samples: u64,
  rate: i32,
  channels: i32,
}

/// How many access units [`verify_m4a_light`] decodes at each end of the file.
const EDGE_FRAMES: usize = 3;

#[cfg(test)]
thread_local! {
  static FULL_DECODES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Full-file decodes on this thread. Stop must leave this unchanged.
#[cfg(test)]
pub fn full_decodes() -> u64 {
  FULL_DECODES.with(|cell| cell.get())
}

#[cfg(test)]
fn note_full_decode() {
  #[cfg(test)]
  FULL_DECODES.with(|cell| cell.set(cell.get().saturating_add(1)));
}

#[cfg(test)]
fn decode_payload(bytes: &[u8]) -> Result<Decoded, RecorderError> {
  note_full_decode();
  let top = read_boxes(bytes).map_err(|error| RecorderError::Write(error))?;
  let moov =
    find_box(&top, *b"moov").ok_or_else(|| RecorderError::Write("the m4a has no moov".into()))?;
  let mdat =
    find_box(&top, *b"mdat").ok_or_else(|| RecorderError::Write("the m4a has no mdat".into()))?;
  let frames = frame_bytes(moov.payload, mdat.payload)?;
  let asc = sample_asc(moov.payload)?;
  decode_frames(&frames, &asc)
}

fn decode_edges(bytes: &[u8]) -> Result<Decoded, RecorderError> {
  let top = read_boxes(bytes).map_err(|error| RecorderError::Write(error))?;
  let moov =
    find_box(&top, *b"moov").ok_or_else(|| RecorderError::Write("the m4a has no moov".into()))?;
  let mdat =
    find_box(&top, *b"mdat").ok_or_else(|| RecorderError::Write("the m4a has no mdat".into()))?;
  let sizes = sample_sizes(moov.payload)?;
  if sizes.is_empty() {
    return Err(RecorderError::Write("the m4a could not be decoded".into()));
  }
  let asc = sample_asc(moov.payload)?;
  let head_count = EDGE_FRAMES.min(sizes.len());
  let head = decode_range(mdat.payload, &sizes, 0, head_count, &asc)?;
  check_decoded(&head)?;
  if sizes.len() > head_count {
    let tail_count = EDGE_FRAMES.min(sizes.len());
    let start = sizes.len() - tail_count;
    if start >= head_count {
      let tail = decode_range(mdat.payload, &sizes, start, tail_count, &asc)?;
      check_decoded(&tail)?;
    }
  }
  Ok(head)
}

fn decode_range(
  mdat: &[u8],
  sizes: &[usize],
  start: usize,
  count: usize,
  asc: &[u8],
) -> Result<Decoded, RecorderError> {
  let frames = frames_at(mdat, sizes, start, count)?;
  decode_frames(&frames, asc)
}

fn frames_at(
  mdat: &[u8],
  sizes: &[usize],
  start: usize,
  count: usize,
) -> Result<Vec<Vec<u8>>, RecorderError> {
  let end_index = start.saturating_add(count).min(sizes.len());
  let mut offset = 0usize;
  let mut frames = Vec::with_capacity(end_index.saturating_sub(start));
  for (index, size) in sizes.iter().copied().enumerate() {
    if index >= end_index {
      break;
    }
    let next = offset.saturating_add(size);
    if next > mdat.len() {
      return Err(RecorderError::Write(
        "the m4a samples run past the file".into(),
      ));
    }
    if index >= start {
      frames.push(mdat[offset..next].to_vec());
    }
    offset = next;
  }
  Ok(frames)
}

fn decode_frames(frames: &[Vec<u8>], asc: &[u8]) -> Result<Decoded, RecorderError> {
  let mut decoder = Decoder::new(DecTransport::Raw);
  decoder.config_raw(asc).map_err(|error| {
    RecorderError::Write(format!("could not configure the AAC decoder: {error}"))
  })?;
  let mut pcm = vec![0i16; 4096];
  let mut samples = 0u64;
  let mut rate = 0i32;
  let mut channels = 0i32;
  for frame in frames {
    let mut rest = frame.as_slice();
    while !rest.is_empty() {
      let consumed = decoder
        .fill(rest)
        .map_err(|error| RecorderError::Write(format!("could not read AAC: {error}")))?;
      if consumed == 0 {
        return Err(RecorderError::Write(
          "the AAC decoder stopped reading".into(),
        ));
      }
      rest = &rest[consumed..];
      loop {
        match decoder.decode_frame(&mut pcm) {
          Ok(()) => {
            let stream = decoder.stream_info();
            rate = stream.sampleRate;
            channels = stream.numChannels;
            samples += stream.frameSize.max(0) as u64;
          }
          Err(error) if error == DecoderError::NOT_ENOUGH_BITS => break,
          Err(error) => {
            return Err(RecorderError::Write(format!(
              "could not decode the m4a: {error}"
            )));
          }
        }
      }
    }
  }
  Ok(Decoded {
    samples,
    rate,
    channels,
  })
}

fn sample_asc(moov: &[u8]) -> Result<Vec<u8>, RecorderError> {
  let moov_boxes = read_boxes(moov).map_err(|error| RecorderError::Write(error))?;
  let trak = find_box(&moov_boxes, *b"trak")
    .ok_or_else(|| RecorderError::Write("the m4a has no trak".into()))?;
  let trak_boxes = read_boxes(trak.payload).map_err(|error| RecorderError::Write(error))?;
  let mdia = find_box(&trak_boxes, *b"mdia")
    .ok_or_else(|| RecorderError::Write("the m4a has no mdia".into()))?;
  let mdia_boxes = read_boxes(mdia.payload).map_err(|error| RecorderError::Write(error))?;
  let minf = find_box(&mdia_boxes, *b"minf")
    .ok_or_else(|| RecorderError::Write("the m4a has no minf".into()))?;
  let minf_boxes = read_boxes(minf.payload).map_err(|error| RecorderError::Write(error))?;
  let stbl = find_box(&minf_boxes, *b"stbl")
    .ok_or_else(|| RecorderError::Write("the m4a has no stbl".into()))?;
  let stbl_boxes = read_boxes(stbl.payload).map_err(|error| RecorderError::Write(error))?;
  let stsd = find_box(&stbl_boxes, *b"stsd")
    .ok_or_else(|| RecorderError::Write("the m4a has no stsd".into()))?;
  let (_, _, asc, _) = audio_entry(stsd.payload)?;
  Ok(asc)
}

#[cfg(test)]
fn frame_bytes(moov: &[u8], mdat: &[u8]) -> Result<Vec<Vec<u8>>, RecorderError> {
  let sizes = sample_sizes(moov)?;
  let mut frames = Vec::with_capacity(sizes.len());
  let mut offset = 0usize;
  for size in sizes {
    let end = offset + size;
    if end > mdat.len() {
      return Err(RecorderError::Write(
        "the m4a samples run past the file".into(),
      ));
    }
    frames.push(mdat[offset..end].to_vec());
    offset = end;
  }
  Ok(frames)
}

fn sample_sizes(moov: &[u8]) -> Result<Vec<usize>, RecorderError> {
  let moov_boxes = read_boxes(moov).map_err(|error| RecorderError::Write(error))?;
  let trak = find_box(&moov_boxes, *b"trak")
    .ok_or_else(|| RecorderError::Write("the m4a has no trak".into()))?;
  let trak_boxes = read_boxes(trak.payload).map_err(|error| RecorderError::Write(error))?;
  let mdia = find_box(&trak_boxes, *b"mdia")
    .ok_or_else(|| RecorderError::Write("the m4a has no mdia".into()))?;
  let mdia_boxes = read_boxes(mdia.payload).map_err(|error| RecorderError::Write(error))?;
  let minf = find_box(&mdia_boxes, *b"minf")
    .ok_or_else(|| RecorderError::Write("the m4a has no minf".into()))?;
  let minf_boxes = read_boxes(minf.payload).map_err(|error| RecorderError::Write(error))?;
  let stbl = find_box(&minf_boxes, *b"stbl")
    .ok_or_else(|| RecorderError::Write("the m4a has no stbl".into()))?;
  let stbl_boxes = read_boxes(stbl.payload).map_err(|error| RecorderError::Write(error))?;
  let stsz = find_box(&stbl_boxes, *b"stsz")
    .ok_or_else(|| RecorderError::Write("the m4a has no stsz".into()))?;
  let payload = stsz.payload;
  if payload.len() < 12 {
    return Err(RecorderError::Write(
      "the m4a sample sizes are short".into(),
    ));
  }
  let body = &payload[4..];
  let uniform = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
  let count = u32::from_be_bytes(body[4..8].try_into().unwrap()) as usize;
  if uniform > 0 {
    return Ok(vec![uniform; count]);
  }
  if body.len() < 8 + count * 4 {
    return Err(RecorderError::Write(
      "the m4a sample sizes are short".into(),
    ));
  }
  let mut sizes = Vec::with_capacity(count);
  for index in 0..count {
    let start = 8 + index * 4;
    sizes.push(u32::from_be_bytes(body[start..start + 4].try_into().unwrap()) as usize);
  }
  Ok(sizes)
}

fn box_of(kind: [u8; 4], payload: &[u8]) -> Vec<u8> {
  let mut out = Vec::with_capacity(8 + payload.len());
  push_u32(&mut out, (8 + payload.len()) as u32);
  out.extend_from_slice(&kind);
  out.extend_from_slice(payload);
  out
}

fn full_box(kind: [u8; 4], flags: u32, payload: &[u8]) -> Vec<u8> {
  let mut body = Vec::with_capacity(4 + payload.len());
  push_u32(&mut body, flags & 0x00ff_ffff);
  body.extend_from_slice(payload);
  box_of(kind, &body)
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
  out.extend_from_slice(&value.to_be_bytes());
}

fn push_i32(out: &mut Vec<u8>, value: i32) {
  out.extend_from_slice(&value.to_be_bytes());
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
  out.extend_from_slice(&value.to_be_bytes());
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sine(hz: f32, frames: usize, amplitude: f32) -> Vec<i16> {
    let step = std::f32::consts::TAU * hz / SAMPLE_RATE as f32;
    (0..frames)
      .map(|index| (step * index as f32).sin() * amplitude * i16::MAX as f32)
      .map(|sample| sample as i16)
      .collect()
  }

  #[test]
  fn a_one_second_sine_is_faststart_aac_lc_mono() {
    let pcm = sine(440.0, SAMPLE_RATE as usize, 0.4);
    let bytes = encode_aac_lc(&pcm).unwrap();
    let info = verify_m4a(&bytes, pcm.len() as u64).unwrap();
    assert_eq!(info.major_brand, *b"M4A ");
    assert!(info.faststart);
    assert_eq!(info.channels, 1);
    assert_eq!(info.sample_rate, SAMPLE_RATE);
    assert_eq!(info.audio_object_type, 2);
    assert_eq!(info.avg_bitrate, BITRATE);
    assert!(info.presented_samples.abs_diff(pcm.len() as u64) <= DURATION_TOLERANCE);
    assert!(info.presented_samples > 0);
    let seconds = pcm.len() as f64 / f64::from(SAMPLE_RATE);
    let bitrate = info.payload_bytes as f64 * 8.0 / seconds;
    assert!(
      (48_000.0..144_000.0).contains(&bitrate),
      "payload bitrate {bitrate}"
    );
    let moov = bytes.windows(4).position(|tag| tag == b"moov").unwrap();
    let mdat = bytes.windows(4).position(|tag| tag == b"mdat").unwrap();
    assert!(moov < mdat);
  }

  #[test]
  fn a_short_buffer_keeps_a_non_zero_duration() {
    let pcm = sine(880.0, 9, 0.5);
    let bytes = encode_aac_lc(&pcm).unwrap();
    let info = verify_m4a(&bytes, pcm.len() as u64).unwrap();
    assert!(info.presented_samples > 0);
    assert!(info.presented_samples.abs_diff(9) <= DURATION_TOLERANCE);
  }

  #[test]
  fn empty_pcm_is_rejected() {
    assert!(encode_aac_lc(&[]).is_err());
    let encoded = AacStream::new().unwrap().finish().unwrap();
    assert!(encoded.is_empty());
    assert!(mux_encoded(&encoded).is_err());
  }

  #[test]
  fn streamed_frames_match_a_one_shot_encode() {
    let pcm = sine(440.0, SAMPLE_RATE as usize * 3 + 100, 0.35);
    let once = encode_aac_lc(&pcm).unwrap();
    for chunk in [1usize, 7, 100, 1024, 3000, 8192] {
      let streamed = stream_chunks(&pcm, chunk);
      assert_eq!(
        streamed, once,
        "chunk {chunk} produced a different m4a ({} vs {} bytes)",
        streamed.len(),
        once.len()
      );
    }
    let info = verify_m4a_light(&once, pcm.len() as u64).unwrap();
    assert_eq!(info.major_brand, *b"M4A ");
    assert!(info.faststart);
    assert_eq!(info.audio_object_type, 2);
    assert_eq!(info.channels, 1);
    assert_eq!(info.sample_rate, SAMPLE_RATE);
    assert!(info.presented_samples.abs_diff(pcm.len() as u64) <= DURATION_TOLERANCE);
    let full_before = full_decodes();
    verify_m4a_light(&once, pcm.len() as u64).unwrap();
    assert_eq!(full_decodes(), full_before);
  }

  #[test]
  fn a_pause_does_not_reset_the_stream_encoder() {
    let pcm = sine(523.25, 20_000, 0.3);
    let split = 7_777;
    let mut stream = AacStream::new().unwrap();
    stream.push(&pcm[..split]).unwrap();
    // Nothing is fed across the pause. Resume continues the same encoder.
    stream.push(&pcm[split..]).unwrap();
    let paused = mux_encoded(&stream.finish().unwrap()).unwrap();
    let continuous = encode_aac_lc(&pcm).unwrap();
    assert_eq!(paused, continuous);
    let info = verify_m4a(&paused, pcm.len() as u64).unwrap();
    assert!(info.presented_samples.abs_diff(pcm.len() as u64) <= DURATION_TOLERANCE);
  }

  #[test]
  fn light_verify_rejects_a_duration_that_is_not_the_recording() {
    let pcm = sine(440.0, 8_000, 0.2);
    let bytes = encode_aac_lc(&pcm).unwrap();
    assert!(verify_m4a_light(&bytes, pcm.len() as u64 + DURATION_TOLERANCE + 1).is_err());
  }

  fn stream_chunks(pcm: &[i16], chunk: usize) -> Vec<u8> {
    let mut stream = AacStream::new().unwrap();
    for piece in pcm.chunks(chunk.max(1)) {
      stream.push(piece).unwrap();
    }
    mux_encoded(&stream.finish().unwrap()).unwrap()
  }
}
