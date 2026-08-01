use std::sync::Arc;

use uuid::Uuid;

use crate::{
    application::ports::{
        BoundRecoveryApply, Clock, CredentialStore, DatabaseConnectorFactory, DatabaseSession,
        FlowRepository, HistoryRepository, PortError, ResolvedSecret, RunBinding,
    },
    domain::{
        extract_named_binds, map_row, validate_row_set_columns, validate_source_statement,
        validate_target_statement, ConnectionProfile, DbKind, Flow, RecoveryAction, RunError,
        RunEvent, RunState, RunStatus, StepStatus, TransactionPolicy,
    },
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSnapshot {
    pub run_id: String,
    pub policy: TransactionPolicy,
    pub status: RunStatus,
    pub steps: Vec<StepStatus>,
    pub events: Vec<RunEvent>,
}

impl RunSnapshot {
    fn from_state(run_id: String, state: &RunState) -> Self {
        Self {
            run_id,
            policy: state.policy(),
            status: state.status(),
            steps: state
                .steps()
                .iter()
                .map(|step| step.status.clone())
                .collect(),
            events: state.events().to_vec(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartRunError {
    code: String,
    message: String,
    retryable: bool,
}

impl StartRunError {
    fn from_port(error: PortError) -> Self {
        Self {
            code: error.code().into(),
            message: error.message().into(),
            retryable: error.retryable(),
        }
    }

    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(&message.into()),
            retryable: false,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retryable(&self) -> bool {
        self.retryable
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
    retryable: bool,
}

impl RecoveryError {
    fn from_port(error: PortError) -> Self {
        Self {
            code: error.code().into(),
            message: error.message().into(),
            retryable: error.retryable(),
        }
    }

    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: crate::domain::mask_sensitive_text(&message.into()),
            retryable: false,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retryable(&self) -> bool {
        self.retryable
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
        Self {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        }
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
    _clock: Arc<K>,
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
            _clock: clock,
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

        for (step_index, step) in flow.query_steps.iter().enumerate() {
            if let Err(error) = validate_step_policy(target_profile.kind, step) {
                return self
                    .persist_preflight_failure(&flow, &run_id, step_index, error)
                    .await;
            }
        }

        let binding = RunBinding {
            flow: flow.clone(),
            source_profile: source_profile.clone(),
            target_profile: target_profile.clone(),
        };

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

        let initial_state = RunState::running(flow.transaction_policy, flow.query_steps.len());
        self.create_bound(&run_id, &initial_state, &binding).await?;

        let mut source = match self.connector.open(&source_profile, &source_secret).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .persist_existing_preflight_failure(&run_id, initial_state, 0, run_error(error))
                    .await
            }
        };
        let mut target = match self.connector.open(&target_profile, &target_secret).await {
            Ok(session) => session,
            Err(error) => {
                return self
                    .persist_existing_preflight_failure(&run_id, initial_state, 0, run_error(error))
                    .await
            }
        };

        let mut prepared_batches = Vec::with_capacity(flow.query_steps.len());
        for (step_index, step) in flow.query_steps.iter().enumerate() {
            match self
                .preflight_step(&mut source, target_profile.kind, step)
                .await
            {
                Ok(batch) => prepared_batches.push(batch),
                Err(error) => {
                    return self
                        .persist_existing_preflight_failure(
                            &run_id,
                            initial_state,
                            step_index,
                            error,
                        )
                        .await
                }
            }
        }

        if flow.transaction_policy == TransactionPolicy::CommitSuccesses {
            return self
                .execute_committed_steps(
                    &run_id,
                    &flow,
                    &binding,
                    initial_state,
                    &mut source,
                    &mut target,
                    Some(&prepared_batches),
                )
                .await;
        }

        if let Err(error) = target.begin().await {
            return self
                .persist_existing_preflight_failure(&run_id, initial_state, 0, run_error(error))
                .await;
        }

        let mut state = initial_state;
        for (step_index, (step, batch)) in flow
            .query_steps
            .iter()
            .zip(prepared_batches.iter())
            .enumerate()
        {
            let failure = match target.execute_named(&step.upsert_sql, batch).await {
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
            };

            if let Some(error) = failure {
                return self
                    .rollback_after_failure(&run_id, &mut target, state, step_index, error)
                    .await;
            }
        }

        if let Some(last_step) = flow.query_steps.len().checked_sub(1) {
            state.mark_commit_pending(last_step).map_err(|_| {
                StartRunError::new(
                    "RUN_STATE_INVALID",
                    "run state could not record a commit checkpoint",
                )
            })?;
            self.persist(&run_id, &state).await?;
        }

        if let Err(error) = target.commit().await {
            let step = flow.query_steps.len().saturating_sub(1);
            state.mark_in_doubt(step, run_error(error)).map_err(|_| {
                StartRunError::new(
                    "RUN_STATE_INVALID",
                    "run state could not record an indeterminate transaction",
                )
            })?;
            if let Err(rollback_error) = target.rollback().await {
                state
                    .mark_in_doubt(step, run_error(rollback_error))
                    .map_err(|_| {
                        StartRunError::new(
                            "RUN_STATE_INVALID",
                            "run state could not record an indeterminate transaction",
                        )
                    })?;
            }
            return self.persist(&run_id, &state).await;
        }

        if !flow.query_steps.is_empty() {
            state.confirm_pending_commit().map_err(|_| {
                StartRunError::new(
                    "RUN_STATE_INVALID",
                    "run state could not confirm the commit",
                )
            })?;
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
        let binding = self
            .history
            .load_run_binding(run_id)
            .await
            .map_err(RecoveryError::from_port)?
            .ok_or_else(|| {
                RecoveryError::new(
                    "RECOVERY_CONFIG_MISMATCH",
                    "run configuration is unavailable for recovery",
                )
            })?;
        self.ensure_recovery_binding(&binding).await?;
        let paused_state = state.clone();
        let paused_binding = binding.clone();
        let requested_step_id = match &request {
            RecoveryRequest::EditAndRetry { step_id, .. }
            | RecoveryRequest::SkipAndContinue { step_id }
            | RecoveryRequest::Stop { step_id } => step_id,
        };
        if binding
            .flow
            .query_steps
            .get(failed_step)
            .map(|step| &step.id)
            != Some(requested_step_id)
        {
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
                self.apply_bound_recovery(run_id, &state, &paused_state, &binding, &binding, None)
                    .await?;
                Ok(RunSnapshot::from_state(run_id.into(), &state))
            }
            RecoveryRequest::SkipAndContinue { .. } => {
                state
                    .reserve_recovery(RecoveryAction::SkipAndContinue)
                    .map_err(recovery_state_error)?;
                self.apply_bound_recovery(run_id, &state, &paused_state, &binding, &binding, None)
                    .await?;
                let reserved_state = state.clone();
                state
                    .apply_reserved_recovery()
                    .map_err(recovery_state_error)?;
                match state.status() {
                    RunStatus::Completed => {
                        self.apply_bound_recovery(
                            run_id,
                            &state,
                            &reserved_state,
                            &binding,
                            &binding,
                            None,
                        )
                        .await?;
                        return Ok(RunSnapshot::from_state(run_id.into(), &state));
                    }
                    RunStatus::Running { .. } => {}
                    _ => {
                        return Err(RecoveryError::new(
                            "RUN_STATE_INVALID",
                            "recovery could not resume the run",
                        ))
                    }
                };
                let (mut source, mut target) = match self.open_bound_sessions(&binding).await {
                    Ok(sessions) => sessions,
                    Err(_) => {
                        return self
                            .return_reserved_recovery(run_id, &reserved_state, &binding)
                            .await
                    }
                };
                self.execute_committed_steps(
                    run_id,
                    &binding.flow,
                    &binding,
                    state,
                    &mut source,
                    &mut target,
                    None,
                )
                .await
                .map_err(RecoveryError::from)
            }
            RecoveryRequest::EditAndRetry {
                select_sql,
                upsert_sql,
                ..
            } => {
                let mut flow = binding.flow.clone();
                let step = flow.query_steps.get_mut(failed_step).ok_or_else(|| {
                    RecoveryError::new("RECOVERY_STEP_MISMATCH", "failed step was not found")
                })?;
                step.select_sql = select_sql;
                step.upsert_sql = upsert_sql;
                flow.version = binding.flow.version.checked_add(1).ok_or_else(|| {
                    RecoveryError::new("FLOW_VERSION_INVALID", "flow version cannot be advanced")
                })?;
                state
                    .reserve_recovery(RecoveryAction::EditAndRetry)
                    .map_err(recovery_state_error)?;
                self.apply_bound_recovery(
                    run_id,
                    &state,
                    &paused_state,
                    &paused_binding,
                    &paused_binding,
                    None,
                )
                .await?;
                let reserved_state = state.clone();
                let mut candidate_binding = binding.clone();
                candidate_binding.flow = flow;
                let (mut source, mut target) =
                    match self.open_bound_sessions(&candidate_binding).await {
                        Ok(sessions) => sessions,
                        Err(_) => {
                            return self
                                .return_reserved_recovery(run_id, &reserved_state, &paused_binding)
                                .await
                        }
                    };
                if self
                    .preflight_step(
                        &mut source,
                        candidate_binding.target_profile.kind,
                        &candidate_binding.flow.query_steps[failed_step],
                    )
                    .await
                    .is_err()
                {
                    return self
                        .return_reserved_recovery(run_id, &reserved_state, &paused_binding)
                        .await;
                }
                self.apply_bound_recovery(
                    run_id,
                    &state,
                    &reserved_state,
                    &paused_binding,
                    &candidate_binding,
                    Some(&candidate_binding.flow),
                )
                .await?;
                state
                    .apply_reserved_recovery()
                    .map_err(recovery_state_error)?;
                self.execute_committed_steps(
                    run_id,
                    &candidate_binding.flow,
                    &candidate_binding,
                    state,
                    &mut source,
                    &mut target,
                    None,
                )
                .await
                .map_err(RecoveryError::from)
            }
        }
    }

    #[allow(clippy::too_many_arguments)] // Runtime sessions and optional preflight batches stay explicit at this safety boundary.
    async fn execute_committed_steps(
        &self,
        run_id: &str,
        flow: &Flow,
        binding: &RunBinding,
        mut state: RunState,
        source: &mut Box<dyn DatabaseSession>,
        target: &mut Box<dyn DatabaseSession>,
        prepared_batches: Option<&[Vec<crate::domain::NamedRow>]>,
    ) -> Result<RunSnapshot, StartRunError> {
        let start_step = match state.status() {
            RunStatus::Running { step } => step,
            RunStatus::Completed => return self.persist_bound(run_id, &state, binding).await,
            _ => {
                return Err(StartRunError::new(
                    "RUN_STATE_INVALID",
                    "committed-step execution requires a running state",
                ))
            }
        };

        for step_index in start_step..flow.query_steps.len() {
            let step = &flow.query_steps[step_index];
            if let Err(error) = validate_step_policy(binding.target_profile.kind, step) {
                state.record_step_failure(step_index, error).map_err(|_| {
                    StartRunError::new(
                        "RUN_STATE_INVALID",
                        "run state could not record a failed step",
                    )
                })?;
                return self.persist_bound(run_id, &state, binding).await;
            }
            let batch = match if let Some(batch) =
                prepared_batches.and_then(|batches| batches.get(step_index).cloned())
            {
                Ok(batch)
            } else {
                self.prepare_step_batch(source, step).await
            } {
                Ok(batch) => batch,
                Err(error) => {
                    state.record_step_failure(step_index, error).map_err(|_| {
                        StartRunError::new(
                            "RUN_STATE_INVALID",
                            "run state could not record a failed step",
                        )
                    })?;
                    return self.persist_bound(run_id, &state, binding).await;
                }
            };
            if let Err(error) =
                validate_target_batch_capabilities(binding.target_profile.kind, &batch)
            {
                state.record_step_failure(step_index, error).map_err(|_| {
                    StartRunError::new(
                        "RUN_STATE_INVALID",
                        "run state could not record a failed step",
                    )
                })?;
                return self.persist_bound(run_id, &state, binding).await;
            }
            if let Err(error) = target.begin().await {
                return self
                    .rollback_committed_failure(
                        run_id,
                        target,
                        state,
                        step_index,
                        run_error(error),
                        binding,
                    )
                    .await;
            }
            let affected_rows = match self.execute_step(target, step, &batch).await {
                Ok(affected_rows) => affected_rows,
                Err(error) => {
                    return self
                        .rollback_committed_failure(
                            run_id, target, state, step_index, error, binding,
                        )
                        .await
                }
            };
            state.mark_commit_pending(step_index).map_err(|_| {
                StartRunError::new(
                    "RUN_STATE_INVALID",
                    "run state could not record a commit checkpoint",
                )
            })?;
            self.persist_bound(run_id, &state, binding).await?;
            if let Err(error) = target.commit().await {
                return self
                    .rollback_committed_failure(
                        run_id,
                        target,
                        state,
                        step_index,
                        run_error(error),
                        binding,
                    )
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
            self.persist_bound(run_id, &state, binding).await?;
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
        binding: &RunBinding,
    ) -> Result<RunSnapshot, StartRunError> {
        if matches!(state.status(), RunStatus::CommitPending { .. }) {
            state.mark_in_doubt(step_index, error).map_err(|_| {
                StartRunError::new(
                    "RUN_STATE_INVALID",
                    "run state could not record an indeterminate transaction",
                )
            })?;
        } else {
            state.record_step_failure(step_index, error).map_err(|_| {
                StartRunError::new(
                    "RUN_STATE_INVALID",
                    "run state could not record a failed step",
                )
            })?;
        }
        if let Err(rollback_error) = target.rollback().await {
            state
                .mark_in_doubt(step_index, run_error(rollback_error))
                .map_err(|_| {
                    StartRunError::new(
                        "RUN_STATE_INVALID",
                        "run state could not record an indeterminate transaction",
                    )
                })?;
        }
        self.persist_bound(run_id, &state, binding).await
    }

    async fn execute_step(
        &self,
        target: &mut Box<dyn DatabaseSession>,
        step: &crate::domain::QueryStep,
        batch: &[crate::domain::NamedRow],
    ) -> Result<u64, RunError> {
        target
            .execute_named(&step.upsert_sql, batch)
            .await
            .map_err(run_error)
    }

    async fn prepare_step_batch(
        &self,
        source: &mut Box<dyn DatabaseSession>,
        step: &crate::domain::QueryStep,
    ) -> Result<Vec<crate::domain::NamedRow>, RunError> {
        let rows = source.query(&step.select_sql).await.map_err(run_error)?;
        let binds = extract_named_binds(&step.upsert_sql).map_err(|_| {
            RunError::connector(
                "MAPPING_INVALID",
                "target bind syntax could not be validated",
            )
        })?;
        if rows
            .unsupported_bind_columns
            .iter()
            .any(|column| binds.iter().any(|bind| bind.eq_ignore_ascii_case(column)))
        {
            return Err(RunError::connector(
                "BIND_TYPE_UNSUPPORTED",
                "source column type is unsupported by the target bind capability",
            ));
        }
        map_batch(&rows, &step.upsert_sql)
    }

    async fn preflight_step(
        &self,
        source: &mut Box<dyn DatabaseSession>,
        target_kind: DbKind,
        step: &crate::domain::QueryStep,
    ) -> Result<Vec<crate::domain::NamedRow>, RunError> {
        validate_step_policy(target_kind, step)?;
        let batch = self.prepare_step_batch(source, step).await?;
        validate_target_batch_capabilities(target_kind, &batch)?;
        Ok(batch)
    }

    async fn ensure_recovery_binding(&self, binding: &RunBinding) -> Result<(), RecoveryError> {
        let flow = self
            .flows
            .load_flow(&binding.flow.id)
            .await
            .map_err(RecoveryError::from_port)?;
        let source_profile = self
            .flows
            .load_connection(&binding.source_profile.id)
            .await
            .map_err(RecoveryError::from_port)?;
        let target_profile = self
            .flows
            .load_connection(&binding.target_profile.id)
            .await
            .map_err(RecoveryError::from_port)?;
        if flow.as_ref() != Some(&binding.flow)
            || source_profile.as_ref() != Some(&binding.source_profile)
            || target_profile.as_ref() != Some(&binding.target_profile)
        {
            return Err(RecoveryError::new(
                "RECOVERY_CONFIG_MISMATCH",
                "flow or connection configuration changed after the run paused",
            ));
        }
        Ok(())
    }

    async fn open_bound_sessions(
        &self,
        binding: &RunBinding,
    ) -> Result<(Box<dyn DatabaseSession>, Box<dyn DatabaseSession>), RunError> {
        let source_profile = &binding.source_profile;
        let target_profile = &binding.target_profile;
        if source_profile.kind != self.connector.kind()
            || target_profile.kind != self.connector.kind()
        {
            return Err(RunError::connector(
                "CONNECTOR_KIND_MISMATCH",
                "connector kind does not match",
            ));
        }
        let source_secret = self
            .resolve_credential(source_profile)
            .await
            .map_err(run_error)?;
        let target_secret = self
            .resolve_credential(target_profile)
            .await
            .map_err(run_error)?;
        let source = self
            .connector
            .open(source_profile, &source_secret)
            .await
            .map_err(run_error)?;
        let target = self
            .connector
            .open(target_profile, &target_secret)
            .await
            .map_err(run_error)?;
        Ok((source, target))
    }

    async fn apply_bound_recovery(
        &self,
        run_id: &str,
        state: &RunState,
        expected_state: &RunState,
        expected_binding: &RunBinding,
        persisted_binding: &RunBinding,
        updated_flow: Option<&Flow>,
    ) -> Result<(), RecoveryError> {
        match self
            .history
            .apply_bound_recovery(
                run_id,
                state,
                expected_state,
                expected_binding,
                persisted_binding,
                updated_flow,
            )
            .await
            .map_err(RecoveryError::from_port)?
        {
            BoundRecoveryApply::Applied => Ok(()),
            BoundRecoveryApply::ConfigurationChanged => Err(RecoveryError::new(
                "RECOVERY_CONFIG_MISMATCH",
                "flow or connection configuration changed after the run paused",
            )),
            BoundRecoveryApply::RecoveryNoLongerAvailable => Err(RecoveryError::new(
                "RECOVERY_NOT_AVAILABLE",
                "run is no longer awaiting recovery",
            )),
        }
    }

    async fn return_reserved_recovery(
        &self,
        run_id: &str,
        expected_state: &RunState,
        binding: &RunBinding,
    ) -> Result<RunSnapshot, RecoveryError> {
        let mut state = expected_state.clone();
        state
            .return_reserved_recovery_to_awaiting()
            .map_err(recovery_state_error)?;
        self.apply_bound_recovery(run_id, &state, expected_state, binding, binding, None)
            .await?;
        Ok(RunSnapshot::from_state(run_id.into(), &state))
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
        if let Err(rollback_error) = target.rollback().await {
            state
                .mark_in_doubt(step_index, run_error(rollback_error))
                .map_err(|_| {
                    StartRunError::new(
                        "RUN_STATE_INVALID",
                        "run state could not record an indeterminate transaction",
                    )
                })?;
        }
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
        self.create_for_flow(run_id, &state, flow).await
    }

    async fn persist_existing_preflight_failure(
        &self,
        run_id: &str,
        state: RunState,
        step_index: usize,
        error: RunError,
    ) -> Result<RunSnapshot, StartRunError> {
        let mut steps = vec![StepStatus::NotRun; state.steps().len()];
        let events = if let Some(step) = steps.get_mut(step_index) {
            *step = StepStatus::Failed;
            vec![RunEvent::StepFailed {
                step: step_index,
                error,
            }]
        } else {
            Vec::new()
        };
        let state = RunState::from_history(state.policy(), RunStatus::Failed, steps, events);
        self.persist(run_id, &state).await
    }

    async fn create_for_flow(
        &self,
        run_id: &str,
        state: &RunState,
        flow: &Flow,
    ) -> Result<RunSnapshot, StartRunError> {
        self.history
            .create_run_for_flow(run_id, state, flow)
            .await
            .map_err(StartRunError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn create_bound(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<RunSnapshot, StartRunError> {
        self.history
            .create_bound_run(run_id, state, binding)
            .await
            .map_err(StartRunError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn persist(&self, run_id: &str, state: &RunState) -> Result<RunSnapshot, StartRunError> {
        self.history
            .append_run(run_id, state)
            .await
            .map_err(StartRunError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn persist_bound(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<RunSnapshot, StartRunError> {
        self.history
            .append_bound_run(run_id, state, binding)
            .await
            .map_err(StartRunError::from_port)?;
        Ok(RunSnapshot::from_state(run_id.into(), state))
    }

    async fn resolve_credential(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ResolvedSecret, PortError> {
        match self.credentials.resolve(&profile.credential_ref).await {
            Ok(secret) => Ok(secret),
            Err(error)
                if error.code() == "CREDENTIAL_NOT_FOUND"
                    && profile.credential_ref != profile.id =>
            {
                let secret = self.credentials.resolve(&profile.id).await?;
                self.credentials
                    .store(&profile.credential_ref, secret.clone())
                    .await?;
                Ok(secret)
            }
            Err(error) => Err(error),
        }
    }

    fn run_id(&self, _flow: &Flow) -> String {
        Uuid::new_v4().to_string()
    }
}

fn run_error(error: PortError) -> RunError {
    RunError::connector_with_retryable(error.code(), error.message(), error.retryable())
}

fn validate_step_policy(kind: DbKind, step: &crate::domain::QueryStep) -> Result<(), RunError> {
    validate_source_statement(&step.select_sql)
        .and_then(|()| validate_target_statement(kind, &step.upsert_sql))
        .map_err(|_| {
            RunError::connector(
                "STATEMENT_INVALID",
                "source and target SQL must follow the migration statement policy",
            )
        })
}

fn map_batch(
    rows: &crate::domain::RowSet,
    upsert_sql: &str,
) -> Result<Vec<crate::domain::NamedRow>, RunError> {
    let binds = extract_named_binds(upsert_sql).map_err(|_| {
        RunError::connector(
            "MAPPING_INVALID",
            "target bind syntax could not be validated",
        )
    })?;
    validate_row_set_columns(rows, &binds).map_err(|_| {
        RunError::connector(
            "MAPPING_INVALID",
            "source columns do not satisfy target bind parameters",
        )
    })?;
    rows.rows
        .iter()
        .map(|row| map_row(row, &binds))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            RunError::connector(
                "MAPPING_INVALID",
                "source columns do not satisfy target bind parameters",
            )
        })
}

fn validate_target_batch_capabilities(
    kind: DbKind,
    batch: &[crate::domain::NamedRow],
) -> Result<(), RunError> {
    if kind == DbKind::Oracle
        && batch
            .iter()
            .flat_map(|row| row.values())
            .any(|value| match value {
                crate::domain::Value::Timestamp(_) => true,
                crate::domain::Value::OracleTimestamp(value) => {
                    value.tz_hour_offset != 0 || value.tz_minute_offset != 0
                }
                _ => false,
            })
    {
        return Err(RunError::connector(
            "BIND_TYPE_UNSUPPORTED",
            "source timestamp values are not supported by the target bind capability",
        ));
    }
    Ok(())
}

fn recovery_state_error(error: RunError) -> RecoveryError {
    RecoveryError::new(
        error.history_code(),
        "recovery request is not valid for this run",
    )
}
