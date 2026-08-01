use serde::Serialize;
use tauri::State;

use crate::domain::{RunEvent, RunStatus, StepStatus, TransactionPolicy};

use super::{ApplicationContainer, CommandErrorDto};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryResponse {
    pub run_id: String,
    pub flow_id: String,
    pub flow_version: u64,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub policy: TransactionPolicy,
    pub status: RunStatus,
    pub steps: Vec<StepStatus>,
    pub events: Vec<RunEvent>,
}

#[tauri::command]
pub async fn list_run_history(
    state: State<'_, ApplicationContainer>,
) -> Result<Vec<RunHistoryResponse>, CommandErrorDto> {
    state
        .history
        .list_runs()
        .await
        .map(|runs| {
            runs.into_iter()
                .map(|run| RunHistoryResponse {
                    run_id: run.run_id,
                    flow_id: run.flow_id.unwrap_or_default(),
                    flow_version: run.flow_version.unwrap_or_default(),
                    started_at: run.started_at_ms,
                    ended_at: run.ended_at_ms,
                    policy: run.state.policy(),
                    status: run.state.status(),
                    steps: run
                        .state
                        .steps()
                        .iter()
                        .map(|step| step.status.clone())
                        .collect(),
                    events: run.state.events().to_vec(),
                })
                .collect()
        })
        .map_err(CommandErrorDto::from_port)
}
