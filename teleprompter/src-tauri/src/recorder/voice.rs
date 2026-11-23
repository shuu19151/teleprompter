//! Voice enhance for the native recorder.
//!
//! The page always runs the microphone through a 90 Hz highpass, a gentle
//! compressor, +2.2 dB of makeup, and a fast limiter, with noise suppression
//! left off. This is that chain on the writer thread, after leading zeros
//! have already been dropped and before the sample is written or metered.
//! Exact zeros stay exact zeros while the filters are at rest, so the
//! leading-silence trim still sees digital silence as silence.

const HIGHPASS_HZ: f32 = 90.0;
const HIGHPASS_Q: f32 = 0.707;
const MAKEUP_DB: f32 = 2.2;

struct Biquad {
  b0: f32,
  b1: f32,
  b2: f32,
  a1: f32,
  a2: f32,
  z1: f32,
  z2: f32,
}

impl Biquad {
  fn highpass(hz: f32, q: f32, rate: f32) -> Self {
    let w0 = std::f32::consts::TAU * hz / rate.max(1.0);
    let cos = w0.cos();
    let alpha = w0.sin() / (2.0 * q.max(0.001));
    let b0 = (1.0 + cos) / 2.0;
    let b1 = -(1.0 + cos);
    let b2 = (1.0 + cos) / 2.0;
    let a0 = 1.0 + alpha;
    Self {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: (-2.0 * cos) / a0,
      a2: (1.0 - alpha) / a0,
      z1: 0.0,
      z2: 0.0,
    }
  }

  fn process(&mut self, sample: f32) -> f32 {
    let output = self.b0 * sample + self.z1;
    self.z1 = self.b1 * sample - self.a1 * output + self.z2;
    self.z2 = self.b2 * sample - self.a2 * output;
    output
  }
}

struct Dynamics {
  threshold_db: f32,
  knee_db: f32,
  ratio: f32,
  attack: f32,
  release: f32,
  envelope: f32,
}

impl Dynamics {
  fn new(
    threshold_db: f32,
    knee_db: f32,
    ratio: f32,
    attack_s: f32,
    release_s: f32,
    rate: f32,
  ) -> Self {
    Self {
      threshold_db,
      knee_db,
      ratio: ratio.max(1.0),
      attack: time_coeff(attack_s, rate),
      release: time_coeff(release_s, rate),
      envelope: 0.0,
    }
  }

  fn process(&mut self, sample: f32) -> f32 {
    let level = sample.abs();
    let coeff = if level > self.envelope {
      self.attack
    } else {
      self.release
    };
    self.envelope = coeff * self.envelope + (1.0 - coeff) * level;
    let gain = db_to_linear(static_gain_db(
      linear_to_db(self.envelope),
      self.threshold_db,
      self.knee_db,
      self.ratio,
    ));
    sample * gain
  }
}

fn time_coeff(seconds: f32, rate: f32) -> f32 {
  if seconds <= 0.0 {
    return 0.0;
  }
  (-1.0 / (seconds * rate.max(1.0))).exp()
}

fn linear_to_db(value: f32) -> f32 {
  if value <= 1.0e-8 {
    -160.0
  } else {
    20.0 * value.log10()
  }
}

fn db_to_linear(db: f32) -> f32 {
  10f32.powf(db / 20.0)
}

/// Static compression curve from the Web Audio DynamicsCompressorNode.
/// The result is the gain to apply, in dB.
fn static_gain_db(input_db: f32, threshold_db: f32, knee_db: f32, ratio: f32) -> f32 {
  let output_db = if knee_db <= 0.0 {
    if input_db < threshold_db {
      input_db
    } else {
      threshold_db + (input_db - threshold_db) / ratio
    }
  } else if input_db < threshold_db - knee_db / 2.0 {
    input_db
  } else if input_db > threshold_db + knee_db / 2.0 {
    threshold_db + (input_db - threshold_db) / ratio
  } else {
    let span = input_db - threshold_db + knee_db / 2.0;
    input_db + (1.0 / ratio - 1.0) * (span * span) / (2.0 * knee_db)
  };
  output_db - input_db
}

pub struct VoiceChain {
  highpass: Biquad,
  compressor: Dynamics,
  makeup: f32,
  limiter: Dynamics,
}

impl VoiceChain {
  pub fn new(sample_rate: u32) -> Self {
    let rate = sample_rate.max(1) as f32;
    Self {
      highpass: Biquad::highpass(HIGHPASS_HZ, HIGHPASS_Q, rate),
      compressor: Dynamics::new(-24.0, 12.0, 3.0, 0.005, 0.2, rate),
      makeup: db_to_linear(MAKEUP_DB),
      limiter: Dynamics::new(-2.0, 0.0, 20.0, 0.001, 0.05, rate),
    }
  }

  pub fn process(&mut self, sample: f32) -> f32 {
    if !sample.is_finite() {
      return 0.0;
    }
    let filtered = self.highpass.process(sample);
    let compressed = self.compressor.process(filtered);
    let gained = compressed * self.makeup;
    let limited = self.limiter.process(gained);
    if !limited.is_finite() {
      return 0.0;
    }
    limited.clamp(-1.0, 1.0)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn silence_stays_digital_zero() {
    let mut chain = VoiceChain::new(48_000);
    for _ in 0..200 {
      assert_eq!(chain.process(0.0), 0.0);
      assert_eq!(chain.process(-0.0), 0.0);
    }
  }

  #[test]
  fn a_low_tone_is_cut_and_a_voice_tone_is_kept() {
    let mut low = VoiceChain::new(48_000);
    let mut voice = VoiceChain::new(48_000);
    let mut low_peak = 0.0f32;
    let mut voice_peak = 0.0f32;
    for index in 0..48_000 {
      let t = index as f32 / 48_000.0;
      low_peak = low_peak.max(
        low
          .process((t * 30.0 * std::f32::consts::TAU).sin() * 0.5)
          .abs(),
      );
      voice_peak = voice_peak.max(
        voice
          .process((t * 1_000.0 * std::f32::consts::TAU).sin() * 0.2)
          .abs(),
      );
    }
    assert!(
      low_peak < voice_peak * 0.5,
      "30 Hz {low_peak} was not below 1 kHz {voice_peak}"
    );
    assert!(voice_peak > 0.05, "1 kHz peak {voice_peak}");
    assert!(voice_peak <= 1.0, "limiter peak {voice_peak}");
  }

  #[test]
  fn a_full_scale_tone_does_not_wrap() {
    let mut chain = VoiceChain::new(48_000);
    let mut peak = 0.0f32;
    let mut settled = 0.0f32;
    for index in 0..24_000 {
      let t = index as f32 / 48_000.0;
      let sample = chain.process((t * 1_000.0 * std::f32::consts::TAU).sin());
      assert!(sample.abs() <= 1.0, "sample wrapped at {sample}");
      peak = peak.max(sample.abs());
      if index > 2_400 {
        settled = settled.max(sample.abs());
      }
    }
    assert!(peak > 0.2, "limiter removed the tone, peak {peak}");
    assert!(settled < 0.95, "limiter settled at {settled}");
  }
}
