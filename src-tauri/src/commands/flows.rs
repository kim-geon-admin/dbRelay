use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    application::flow_service::FlowService,
    domain::{
        validate_source_statement, validate_target_statement, DbKind, Flow, QueryStep,
        TransactionPolicy,
    },
};

use super::{ApplicationContainer, CommandErrorDto};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStepRequest {
    pub id: String,
    pub select_sql: String,
    pub upsert_sql: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowRequest {
    pub id: String,
    pub name: String,
    pub source_connection_id: String,
    pub target_connection_id: String,
    pub query_steps: Vec<QueryStepRequest>,
    pub transaction_policy: TransactionPolicy,
    pub version: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFlowRequest {
    pub flow_id: String,
    pub duplicate_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStepResponse {
    pub id: String,
    pub select_sql: String,
    pub upsert_sql: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowResponse {
    pub id: String,
    pub name: String,
    pub source_connection_id: String,
    pub target_connection_id: String,
    pub query_steps: Vec<QueryStepResponse>,
    pub transaction_policy: TransactionPolicy,
    pub version: u64,
}

impl From<Flow> for FlowResponse {
    fn from(flow: Flow) -> Self {
        Self {
            id: flow.id,
            name: flow.name,
            source_connection_id: flow.source_connection_id,
            target_connection_id: flow.target_connection_id,
            query_steps: flow
                .query_steps
                .into_iter()
                .map(|step| QueryStepResponse {
                    id: step.id,
                    select_sql: step.select_sql,
                    upsert_sql: step.upsert_sql,
                })
                .collect(),
            transaction_policy: flow.transaction_policy,
            version: flow.version,
        }
    }
}

#[tauri::command]
pub async fn list_flows(
    state: State<'_, ApplicationContainer>,
) -> Result<Vec<FlowResponse>, CommandErrorDto> {
    FlowService::new(state.repository.clone())
        .list_flows()
        .await
        .map(|flows| flows.into_iter().map(FlowResponse::from).collect())
        .map_err(CommandErrorDto::from_port)
}

#[tauri::command]
pub async fn save_flow(
    request: FlowRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<FlowResponse, CommandErrorDto> {
    let flow = request.into_flow()?;
    FlowService::new(state.repository.clone())
        .save_flow(&flow)
        .await
        .map(|()| flow.into())
        .map_err(CommandErrorDto::from_port)
}

#[tauri::command]
pub async fn duplicate_flow(
    request: DuplicateFlowRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<FlowResponse, CommandErrorDto> {
    validate_required(&request.flow_id, "flow ID")?;
    validate_required(&request.duplicate_id, "duplicate flow ID")?;
    FlowService::new(state.repository.clone())
        .duplicate_flow(&request.flow_id, &request.duplicate_id)
        .await
        .map(FlowResponse::from)
        .map_err(CommandErrorDto::from_port)
}

impl FlowRequest {
    pub fn into_flow(self) -> Result<Flow, CommandErrorDto> {
        validate_required(&self.id, "flow ID")?;
        validate_required(&self.name, "flow name")?;
        validate_required(&self.source_connection_id, "source connection ID")?;
        validate_required(&self.target_connection_id, "target connection ID")?;
        if self.query_steps.is_empty() {
            return Err(CommandErrorDto::validation(
                "at least one query step is required",
            ));
        }

        let query_steps = self
            .query_steps
            .into_iter()
            .map(|step| {
                validate_required(&step.id, "query step ID")?;
                validate_required(&step.select_sql, "source SQL")?;
                validate_required(&step.upsert_sql, "target SQL")?;
                validate_source_statement(&step.select_sql)
                    .map_err(|error| CommandErrorDto::validation(error.message()))?;
                validate_target_statement(DbKind::Oracle, &step.upsert_sql)
                    .map_err(|error| CommandErrorDto::validation(error.message()))?;
                Ok(QueryStep {
                    id: step.id,
                    select_sql: step.select_sql,
                    upsert_sql: step.upsert_sql,
                })
            })
            .collect::<Result<Vec<_>, CommandErrorDto>>()?;

        Ok(Flow {
            id: self.id,
            name: self.name,
            source_connection_id: self.source_connection_id,
            target_connection_id: self.target_connection_id,
            query_steps,
            transaction_policy: self.transaction_policy,
            version: self.version,
        })
    }
}

fn validate_required(value: &str, label: &str) -> Result<(), CommandErrorDto> {
    if value.trim().is_empty() {
        return Err(CommandErrorDto::validation(format!("{label} is required")));
    }
    Ok(())
}
