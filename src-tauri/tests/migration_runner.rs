mod support;

use db_relay::{
    application::{
        migration_runner::{MigrationRunner, RecoveryRequest},
        ports::{
            BoundRecoveryApply, Clock, CredentialStore, DatabaseConnectorFactory, DatabaseSession,
            FlowRepository, HistoryRepository, PortError, ResolvedSecret, RunBinding,
        },
    },
    domain::{
        ConnectionProfile, DbKind, Flow, NamedRow, QueryStep, RecoveryAction, RowSet, RunError,
        RunEvent, RunState, RunStatus, StepStatus, TransactionPolicy, Value,
    },
    infrastructure::sqlite::SqliteStore,
};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use support::{FakeConnectorFactory, FakeSession, MemoryCredentialStore};

#[test]
fn production_library_does_not_export_test_fakes() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let application_module = std::fs::read_to_string(manifest_dir.join("src/application/mod.rs"))
        .expect("application module should exist");

    assert!(!application_module.contains("test_support"));
    assert!(!manifest_dir
        .join("src/application/test_support.rs")
        .exists());
}

#[test]
fn production_ports_do_not_offer_a_raw_secret_constructor() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ports = std::fs::read_to_string(manifest_dir.join("src/application/ports.rs"))
        .expect("ports module should exist");

    assert!(!ports.contains("pub fn new(value: impl Into<String>) -> Self"));
    assert!(ports.contains("#[cfg(feature = \"test-support\")]"));
}

#[tokio::test]
async fn factory_sessions_are_isolated_while_the_observer_keeps_each_open_log() {
    let factory = FakeConnectorFactory::with_session(
        "source",
        FakeSession::with_rows(RowSet::single([("ID", Value::Int(1))])),
    );
    let credential_store = MemoryCredentialStore::with_secret("credential://source", "secret");
    let secret = credential_store
        .resolve("credential://source")
        .await
        .unwrap();
    let profile = ConnectionProfile {
        id: "source".into(),
        display_name: "Source".into(),
        kind: DbKind::Oracle,
        host: "localhost".into(),
        port: 1521,
        service_name: "XE".into(),
        username: "scott".into(),
        credential_ref: "credential://source".into(),
        enabled: true,
    };

    let mut first = factory.open(&profile, &secret).await.unwrap();
    first.begin().await.unwrap();
    first.commit().await.unwrap();

    let mut second = factory.open(&profile, &secret).await.unwrap();
    second.begin().await.unwrap();
    second.rollback().await.unwrap();

    assert_eq!(
        factory.operations_for_open("source", 0),
        ["begin", "commit"]
    );
    assert_eq!(
        factory.operations_for_open("source", 1),
        ["begin", "rollback"]
    );
}

#[tokio::test]
async fn fake_session_returns_configured_rows_and_records_named_batch() {
    let mut session = FakeSession::with_rows(RowSet::single([("ID", Value::Int(1))]));

    assert_eq!(
        session
            .query("select id from customer")
            .await
            .unwrap()
            .rows
            .len(),
        1
    );

    session
        .execute_named(
            "merge into customer ... :ID",
            &[NamedRow::from([("ID".into(), Value::Int(1))])],
        )
        .await
        .unwrap();

    assert_eq!(session.executed_sql(), ["merge into customer ... :ID"]);
}

#[tokio::test]
async fn fake_session_records_transaction_order_and_fails_configured_statement() {
    let mut session = FakeSession::with_rows(RowSet::default());
    session.fail_on_execute_named("merge into customer ... :ID");

    session.begin().await.unwrap();
    assert!(session
        .execute_named("merge into customer ... :ID", &[])
        .await
        .is_err());
    session.rollback().await.unwrap();

    assert_eq!(
        session.operations(),
        ["begin", "execute:merge into customer ... :ID", "rollback"]
    );
}

#[tokio::test]
async fn all_or_nothing_rolls_back_target_when_the_second_step_fails() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address())
        .target_fails_on_step(1);

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::RolledBack);
    assert_eq!(
        harness.target_operations(),
        ["begin", "execute:0", "execute:1", "rollback"]
    );
}

#[tokio::test]
async fn rollback_failure_is_persisted_as_an_indeterminate_run() {
    // Would fail if the runner discarded a rollback error and claimed the
    // target transaction had been rolled back.
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address())
        .target_fails_on_step(1)
        .target_fails_on_rollback(PortError::new("ORA-03113", "rollback connection lost"));

    let result = harness.runner.start(&harness.flow_id).await.unwrap();
    let persisted = harness.history.load_run(&result.run_id).unwrap().unwrap();

    assert!(matches!(result.status, RunStatus::InDoubt { step: 1, .. }));
    assert!(matches!(
        persisted.status(),
        RunStatus::InDoubt { step: 1, .. }
    ));
    assert!(harness
        .runner
        .recover(
            &result.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "address".into(),
            },
        )
        .await
        .is_err());
}

#[tokio::test]
async fn missing_bind_column_blocks_execution_before_target_begin() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, RowSet::single([("UNRELATED", Value::Int(1))]))
        .source_rows_for_step(1, rows_for_address());

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::Failed);
    assert_eq!(harness.target_operations(), Vec::<String>::new());
    assert_eq!(
        harness
            .history
            .load_run(&result.run_id)
            .unwrap()
            .unwrap()
            .status(),
        RunStatus::Failed
    );
}

#[tokio::test]
async fn zero_row_source_without_required_alias_blocks_execution_before_target_begin() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, RowSet::default())
        .source_rows_for_step(1, rows_for_address());

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::Failed);
    assert_eq!(harness.target_operations(), Vec::<String>::new());
}

#[tokio::test]
async fn numeric_target_bind_blocks_execution_before_target_begin() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing).step_sql(
        0,
        "select id from customer",
        "merge customer using dual on (id = :1)",
    );

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::Failed);
    assert_eq!(harness.target_operations(), Vec::<String>::new());
}

#[tokio::test]
async fn successful_all_or_nothing_run_commits_target_once() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address());

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::Completed);
    assert_eq!(
        harness.target_operations(),
        ["begin", "execute:0", "execute:1", "commit"]
    );
}

#[tokio::test]
async fn committed_steps_are_preserved_and_a_failure_waits_for_recovery() {
    // Would fail if commit-successes ran all steps in one transaction or executed after a failure.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);

    let run = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(run.status, RunStatus::AwaitingRecovery { failed_step: 1 });
    assert_eq!(
        harness.target_operations(),
        [
            "begin:0",
            "execute:0",
            "commit:0",
            "begin:1",
            "execute:1",
            "rollback:1"
        ]
    );
}

#[tokio::test]
async fn skip_records_the_decision_then_completes_the_remaining_steps() {
    // Would fail if skip did not persist the skipped status before resuming execution.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();

    let run = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "address".into(),
            },
        )
        .await
        .unwrap();

    assert_eq!(run.steps[1], StepStatus::SkippedByUser);
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(
        harness
            .history
            .load_run(&paused.run_id)
            .unwrap()
            .unwrap()
            .status(),
        RunStatus::Completed
    );
}

#[tokio::test]
async fn edit_and_retry_versions_the_flow_and_executes_the_failed_step() {
    // Would fail if recovery updated another step, skipped validation, or did not resume execution.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();

    let run = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::EditAndRetry {
                step_id: "address".into(),
                select_sql: "select address_id from revised_address".into(),
                upsert_sql: "merge revised_address using dual on (address_id = :ADDRESS_ID)".into(),
            },
        )
        .await
        .unwrap();

    assert_eq!(run.status, RunStatus::Completed);
    assert!(matches!(
        run.steps[1],
        StepStatus::Succeeded { affected_rows: 1 }
    ));
    let flow = harness.history.load_flow(&harness.flow_id).unwrap();
    assert_eq!(flow.version, 2);
    assert_eq!(
        flow.query_steps[1].select_sql,
        "select address_id from revised_address"
    );
}

#[tokio::test]
async fn invalid_recovery_edit_does_not_overwrite_the_saved_flow() {
    // Would fail if the recovery transition saves the candidate flow before it
    // has passed source/bind preflight.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    let saved_flow = harness.history.load_flow(&harness.flow_id).unwrap();

    let run = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::EditAndRetry {
                step_id: "address".into(),
                select_sql: "delete from address".into(),
                upsert_sql: "merge revised_address using dual on (address_id = :ADDRESS_ID)".into(),
            },
        )
        .await
        .unwrap();

    assert_eq!(run.status, RunStatus::AwaitingRecovery { failed_step: 1 });
    assert_eq!(
        harness.history.load_flow(&harness.flow_id).unwrap(),
        saved_flow
    );
}

#[tokio::test]
async fn retry_failure_returns_to_awaiting_recovery() {
    // Would fail if a retry failure escaped without restoring the recoverable state.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    harness
        .connector
        .fail_target_step(2, PortError::new("FAKE_RETRY", "retry target write failed"));

    let run = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::EditAndRetry {
                step_id: "address".into(),
                select_sql: "select address_id from address".into(),
                upsert_sql: "merge address using dual on (address_id = :ADDRESS_ID)".into(),
            },
        )
        .await
        .unwrap();

    assert_eq!(run.status, RunStatus::AwaitingRecovery { failed_step: 1 });
    assert_eq!(run.steps[0], StepStatus::Succeeded { affected_rows: 1 });
    assert_eq!(run.steps[1], StepStatus::Failed);
}

#[tokio::test]
async fn recovery_rechecks_changed_zero_row_metadata_before_opening_a_target_transaction() {
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    let operations_before_recovery = harness.target_operations();

    // Query 4 is the recovery preflight; query 5 is the execution read that
    // must still be prepared before `begin`.
    harness.source_rows_for_query(5, RowSet::default());
    let run = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::EditAndRetry {
                step_id: "address".into(),
                select_sql: "select address_id from address".into(),
                upsert_sql: "merge address using dual on (address_id = :ADDRESS_ID)".into(),
            },
        )
        .await
        .unwrap();

    assert_eq!(run.status, RunStatus::AwaitingRecovery { failed_step: 1 });
    assert_eq!(harness.target_operations(), operations_before_recovery);
}

#[tokio::test]
async fn recovery_rejects_a_request_for_a_nonfailed_step() {
    // Would fail if recovery trusted a client-provided step ID instead of the paused run state.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();

    let error = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "customer".into(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "RECOVERY_STEP_MISMATCH");
}

#[tokio::test]
async fn recovery_rejects_a_flow_changed_after_the_run_paused() {
    // Would fail if recovery loaded mutable flow configuration instead of its paused-run binding.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    let operations_before_recovery = harness.target_operations();

    let replacement_target = connection_profile("replacement-target", "credential://replacement");
    harness
        .history
        .save_connection(&replacement_target)
        .unwrap();
    let mut changed_flow = harness.history.load_flow(&harness.flow_id).unwrap();
    changed_flow.target_connection_id = replacement_target.id;
    changed_flow.transaction_policy = TransactionPolicy::AllOrNothing;
    changed_flow.query_steps[0].upsert_sql =
        "merge changed_customer using dual on (id = :ID)".into();
    changed_flow.version += 1;
    harness.history.save_flow(&changed_flow).unwrap();

    let error = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "address".into(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "RECOVERY_CONFIG_MISMATCH");
    assert_eq!(harness.target_operations(), operations_before_recovery);
}

#[tokio::test]
async fn recovery_rejects_profile_only_drift_before_target_activity() {
    // Would fail if recovery compared only the flow and not its bound connection profiles.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    let operations_before_recovery = harness.target_operations();

    let mut changed_target = harness.history.load_connection("target").unwrap();
    changed_target.host = "changed.internal".into();
    harness.history.save_connection(&changed_target).unwrap();

    let error = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "address".into(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "RECOVERY_CONFIG_MISMATCH");
    assert_eq!(harness.target_operations(), operations_before_recovery);
}

#[tokio::test]
async fn recovery_rejects_a_change_that_interleaves_after_preliminary_validation() {
    // Would fail if a config write could slip between validation and the recovery transition.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(1);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    let operations_before_recovery = harness.target_operations();
    let mut changed_flow = harness.history.load_flow(&harness.flow_id).unwrap();
    changed_flow.query_steps[0].upsert_sql = "merge raced_customer using dual on (id = :ID)".into();
    changed_flow.version += 1;
    let flows = Arc::new(InterleavingFlowRepository::after_target_profile_read(
        harness.history.clone(),
        changed_flow,
    ));
    let runner = MigrationRunner::new(
        harness.connector.clone(),
        flows,
        harness.history.clone(),
        harness.credentials.clone(),
        Arc::new(FixedClock),
    );

    let error = runner
        .recover(
            &paused.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "address".into(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "RECOVERY_CONFIG_MISMATCH");
    assert_eq!(harness.target_operations(), operations_before_recovery);
}

#[tokio::test]
async fn competing_recovery_rejects_skip_after_stop_wins_without_target_activity() {
    // Would fail if a second recovery could overwrite a committed Stop transition.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(0);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();
    let operations_before_recovery = harness.target_operations();
    let history = Arc::new(CompetingRecoveryHistory::stop_before_next_apply(
        harness.history.clone(),
    ));
    let runner = MigrationRunner::new(
        harness.connector.clone(),
        harness.history.clone(),
        history,
        harness.credentials.clone(),
        Arc::new(FixedClock),
    );

    let error = runner
        .recover(
            &paused.run_id,
            RecoveryRequest::SkipAndContinue {
                step_id: "customer".into(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "RECOVERY_NOT_AVAILABLE");
    assert_eq!(harness.target_operations(), operations_before_recovery);
    assert_eq!(
        harness
            .history
            .load_run(&paused.run_id)
            .unwrap()
            .unwrap()
            .status(),
        RunStatus::StoppedByUser
    );
}

#[tokio::test]
async fn stop_preserves_committed_steps_and_does_not_execute_later_steps() {
    // Would fail if stop continued the run after recording the user's decision.
    let harness =
        RunnerHarness::with_policy(TransactionPolicy::CommitSuccesses).target_fails_on_step(0);
    let paused = harness.runner.start(&harness.flow_id).await.unwrap();

    let run = harness
        .runner
        .recover(
            &paused.run_id,
            RecoveryRequest::Stop {
                step_id: "customer".into(),
            },
        )
        .await
        .unwrap();

    assert_eq!(run.status, RunStatus::StoppedByUser);
    assert_eq!(run.steps[1], StepStatus::NotRun);
    assert_eq!(
        harness.target_operations(),
        ["begin:0", "execute:0", "rollback:0"]
    );
}

#[tokio::test]
async fn source_query_failure_after_preflight_rolls_back_target() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address())
        .source_fails_while_executing_step(0);

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::RolledBack);
    assert_eq!(harness.target_operations(), ["begin", "rollback"]);
}

#[tokio::test]
async fn persisted_execution_error_never_contains_a_secret() {
    let secret = "runner-secret-fixture";
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address())
        .target_fails_on_step_with_error(
            0,
            PortError::new("ORA-00001", format!("password={secret}")),
        );

    let result = harness.runner.start(&harness.flow_id).await.unwrap();

    assert_eq!(result.status, RunStatus::RolledBack);
    assert!(!harness.history.dump_for_test().contains(secret));
}

#[tokio::test]
async fn retryable_connector_errors_survive_runner_and_history_round_trip() {
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address())
        .target_fails_on_step_with_error(
            0,
            PortError::with_retryable("ORA-03113", "end-of-file on communication channel", true),
        );

    let result = harness.runner.start(&harness.flow_id).await.unwrap();
    let state = harness.history.load_run(&result.run_id).unwrap().unwrap();

    assert!(matches!(
        state.events().first(),
        Some(RunEvent::StepFailed {
            error: RunError::Connector(error),
            ..
        }) if error.code() == "ORA-03113" && error.retryable()
    ));
}

#[tokio::test]
async fn commit_failure_is_persisted_as_an_indeterminate_outcome() {
    let secret = "commit-secret-fixture";
    let harness = RunnerHarness::with_policy(TransactionPolicy::AllOrNothing)
        .source_rows_for_step(0, rows_for_customer())
        .source_rows_for_step(1, rows_for_address())
        .target_fails_on_commit(PortError::new("ORA-00942", format!("password={secret}")));

    let result = harness.runner.start(&harness.flow_id).await.unwrap();
    let state = harness.history.load_run(&result.run_id).unwrap().unwrap();

    assert!(matches!(result.status, RunStatus::InDoubt { step: 1, .. }));
    assert_eq!(
        harness.target_operations(),
        ["begin", "execute:0", "execute:1", "commit", "rollback"]
    );
    assert!(matches!(
        state.steps()[1].status,
        StepStatus::Succeeded { affected_rows: 1 }
    ));
    assert!(matches!(
        state.events().last(),
        Some(RunEvent::TransactionFailed {
            error: RunError::Connector(error),
        }) if error.code() == "ORA-00942" && error.message() == "sanitized persisted run error"
    ));
    assert!(!harness.history.dump_for_test().contains(secret));
}

fn rows_for_customer() -> RowSet {
    RowSet::single([("ID", Value::Int(1))])
}

fn rows_for_address() -> RowSet {
    RowSet::single([("ADDRESS_ID", Value::Int(2))])
}

struct RunnerHarness {
    runner: MigrationRunner<
        RunnerConnectorFactory,
        SqliteStore,
        SqliteStore,
        MemoryCredentialStore,
        FixedClock,
    >,
    flow_id: String,
    history: Arc<SqliteStore>,
    connector: Arc<RunnerConnectorFactory>,
    credentials: Arc<MemoryCredentialStore>,
}

impl RunnerHarness {
    fn with_policy(policy: TransactionPolicy) -> Self {
        let repository = Arc::new(SqliteStore::in_memory().unwrap());
        let source = connection_profile("source", "credential://source");
        let target = connection_profile("target", "credential://target");
        repository.save_connection(&source).unwrap();
        repository.save_connection(&target).unwrap();

        let flow_id = "flow-1".to_owned();
        repository
            .save_flow(&Flow {
                id: flow_id.clone(),
                name: "Migration".into(),
                source_connection_id: source.id,
                target_connection_id: target.id,
                query_steps: vec![
                    QueryStep {
                        id: "customer".into(),
                        select_sql: "select id from customer".into(),
                        upsert_sql: "merge customer using dual on (id = :ID)".into(),
                    },
                    QueryStep {
                        id: "address".into(),
                        select_sql: "select address_id from address".into(),
                        upsert_sql: "merge address using dual on (id = :ADDRESS_ID)".into(),
                    },
                ],
                transaction_policy: policy,
                version: 1,
            })
            .unwrap();

        let credentials = Arc::new(MemoryCredentialStore::with_secret(
            "credential://source",
            "source-secret",
        ));
        credentials.insert("credential://target", "target-secret");
        let connector = Arc::new(RunnerConnectorFactory::default());
        connector.set_committed_step_labels(policy == TransactionPolicy::CommitSuccesses);
        connector.set_source_rows(0, rows_for_customer());
        connector.set_source_rows(1, rows_for_address());
        let runner = MigrationRunner::new(
            connector.clone(),
            repository.clone(),
            repository.clone(),
            credentials.clone(),
            Arc::new(FixedClock),
        );

        Self {
            runner,
            flow_id,
            history: repository,
            connector,
            credentials,
        }
    }

    fn source_rows_for_step(self, step: usize, rows: RowSet) -> Self {
        self.connector.set_source_rows(step, rows);
        self
    }

    fn source_rows_for_query(&self, query: usize, rows: RowSet) {
        self.connector.set_source_rows_for_query(query, rows);
    }

    fn step_sql(self, step: usize, select_sql: &str, upsert_sql: &str) -> Self {
        let mut flow = self.history.load_flow(&self.flow_id).unwrap();
        flow.query_steps[step].select_sql = select_sql.into();
        flow.query_steps[step].upsert_sql = upsert_sql.into();
        self.history.save_flow(&flow).unwrap();
        self
    }

    fn source_fails_while_executing_step(self, step: usize) -> Self {
        self.connector.fail_source_query_at(2 + step);
        self
    }

    fn target_fails_on_step(self, step: usize) -> Self {
        self.target_fails_on_step_with_error(
            step,
            PortError::new("FAKE_EXECUTE", "target write failed"),
        )
    }

    fn target_fails_on_step_with_error(self, step: usize, error: PortError) -> Self {
        self.connector.fail_target_step(step, error);
        self
    }

    fn target_fails_on_commit(self, error: PortError) -> Self {
        self.connector.fail_target_commit(error);
        self
    }

    fn target_fails_on_rollback(self, error: PortError) -> Self {
        self.connector.fail_target_rollback(error);
        self
    }

    fn target_operations(&self) -> Vec<String> {
        self.connector.target_operations()
    }
}

struct InterleavingFlowRepository {
    store: Arc<SqliteStore>,
    flow_to_save: Mutex<Option<Flow>>,
}

impl InterleavingFlowRepository {
    fn after_target_profile_read(store: Arc<SqliteStore>, flow_to_save: Flow) -> Self {
        Self {
            store,
            flow_to_save: Mutex::new(Some(flow_to_save)),
        }
    }
}

#[async_trait::async_trait]
impl FlowRepository for InterleavingFlowRepository {
    async fn load_flow(&self, flow_id: &str) -> Result<Option<Flow>, PortError> {
        self.store.load_flow(flow_id).map(Some)
    }

    async fn save_flow(&self, flow: &Flow) -> Result<(), PortError> {
        self.store.save_flow(flow)
    }

    async fn list_flows(&self) -> Result<Vec<Flow>, PortError> {
        self.store.list_flows()
    }

    async fn load_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError> {
        let profile = self.store.load_connection(connection_id)?;
        if connection_id == "target" {
            if let Some(flow) = self.flow_to_save.lock().unwrap().take() {
                self.store.save_flow(&flow)?;
            }
        }
        Ok(Some(profile))
    }

    async fn save_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError> {
        self.store.save_connection(profile)
    }

    async fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError> {
        self.store.list_connections()
    }

    async fn update_connection(&self, profile: &ConnectionProfile) -> Result<(), PortError> {
        self.store.update_connection_without_credential(profile)
    }

    async fn disable_connection(&self, connection_id: &str) -> Result<(), PortError> {
        self.store.disable_connection(connection_id)
    }

    async fn delete_connection(&self, connection_id: &str) -> Result<(), PortError> {
        self.store.delete_connection(connection_id)
    }
}

struct CompetingRecoveryHistory {
    store: Arc<SqliteStore>,
    stop_before_next_apply: Mutex<bool>,
}

impl CompetingRecoveryHistory {
    fn stop_before_next_apply(store: Arc<SqliteStore>) -> Self {
        Self {
            store,
            stop_before_next_apply: Mutex::new(true),
        }
    }
}

#[async_trait::async_trait]
impl HistoryRepository for CompetingRecoveryHistory {
    async fn append_run(&self, run_id: &str, state: &RunState) -> Result<(), PortError> {
        self.store.append_run(run_id, state)
    }

    async fn load_run(&self, run_id: &str) -> Result<Option<RunState>, PortError> {
        self.store.load_run(run_id)
    }

    async fn append_bound_run(
        &self,
        run_id: &str,
        state: &RunState,
        binding: &RunBinding,
    ) -> Result<(), PortError> {
        self.store.append_bound_run(run_id, state, binding)
    }

    async fn load_run_binding(&self, run_id: &str) -> Result<Option<RunBinding>, PortError> {
        self.store.load_run_binding(run_id)
    }

    async fn apply_bound_recovery(
        &self,
        run_id: &str,
        state: &RunState,
        expected_state: &RunState,
        expected_binding: &RunBinding,
        persisted_binding: &RunBinding,
        updated_flow: Option<&Flow>,
    ) -> Result<BoundRecoveryApply, PortError> {
        if std::mem::take(&mut *self.stop_before_next_apply.lock().unwrap()) {
            let mut stopped = self.store.load_run(run_id)?.unwrap();
            stopped.apply_recovery(RecoveryAction::Stop).unwrap();
            let result = self.store.apply_bound_recovery(
                run_id,
                &stopped,
                expected_state,
                expected_binding,
                expected_binding,
                None,
            )?;
            assert_eq!(result, BoundRecoveryApply::Applied);
        }
        self.store.apply_bound_recovery(
            run_id,
            state,
            expected_state,
            expected_binding,
            persisted_binding,
            updated_flow,
        )
    }
}

fn connection_profile(id: &str, credential_ref: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        display_name: id.into(),
        kind: DbKind::Oracle,
        host: "db.internal".into(),
        port: 1521,
        service_name: "XE".into(),
        username: "relay".into(),
        credential_ref: credential_ref.into(),
        enabled: true,
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1)
    }
}

struct RunnerConnectorFactory {
    state: Arc<RunnerConnectorState>,
}

impl Default for RunnerConnectorFactory {
    fn default() -> Self {
        Self {
            state: Arc::new(RunnerConnectorState::default()),
        }
    }
}

#[derive(Default)]
struct RunnerConnectorState {
    source_rows: Mutex<BTreeMap<usize, RowSet>>,
    source_rows_by_query: Mutex<BTreeMap<usize, RowSet>>,
    source_query_count: Mutex<usize>,
    source_failures: Mutex<BTreeMap<usize, PortError>>,
    target_operations: Mutex<Vec<String>>,
    target_execute_count: Mutex<usize>,
    target_failures: Mutex<BTreeMap<usize, PortError>>,
    target_commit_failure: Mutex<Option<PortError>>,
    target_rollback_failure: Mutex<Option<PortError>>,
    committed_step_labels: Mutex<bool>,
}

impl RunnerConnectorFactory {
    fn set_committed_step_labels(&self, enabled: bool) {
        *self.state.committed_step_labels.lock().unwrap() = enabled;
    }

    fn set_source_rows(&self, step: usize, rows: RowSet) {
        self.state.source_rows.lock().unwrap().insert(step, rows);
    }

    fn set_source_rows_for_query(&self, query: usize, rows: RowSet) {
        self.state
            .source_rows_by_query
            .lock()
            .unwrap()
            .insert(query, rows);
    }

    fn fail_source_query_at(&self, query: usize) {
        self.state
            .source_failures
            .lock()
            .unwrap()
            .insert(query, PortError::new("FAKE_SOURCE", "source query failed"));
    }

    fn fail_target_step(&self, step: usize, error: PortError) {
        self.state
            .target_failures
            .lock()
            .unwrap()
            .insert(step, error);
    }

    fn fail_target_commit(&self, error: PortError) {
        *self.state.target_commit_failure.lock().unwrap() = Some(error);
    }

    fn fail_target_rollback(&self, error: PortError) {
        *self.state.target_rollback_failure.lock().unwrap() = Some(error);
    }

    fn target_operations(&self) -> Vec<String> {
        self.state.target_operations.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl DatabaseConnectorFactory for RunnerConnectorFactory {
    fn kind(&self) -> DbKind {
        DbKind::Oracle
    }

    async fn open(
        &self,
        profile: &ConnectionProfile,
        _secret: &ResolvedSecret,
    ) -> Result<Box<dyn DatabaseSession>, PortError> {
        match profile.id.as_str() {
            "source" => Ok(Box::new(RunnerSourceSession {
                state: self.state.clone(),
            })),
            "target" => Ok(Box::new(RunnerTargetSession {
                state: self.state.clone(),
            })),
            _ => Err(PortError::new("FAKE_CONNECTION", "unknown connection")),
        }
    }
}

struct RunnerSourceSession {
    state: Arc<RunnerConnectorState>,
}

#[async_trait::async_trait]
impl DatabaseSession for RunnerSourceSession {
    async fn query(&mut self, sql: &str) -> Result<RowSet, PortError> {
        let query = {
            let mut count = self.state.source_query_count.lock().unwrap();
            let query = *count;
            *count += 1;
            query
        };
        if let Some(error) = self
            .state
            .source_failures
            .lock()
            .unwrap()
            .get(&query)
            .cloned()
        {
            return Err(error);
        }
        if let Some(rows) = self
            .state
            .source_rows_by_query
            .lock()
            .unwrap()
            .get(&query)
            .cloned()
        {
            return Ok(rows);
        }
        let step = usize::from(sql.contains("address"));
        self.state
            .source_rows
            .lock()
            .unwrap()
            .get(&step)
            .cloned()
            .ok_or_else(|| PortError::new("FAKE_SOURCE", "source rows missing"))
    }

    async fn begin(&mut self) -> Result<(), PortError> {
        Ok(())
    }
    async fn execute_named(&mut self, _sql: &str, _batch: &[NamedRow]) -> Result<u64, PortError> {
        Ok(0)
    }
    async fn commit(&mut self) -> Result<(), PortError> {
        Ok(())
    }
    async fn rollback(&mut self) -> Result<(), PortError> {
        Ok(())
    }
}

struct RunnerTargetSession {
    state: Arc<RunnerConnectorState>,
}

#[async_trait::async_trait]
impl DatabaseSession for RunnerTargetSession {
    async fn query(&mut self, _sql: &str) -> Result<RowSet, PortError> {
        Ok(RowSet::default())
    }

    async fn begin(&mut self) -> Result<(), PortError> {
        let operation = if *self.state.committed_step_labels.lock().unwrap() {
            let step = *self.state.target_execute_count.lock().unwrap();
            format!("begin:{step}")
        } else {
            "begin".into()
        };
        self.state.target_operations.lock().unwrap().push(operation);
        Ok(())
    }

    async fn execute_named(&mut self, _sql: &str, batch: &[NamedRow]) -> Result<u64, PortError> {
        let step = {
            let mut count = self.state.target_execute_count.lock().unwrap();
            let step = *count;
            *count += 1;
            step
        };
        self.state
            .target_operations
            .lock()
            .unwrap()
            .push(format!("execute:{step}"));
        if let Some(error) = self
            .state
            .target_failures
            .lock()
            .unwrap()
            .get(&step)
            .cloned()
        {
            return Err(error);
        }
        Ok(batch.len() as u64)
    }

    async fn commit(&mut self) -> Result<(), PortError> {
        let operation = if *self.state.committed_step_labels.lock().unwrap() {
            let step = self
                .state
                .target_execute_count
                .lock()
                .unwrap()
                .saturating_sub(1);
            format!("commit:{step}")
        } else {
            "commit".into()
        };
        self.state.target_operations.lock().unwrap().push(operation);
        self.state
            .target_commit_failure
            .lock()
            .unwrap()
            .clone()
            .map_or(Ok(()), Err)
    }

    async fn rollback(&mut self) -> Result<(), PortError> {
        let operation = if *self.state.committed_step_labels.lock().unwrap() {
            let step = self
                .state
                .target_execute_count
                .lock()
                .unwrap()
                .saturating_sub(1);
            format!("rollback:{step}")
        } else {
            "rollback".into()
        };
        self.state.target_operations.lock().unwrap().push(operation);
        self.state
            .target_rollback_failure
            .lock()
            .unwrap()
            .clone()
            .map_or(Ok(()), Err)
    }
}
