//! Payloads the recorder can emit.
//!
//! Phase 1 only describes the recorder state. Peak meters, pause, and segment
//! boundaries belong beside [`StateEvent`] when those phases land, so the
//! capture callback and the writer do not have to grow a second event path.

use serde::{Deserialize, Serialize};

/// Coarse recorder state. Pause and segmented takes extend this later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecorderPhase {
  Idle,
  Recording,
}

/// Placeholder state payload. `session_id` is absent while the recorder is idle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
  pub state: RecorderPhase,
  pub duration_ms: u64,
  pub session_id: Option<String>,
}
