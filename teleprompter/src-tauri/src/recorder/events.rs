//! Payloads the recorder can emit.
//!
//! The writer thread publishes meters and peaks. Start, pause, resume, and
//! stop publish the coarse state. While a take is paused the writer does not
//! publish meters or peaks. A lost microphone publishes [`DeviceLostEvent`]
//! from the writer thread or the device watcher, never from the cpal callback.
//! The callback only raises an atomic.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::device::InputDevice;
use super::RecorderError;

/// Coarse recorder state. `Paused` is a take that is still open and is not
/// writing audio. Segment rotation on a timer is a later phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecorderPhase {
  Idle,
  Recording,
  Paused,
}

/// Status command payload. `session_id` is absent while the recorder is idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
  pub state: RecorderPhase,
  pub duration_ms: u64,
  pub session_id: Option<String>,
}

/// `recorder://state`. Sent when a take starts, pauses, resumes, stops, or is cancelled.
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
/// `end_ms` is the recorded time at the end of this batch. Zero is the first
/// sample the writer kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeaksEvent {
  pub start_index: u64,
  pub end_ms: u64,
  pub values: Vec<f32>,
}

/// `recorder://error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
  pub code: String,
  pub message: String,
}

/// `recorder://device-lost`. The take has been stopped and the WAV finalized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLostEvent {
  pub device_id: String,
}

/// `recorder://devices-changed`. Emitted while idle when the input list or the
/// default device changes. `devices` is the same shape as `recorder_list_devices`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesChangedEvent {
  pub devices: Vec<InputDevice>,
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
  fn device_lost(&self, event: &DeviceLostEvent);
  fn devices_changed(&self, event: &DevicesChangedEvent);
}

/// Emit `recorder://device-lost` once. The writer and the watcher share `notified`.
pub fn notify_device_lost(emit: &dyn RecorderEmit, notified: &AtomicBool, device_id: &str) {
  if notified.swap(true, Ordering::AcqRel) {
    return;
  }
  emit.device_lost(&DeviceLostEvent {
    device_id: device_id.to_string(),
  });
}

#[cfg(test)]
pub struct NopEmit;

#[cfg(test)]
impl RecorderEmit for NopEmit {
  fn meter(&self, _event: &MeterEvent) {}
  fn peaks(&self, _event: &PeaksEvent) {}
  fn state(&self, _event: &StateNotice) {}
  fn error(&self, _event: &ErrorEvent) {}
  fn device_lost(&self, _event: &DeviceLostEvent) {}
  fn devices_changed(&self, _event: &DevicesChangedEvent) {}
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
      end_ms: 100,
      values: vec![0.5, 0.25],
    })
    .unwrap();
    assert_eq!(peaks["startIndex"], 3);
    assert_eq!(peaks["endMs"], 100);
    assert_eq!(peaks["values"][1], 0.25);

    let state = serde_json::to_value(StateNotice {
      state: RecorderPhase::Recording,
      duration_ms: 20,
    })
    .unwrap();
    assert_eq!(state["state"], "recording");
    assert_eq!(state["durationMs"], 20);
    assert!(state.get("sessionId").is_none());

    let paused = serde_json::to_value(StateNotice {
      state: RecorderPhase::Paused,
      duration_ms: 1500,
    })
    .unwrap();
    assert_eq!(paused["state"], "paused");
    assert_eq!(paused["durationMs"], 1500);

    let error = serde_json::to_value(ErrorEvent::capture_fault()).unwrap();
    assert_eq!(error["code"], "capture");
    assert_eq!(error["message"], "the microphone stream failed");

    let lost = serde_json::to_value(DeviceLostEvent {
      device_id: "wasapi:{usb}".into(),
    })
    .unwrap();
    assert_eq!(lost["deviceId"], "wasapi:{usb}");
    assert!(lost.get("device_id").is_none());
  }
}
