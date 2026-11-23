//! Payloads the recorder can emit.
//!
//! The writer thread publishes meters and peaks. Start and stop publish the
//! coarse state. The capture callback does not emit; it only raises an atomic
//! the writer turns into [`ErrorEvent`].

use serde::{Deserialize, Serialize};

use super::RecorderError;

/// Coarse recorder state. Pause and segmented takes extend this later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecorderPhase {
  Idle,
  Recording,
}

/// Status command payload. `session_id` is absent while the recorder is idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
  pub state: RecorderPhase,
  pub duration_ms: u64,
  pub session_id: Option<String>,
}

/// `recorder://state`. Sent when a take starts, stops, or is cancelled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateNotice {
  pub state: RecorderPhase,
  pub duration_ms: u64,
}

/// `recorder://meter`, about every 50 ms of audio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterEvent {
  pub rms: f32,
  pub peak: f32,
  pub clipped: bool,
}

/// `recorder://peaks`. `values` holds one bar per 20 ms, starting at `start_index`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeaksEvent {
  pub start_index: u64,
  pub values: Vec<f32>,
}

/// `recorder://error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
  pub code: String,
  pub message: String,
}

impl ErrorEvent {
  pub fn from_recorder(error: &RecorderError) -> Self {
    Self {
      code: error.code().to_string(),
      message: error.to_string(),
    }
  }

  pub fn capture_fault() -> Self {
    Self {
      code: "capture".to_string(),
      message: "the microphone stream failed".to_string(),
    }
  }
}

/// Sink used by the writer thread and by start/stop. Implementations must be
/// safe to call off the UI thread. The cpal callback must not call it.
pub trait RecorderEmit: Send + Sync {
  fn meter(&self, event: &MeterEvent);
  fn peaks(&self, event: &PeaksEvent);
  fn state(&self, event: &StateNotice);
  fn error(&self, event: &ErrorEvent);
}

#[cfg(test)]
pub struct NopEmit;

#[cfg(test)]
impl RecorderEmit for NopEmit {
  fn meter(&self, _event: &MeterEvent) {}
  fn peaks(&self, _event: &PeaksEvent) {}
  fn state(&self, _event: &StateNotice) {}
  fn error(&self, _event: &ErrorEvent) {}
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn meter_peak_and_state_payloads_use_the_event_names() {
    let meter = serde_json::to_value(MeterEvent {
      rms: 0.25,
      peak: 0.5,
      clipped: false,
    })
    .unwrap();
    assert_eq!(meter["rms"], 0.25);
    assert_eq!(meter["peak"], 0.5);
    assert_eq!(meter["clipped"], false);

    let peaks = serde_json::to_value(PeaksEvent {
      start_index: 3,
      values: vec![0.5, 0.25],
    })
    .unwrap();
    assert_eq!(peaks["startIndex"], 3);
    assert_eq!(peaks["values"][1], 0.25);

    let state = serde_json::to_value(StateNotice {
      state: RecorderPhase::Recording,
      duration_ms: 20,
    })
    .unwrap();
    assert_eq!(state["state"], "recording");
    assert_eq!(state["durationMs"], 20);
    assert!(state.get("sessionId").is_none());

    let error = serde_json::to_value(ErrorEvent::capture_fault()).unwrap();
    assert_eq!(error["code"], "capture");
    assert_eq!(error["message"], "the microphone stream failed");
  }
}
