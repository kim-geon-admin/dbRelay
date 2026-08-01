use std::{sync::Arc, time::UNIX_EPOCH};

use crate::{
    application::ports::{
        Clock, CredentialStore, DatabaseConnectorFactory, DatabaseSession, FlowRepository,
        HistoryRepository, PortError, ResolvedSecret,
    },
    domain::{
        extract_named_binds, map_row, ConnectionProfile, Flow, RecoveryAction, RunError, RunEvent,
        RunState, RunStatus, StepStatus, TransactionPolicy,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSnapshot {
    pub run_id: String,
    pub status: RunStatus,
    pub steps: Vec<StepStatus>,
}

impl RunSnapshot {
    fn from_state(run_id: String, state: &RunState) -> Self {
        Self {
            run_id,
            status: state.status(),
            steps: state
                .steps()
                .iter()
                .map(|step| step.status.clone())
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartRunError {
    code: String,
    message: String,
}

impl StartRunError {
    fn from_port(error: PortError) -> Self {
        Self {
            code: error.code().into(),
            message: error.message().into(),
        }
    }

    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(&message.into()),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for StartRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for StartRunError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryRequest {
    EditAndRetry {
        step_id: String,
        select_sql: String,
        upsert_sql: String,
    },
    SkipAndContinue {
        step_id: String,
    },
    Stop {
        step_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryError {
    code: String,
    message: String,
}

impl RecoveryError {
    fn from_port(error: PortError) -> Self {
        Self {
            code: error.code().into(),
            message: error.message().into(),
        }
    }

    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(&message.into()),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RecoveryError {}

impl From<StartRunError> for RecoveryError {
    fn from(error: StartRunError) -> Self {
        Self::new(error.code, error.message)
    }
}

pub struct MigrationRunner<
    D: DatabaseConnectorFactory + ?Sized,
    F: FlowRepository + ?Sized,
    H: HistoryRepository + ?Sized,
    C: CredentialStore + ?Sized,
    K: Clock + ?Sized,
> {
    connector: Arc<D>,
    flows: Arc<F>,
    history: Arc<H>,
    credentials: Arc<C>,
    clock: Arc<K>,
}

impl<
        D: DatabaseConnectorFactory + ?Sized,
        F: FlowRepository + ?Sized,
        H: HistoryRepository + ?Sized,
        C: CredentialStore + ?Sized,
        K: Clock + ?Sized,
    > MigrationRunner<D, F, H, C, K>
{
    pub fn new(
        connector: Arc<D>,
        flows: Arc<F>,
        history: Arc<H>,
        credentials: Arc<C>,
        clock: Arc<K>,
    ) -> Self {
        Self {
            connector,
            flows,
            history,
            credentials,
            clock,
        }
    }

    pub async fn start(&self, flow_id: &str) -> Result<RunSnapshot, StartRunError> {
        let flow = self
            .flows
            .load_flow(flow_id)
            .await
            .map_err(StartRunError::from_port)?
            .ok_or_else(|| StartRunError::new("FLOW_NOT_FOUND", "flow not found"))?;
        let run_id = self.run_id(&flow);

        let source_profile = match self
            .flows
            .load_runnable_connection(&flow.source_connection_id)
            .await
        {
            Ok(Some(profile)) => profile,
            Ok(None) => {
                return self
                    .persist_preflight_failure(
                        &flow,
                        &run_id,
                        0,
                        RunError::connector(
                            "CONNECTION_NOT_FOUND",
                            "source connection was not found",
                        ),
                    )
                    .await
            }
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };
        let target_profile = match self
            .flows
            .load_runnable_connection(&flow.target_connection_id)
            .await
        {
            Ok(Some(profile)) => profile,
            Ok(None) => {
                return self
                    .persist_preflight_failure(
                        &flow,
                        &run_id,
                        0,
                        RunError::connector(
                            "CONNECTION_NOT_FOUND",
                            "target connection was not found",
                        ),
                    )
                    .await
            }
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };

        if source_profile.kind != self.connector.kind()
            || target_profile.kind != self.connector.kind()
        {
            return self
                .persist_preflight_failure(
                    &flow,
                    &run_id,
                    0,
                    RunError::connector("CONNECTOR_KIND_MISMATCH", "connector kind does not match"),
                )
                .await;
        }

        let source_secret = match self.resolve_credential(&source_profile).await {
            Ok(secret) => secret,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };
        let target_secret = match self.resolve_credential(&target_profile).await {
            Ok(secret) => secret,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };

        let mut source = match self.connector.open(&source_profile, &source_secret).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };
        let mut target = match self.connector.open(&target_profile, &target_secret).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                    .await
            }
        };

        for (step_index, step) in flow.query_steps.iter().enumerate() {
            let binds = extract_named_binds(&step.upsert_sql).map_err(|_| {
                StartRunError::new(
                    "MAPPING_INVALID",
                    "target bind syntax could not be validated",
                )
            })?;
            let rows = match source.query(&step.select_sql).await {
                Ok(rows) => rows,
                Err(error) => {
                    return self
                        .persist_preflight_failure(&flow, &run_id, step_index, run_error(error))
                        .await
                }
            };
            if rows.rows.iter().any(|row| map_row(row, &binds).is_err()) {
                return self
                    .persist_preflight_failure(
                        &flow,
                        &run_id,
                        step_index,
                        RunError::connector(
                            "MAPPING_INVALID",
                            "source columns do not satisfy target bind parameters",
                        ),
                    )
                    .await;
            }
        }

        if flow.transaction_policy == TransactionPolicy::CommitSuccesses {
            let state = RunState::running(flow.transaction_policy, flow.query_steps.len());
            return self
                .execute_committed_steps(&run_id, &flow, state, &mut source, &mut target)
                .await;
        }

        if let Err(error) = target.begin().await {
            return self
                .persist_preflight_failure(&flow, &run_id, 0, run_error(error))
                .await;
        }

        let mut state = RunState::running(flow.transaction_policy, flow.query_steps.len());
        for (step_index, step) in flow.query_steps.iter().enumerate() {
            let failure = match source.query(&step.select_sql).await {
                Ok(rows) => {
                    let binds = match extract_named_binds(&step.upsert_sql) {
                        Ok(binds) => binds,
                        Err(_) => {
                            return self
                                .rollback_after_failure(
                                    &run_id,
                                    &mut target,
                                    state,
                                    step_index,
                                    RunError::connector(
                                        "MAPPING_INVALID",
                                        "target bind syntax could not be validated",
                                    ),
                                )
                                .await
                        }
                    };
                    match rows
                        .rows
                        .iter()
                        .map(|row| map_row(row, &binds))
                        .collect::<Result<Vec<_>, _>>()
                    {
                        Ok(batch) => match target.execute_named(&step.upsert_sql, &batch).await {
                            Ok(affected_rows) => {
                                state
                                    .record_step_success(step_index, affected_rows)
                                    .map_err(|_| {
                                        StartRunError::new(
                                            "RUN_STATE_INVALID",
                                            "run state could not record a successful step",
                                        )
                                    })?;
                                None
                            }
                            Err(error) => Some(run_error(error)),
                        },
                        Err(_) => Some(RunError::connector(
                            "MAPPING_INVALID",
                            "source columns do not satisfy target bind parameters",
                        )),
                    }
                }
                Err(error) => Some(run_error(error)),
            };

            if let Some(error) = failure {
                return self
                    .rollback_after_failure(&run_id, &mut target, state, step_index, error)
                    .await;
            }
        }

        if let Err(error) = target.commit().await {
            let _ = target.rollback().await;
            let mut events = state.events().to_vec();
            events.push(RunEvent::TransactionFailed {
                error: run_error(error),
            });
            let rolled_back = RunState::from_history(
                flow.transaction_policy,
                RunStatus::RolledBack,
                state
                    .steps()
                    .iter()
                    .map(|step| step.status.clone())
                    .collect(),
                events,
            );
            return self.persist(&run_id, &rolled_back).await;
        }

        self.persist(&run_id, &state).await
    }

    pub async fn recover(
        &self,
        run_id: &str,
        request: RecoveryRequest,
    ) -> Result<RunSnapshot, RecoveryError> {
        let mut state = self
            .history
            .load_run(run_id)
            .await
            .map_err(RecoveryError::from_port)?
            .ok_or_else(|| RecoveryError::new("RUN_NOT_FOUND", "run was not found"))?;
        let failed_step = match state.status() {
            RunStatus::AwaitingRecovery { failed_step } => failed_step,
            _ => {
                return Err(RecoveryError::new(
                    "RECOVERY_NOT_AVAILABLE",
                    "run is not awaiting recovery",
                ))
            }
        };
        let flow_id = run_id
            .rsplit_once('-')
            .map(|(flow_id, _)| flow_id)
            .filter(|flow_id| !flow_id.is_empty())
            .ok_or_else(|| RecoveryError::new("RUN_ID_INVALID", "run ID is invalid"))?;
        let mut flow = self
            .flows
            .load_flow(flow_id)
            .await
            .map_err(RecoveryError::from_port)?
            .ok_or_else(|| RecoveryError::new("FLOW_NOT_FOUND", "flow was not found"))?;
        let requested_step_id = match &request {
            RecoveryRequest::EditAndRetry { step_id, .. }
            | RecoveryRequest::SkipAndContinue { step_id }
            | RecoveryRequest::Stop { step_id } => step_id,
        };
        if flow.query_steps.get(failed_step).map(|step| &step.id) != Some(requested_step_id) {
            return Err(RecoveryError::new(
                "RECOVERY_STEP_MISMATCH",
                "recovery request does not target the failed step",
            ));
        }

        match request {
            RecoveryRequest::Stop { .. } => {
                state
                    .apply_recovery(RecoveryAction::Stop)
                    .map_err(recovery_state_error)?;
                self.persist_recovery(run_id, &state).await
            }
            RecoveryRequest::SkipAndContinue { .. } => {
                state
                    .apply_recovery(RecoveryAction::SkipAndContinue)
                    .map_err(recovery_state_error)?;
                self.persist_recovery(run_id, &state).await?;
                if matches!(state.status(), RunStatus::Completed) {
                    return Ok(RunSnapshot::from_state(run_id.into(), &state));
                }
                let next_step = match state.status() {
                    RunStatus::Running { step } => step,
                    _ => {
                        return Err(RecoveryError::new(
                            "RUN_STATE_INVALID",
                            "recovery could not resume the run",
                        ))
                    }
                };
                let (mut source, mut target) = match self.open_sessions(&flow).await {
                    Ok(sessions) => sessions,
                    Err(error) => {
                        return self
                            .persist_recovery_failure(run_id, state, next_step, error)
                            .await
                    }
                };
                self.execute_committed_steps(run_id, &flow, state, &mut source, &mut target)
                    .await
                    .map_err(RecoveryError::from)
            }
            RecoveryRequest::EditAndRetry {
                select_sql,
                upsert_sql,
                ..
            } => {
                let step = flow.query_steps.get_mut(failed_step).ok_or_else(|| {
                    RecoveryError::new("RECOVERY_STEP_MISMATCH", "failed step was not found")
                })?;
                step.select_sql = select_sql;
                step.upsert_sql = upsert_sql;
                flow.version = flow.version.saturating_add(1);
                self.flows
                    .save_flow(&flow)
                    .await
                    .map_err(RecoveryError::from_port)?;
                state
                    .apply_recovery(RecoveryAction::EditAndRetry)
                    .map_err(recovery_state_error)?;
                self.persist_recovery(run_id, &state).await?;
                let (mut source, mut target) = match self.open_sessions(&flow).await {
                    Ok(sessions) => sessions,
                    Err(error) => {
                        return self
                            .persist_recovery_failure(run_id, state, failed_step, error)
                            .await
                    }
                };
                if let Err(error) = self
                    .preflight_step(&mut source, &flow.query_steps[failed_step])
                    .await
                {
                    return self
                        .persist_recovery_failure(run_id, state, failed_step, error)
                        .await;
                }
                self.execute_committed_steps(run_id, &flow, state, &mut source, &mut target)
                    .await
                    .map_err(RecoveryError::from)
            }
        }
    }

    async fn execute_committed_steps(
        &self,
        run_id: &str,
        flow: &Flow,
        mut state: RunState,
        source: &mut Box<dyn DatabaseSession>,
        target: &mut Box<dyn DatabaseSession>,
    ) -> Result<RunSnapshot, StartRunError> {
        let start_step = match state.status() {
            RunStatus::Running { step } => step,
            RunStatus::Completed => return self.persist(run_id, &state).await,
            _ => {
                return Err(StartRunError::new(
                    "RUN_STATE_INVALID",
                    "committed-step execution requires a running state",
                ))
            }
        };

        for step_index in start_step..flow.query_steps.len() {
            if let Err(error) = target.begin().await {
                return self
                    .rollback_committed_failure(run_id, target, state, step_index, run_error(error))
                    .await;
            }
            let affected_rows = match self
                .execute_step(source, target, &flow.query_steps[step_index])
                .await
            {
                Ok(affected_rows) => affected_rows,
                Err(error) => {
                    return self
                        .rollback_committed_failure(run_id, target, state, step_index, error)
                        .await
                }
            };
            if let Err(error) = target.commit().await {
                return self
                    .rollback_committed_failure(run_id, target, state, step_index, run_error(error))
                    .await;
            }
            state
                .record_step_success(step_index, affected_rows)
                .map_err(|_| {
                    StartRunError::new(
                        "RUN_STATE_INVALID",
                        "run state could not record a successful step",
                    )
                })?;
            self.persist(run_id, &state).await?;
        }
        Ok(RunSnapshot::from_state(run_id.into(), &state))
    }

    async fn rollback_committed_failure(
        &self,
        run_id: &str,
        target: &mut Box<dyn DatabaseSession>,
        mut state: RunState,
        step_index: usize,
        error: RunError,
    ) -> Result<RunSnapshot, StartRunError> {
        state.record_step_failure(step_index, error).map_err(|_| {
            StartRunError::new(
                "RUN_STATE_INVALID",
                "run state could not record a failed step",
            )
        })?;
        let _ = target.rollback().await;
        self.persist(run_id, &state).await
    }

    async fn execute_step(
        &self,
        source: &mut Box<dyn DatabaseSession>,
        target: &mut Box<dyn DatabaseSession>,
        step: &crate::domain::QueryStep,
    ) -> Result<u64, RunError> {
        let rows = source.query(&step.select_sql).await.map_err(run_error)?;
        let binds = extract_named_binds(&step.upsert_sql).map_err(|_| {
            RunError::connector(
                "MAPPING_INVALID",
                "target bind syntax could not be validated",
            )
        })?;
        let batch = rows
            .rows
            .iter()
            .map(|row| map_row(row, &binds))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                RunError::connector(
                    "MAPPING_INVALID",
                    "source columns do not satisfy target bind parameters",
                )
            })?;
        target
            .execute_named(&step.upsert_sql, &batch)
            .await
            .map_err(run_error)
    }

    async fn preflight_step(
        &self,
        source: &mut Box<dyn DatabaseSession>,
        step: &crate::domain::QueryStep,
    ) -> Result<(), RunError> {
        let binds = extract_named_binds(&step.upsert_sql).map_err(|_| {
            RunError::connector(
                "MAPPING_INVALID",
                "target bind syntax could not be validated",
            )
        })?;
        let rows = source.query(&step.select_sql).await.map_err(run_error)?;
        if rows.rows.iter().any(|row| map_row(row, &binds).is_err()) {
            return Err(RunError::connector(
                "MAPPING_INVALID",
                "source columns do not satisfy target bind parameters",
            ));
        }
        Ok(())
    }

    async fn open_sessions(
        &self,
        flow: &Flow,
    ) -> Result<(Box<dyn DatabaseSession>, Box<dyn DatabaseSession>), RunError> {
        let source_profile = self
            .flows
            .load_runnable_connection(&flow.source_connection_id)
            .await
            .map_err(run_error)?
            .ok_or_else(|| {
                RunError::connector("CONNECTION_NOT_FOUND", "source connection was not found")
            })?;
        let target_profile = self
            .flows
            .load_runnable_connection(&flow.target_connection_id)
            .await
            .map_err(run_error)?
            .ok_or_else(|| {
                RunError::connector("CONNECTION_NOT_FOUND", "target connection was not found")
            })?;
        if source_profile.kind != self.connector.kind()
            || target_profile.kind != self.connector.kind()
        {
            return Err(RunError::connector(
                "CONNECTOR_KIND_MISMATCH",
                "connector kind does not match",
            ));
        }
        let source_secret = self
            .resolve_credential(&source_profile)
            .await
            .map_err(run_error)?;
        let target_secret = self
            .resolve_credential(&target_profile)
            .await
            .map_err(run_error)?;
        let source = self
            .connector
            .open(&source_profile, &source_secret)
            .await
            .map_err(run_error)?;
        let target = self
            .connector
            .open(&target_profile, &target_secret)
            .await
            .map_err(run_error)?;
        Ok((source, target))
    }

    async fn persist_recovery(
        &self,
        run_id: &str,
        state: &RunState,
    ) -> Result<RunSnapshot, RecoveryError> {
        self.history
            .append_run(run_id, state)
            .await
            .map_err(RecoveryError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn persist_recovery_failure(
        &self,
        run_id: &str,
        mut state: RunState,
        failed_step: usize,
        error: RunError,
    ) -> Result<RunSnapshot, RecoveryError> {
        state
            .record_step_failure(failed_step, error)
            .map_err(recovery_state_error)?;
        self.persist_recovery(run_id, &state).await
    }

    async fn rollback_after_failure(
        &self,
        run_id: &str,
        target: &mut Box<dyn DatabaseSession>,
        mut state: RunState,
        step_index: usize,
        error: RunError,
    ) -> Result<RunSnapshot, StartRunError> {
        state.record_step_failure(step_index, error).map_err(|_| {
            StartRunError::new(
                "RUN_STATE_INVALID",
                "run state could not record a failed step",
            )
        })?;
        let _ = target.rollback().await;
        self.persist(run_id, &state).await
    }

    async fn persist_preflight_failure(
        &self,
        flow: &Flow,
        run_id: &str,
        step_index: usize,
        error: RunError,
    ) -> Result<RunSnapshot, StartRunError> {
        let mut steps = vec![StepStatus::NotRun; flow.query_steps.len()];
        let events = if let Some(step) = steps.get_mut(step_index) {
            *step = StepStatus::Failed;
            vec![RunEvent::StepFailed {
                step: step_index,
                error,
            }]
        } else {
            Vec::new()
        };
        let state =
            RunState::from_history(flow.transaction_policy, RunStatus::Failed, steps, events);
        self.persist(run_id, &state).await
    }

    async fn persist(&self, run_id: &str, state: &RunState) -> Result<RunSnapshot, StartRunError> {
        self.history
            .append_run(run_id, state)
            .await
            .map_err(StartRunError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn resolve_credential(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ResolvedSecret, PortError> {
        match self.credentials.resolve(&profile.id).await {
            Ok(secret) => Ok(secret),
            Err(error)
                if error.code() == "CREDENTIAL_NOT_FOUND"
                    && profile.credential_ref != profile.id =>
            {
                let secret = self.credentials.resolve(&profile.credential_ref).await?;
                self.credentials.store(&profile.id, secret.clone()).await?;
                Ok(secret)
            }
            Err(error) => Err(error),
        }
    }

    fn run_id(&self, flow: &Flow) -> String {
        let timestamp = self
            .clock
            .now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        format!("{}-{timestamp}", flow.id)
    }
}

fn run_error(error: PortError) -> RunError {
    RunError::connector(error.code(), error.message())
}

fn recovery_state_error(error: RunError) -> RecoveryError {
    RecoveryError::new(
        error.history_code(),
        "recovery request is not valid for this run",
    )
}
