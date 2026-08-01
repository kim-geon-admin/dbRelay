mod support;

use db_relay::{
    application::{
        migration_runner::MigrationRunner,
        ports::{
            Clock, CredentialStore, DatabaseConnectorFactory, DatabaseSession, PortError,
            ResolvedSecret,
        },
    },
    domain::{
        ConnectionProfile, DbKind, Flow, NamedRow, QueryStep, RowSet, RunStatus, TransactionPolicy,
        Value,
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
        let runner = MigrationRunner::new(
            connector.clone(),
            repository.clone(),
            repository.clone(),
            credentials,
            Arc::new(FixedClock),
        );

        Self {
            runner,
            flow_id,
            history: repository,
            connector,
        }
    }

    fn source_rows_for_step(self, step: usize, rows: RowSet) -> Self {
        self.connector.set_source_rows(step, rows);
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

    fn target_operations(&self) -> Vec<String> {
        self.connector.target_operations()
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
    source_query_count: Mutex<usize>,
    source_failures: Mutex<BTreeMap<usize, PortError>>,
    target_operations: Mutex<Vec<String>>,
    target_execute_count: Mutex<usize>,
    target_failures: Mutex<BTreeMap<usize, PortError>>,
}

impl RunnerConnectorFactory {
    fn set_source_rows(&self, step: usize, rows: RowSet) {
        self.state.source_rows.lock().unwrap().insert(step, rows);
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
    async fn query(&mut self, _sql: &str) -> Result<RowSet, PortError> {
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
        let step = query % 2;
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
        self.state
            .target_operations
            .lock()
            .unwrap()
            .push("begin".into());
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
        self.state
            .target_operations
            .lock()
            .unwrap()
            .push("commit".into());
        Ok(())
    }

    async fn rollback(&mut self) -> Result<(), PortError> {
        self.state
            .target_operations
            .lock()
            .unwrap()
            .push("rollback".into());
        Ok(())
    }
}
