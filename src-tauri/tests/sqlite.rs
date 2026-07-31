use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "test-support")]
use std::sync::Mutex;

use async_trait::async_trait;
use db_relay::{
    application::{
        flow_service::FlowService,
        ports::{CredentialStore, FlowRepository, PortError, ResolvedSecret},
        settings_service::SettingsService,
    },
    domain::{
        ConnectionProfile, DbKind, Flow, QueryStep, RecoveryAction, RunError, RunState,
        TransactionPolicy,
    },
    infrastructure::sqlite::SqliteStore,
};

struct CredentialsNotUsed;

#[async_trait]
impl CredentialStore for CredentialsNotUsed {
    async fn store(&self, _credential_ref: &str, _secret: ResolvedSecret) -> Result<(), PortError> {
        panic!("credential replacement was not requested")
    }

    async fn resolve(&self, _credential_ref: &str) -> Result<ResolvedSecret, PortError> {
        panic!("connection testing was not requested")
    }

    async fn delete(&self, _credential_ref: &str) -> Result<(), PortError> {
        panic!("credential deletion was not requested")
    }
}

#[cfg(feature = "test-support")]
#[derive(Default)]
struct RecordingCredentialStore {
    stored_connection_ids: Mutex<Vec<String>>,
}

#[cfg(feature = "test-support")]
impl RecordingCredentialStore {
    fn stored_connection_ids(&self) -> Vec<String> {
        self.stored_connection_ids
            .lock()
            .expect("recording credential store lock poisoned")
            .clone()
    }
}

#[cfg(feature = "test-support")]
#[async_trait]
impl CredentialStore for RecordingCredentialStore {
    async fn store(&self, connection_id: &str, _secret: ResolvedSecret) -> Result<(), PortError> {
        self.stored_connection_ids
            .lock()
            .expect("recording credential store lock poisoned")
            .push(connection_id.into());
        Ok(())
    }

    async fn resolve(&self, _connection_id: &str) -> Result<ResolvedSecret, PortError> {
        unreachable!("connection testing was not requested")
    }

    async fn delete(&self, _connection_id: &str) -> Result<(), PortError> {
        unreachable!("credential deletion was not requested")
    }
}

fn profile(id: &str, credential_ref: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        display_name: format!("{id} database"),
        kind: DbKind::Oracle,
        host: "db.internal".into(),
        port: 1521,
        service_name: "XE".into(),
        username: "relay".into(),
        credential_ref: credential_ref.into(),
        enabled: true,
    }
}

fn flow_referencing(source_connection_id: &str, target_connection_id: &str) -> Flow {
    Flow {
        id: "daily-sync".into(),
        name: "Daily sync".into(),
        source_connection_id: source_connection_id.into(),
        target_connection_id: target_connection_id.into(),
        query_steps: vec![
            QueryStep {
                id: "extract-customers".into(),
                select_sql: "select customer_id from source_customer".into(),
                upsert_sql: "merge into target_customer using dual on (id = :CUSTOMER_ID)".into(),
            },
            QueryStep {
                id: "extract-orders".into(),
                select_sql: "select order_id from source_order".into(),
                upsert_sql: "merge into target_order using dual on (id = :ORDER_ID)".into(),
            },
        ],
        transaction_policy: TransactionPolicy::CommitSuccesses,
        version: 3,
    }
}

#[test]
fn saving_a_flow_persists_references_but_never_a_password() {
    let store = SqliteStore::in_memory().unwrap();
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store
        .save_connection(&profile("target", "credential://db-relay/target"))
        .unwrap();
    store
        .save_flow(&flow_referencing("source", "target"))
        .unwrap();

    assert_eq!(
        store.load_flow("daily-sync").unwrap().source_connection_id,
        "source"
    );
    assert!(!store
        .dump_for_test()
        .contains("correct-horse-battery-staple"));
}

#[test]
fn query_steps_round_trip_in_their_saved_order() {
    let store = SqliteStore::in_memory().unwrap();
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store
        .save_connection(&profile("target", "credential://db-relay/target"))
        .unwrap();
    store
        .save_flow(&flow_referencing("source", "target"))
        .unwrap();

    let flow = store.load_flow("daily-sync").unwrap();

    assert_eq!(
        flow.query_steps
            .iter()
            .map(|step| step.id.as_str())
            .collect::<Vec<_>>(),
        ["extract-customers", "extract-orders"]
    );
}

#[tokio::test]
async fn updating_a_connection_without_a_replacement_keeps_its_credential_reference() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    store
        .save_connection(&profile("source", "credential://db-relay/original"))
        .unwrap();

    let mut edited = profile("source", "credential://db-relay/replacement");
    edited.display_name = "Renamed source".into();
    SettingsService::new(store.clone(), Arc::new(CredentialsNotUsed))
        .update_connection(&edited, None)
        .await
        .unwrap();

    let loaded = store.load_connection("source").unwrap();
    assert_eq!(loaded.display_name, "Renamed source");
    assert_eq!(loaded.credential_ref, "credential://db-relay/original");
}

#[test]
fn deleting_a_connection_referenced_by_a_flow_is_rejected() {
    let store = SqliteStore::in_memory().unwrap();
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store
        .save_connection(&profile("target", "credential://db-relay/target"))
        .unwrap();
    store
        .save_flow(&flow_referencing("source", "target"))
        .unwrap();

    let error = store.delete_connection("source").unwrap_err();

    assert_eq!(error.code(), "CONNECTION_REFERENCED");
    assert_eq!(store.load_connection("source").unwrap().id, "source");
}

#[test]
fn disabled_connections_are_blocked_when_a_run_loads_them() {
    let store = SqliteStore::in_memory().unwrap();
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store.disable_connection("source").unwrap();

    let error = store.load_runnable_connection("source").unwrap_err();

    assert_eq!(error.code(), "CONNECTION_DISABLED");
}

#[tokio::test]
async fn duplicating_a_flow_assigns_the_requested_new_id() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store
        .save_connection(&profile("target", "credential://db-relay/target"))
        .unwrap();
    store
        .save_flow(&flow_referencing("source", "target"))
        .unwrap();
    let service = FlowService::new(store.clone());

    let duplicate = service
        .duplicate_flow("daily-sync", "nightly-sync")
        .await
        .unwrap();

    assert_eq!(duplicate.id, "nightly-sync");
    assert_eq!(
        store.load_flow("nightly-sync").unwrap().query_steps,
        flow_referencing("source", "target").query_steps
    );
}

#[tokio::test]
async fn duplicating_a_flow_rejects_an_existing_id_without_overwriting_it() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store
        .save_connection(&profile("target", "credential://db-relay/target"))
        .unwrap();
    store
        .save_flow(&flow_referencing("source", "target"))
        .unwrap();
    let mut existing = flow_referencing("source", "target");
    existing.id = "nightly-sync".into();
    existing.name = "Existing nightly sync".into();
    store.save_flow(&existing).unwrap();
    let service = FlowService::new(store.clone());

    let error = service
        .duplicate_flow("daily-sync", "nightly-sync")
        .await
        .unwrap_err();

    assert_eq!(error.code(), "FLOW_ALREADY_EXISTS");
    assert_eq!(
        store.load_flow("nightly-sync").unwrap().name,
        "Existing nightly sync"
    );
}

#[tokio::test]
async fn repository_port_blocks_disabled_connections_for_a_run() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store.disable_connection("source").unwrap();

    let error = FlowRepository::load_runnable_connection(store.as_ref(), "source")
        .await
        .unwrap_err();

    assert_eq!(error.code(), "CONNECTION_DISABLED");
}

#[test]
fn recovery_events_persist_with_the_run_history() {
    let store = SqliteStore::in_memory().unwrap();
    let mut state = RunState::awaiting_recovery_after_step(1, 3).unwrap();
    state
        .apply_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();

    store.append_run("run-42", &state).unwrap();

    assert_eq!(store.load_run("run-42").unwrap(), Some(state));
}

#[test]
fn run_history_never_persists_an_untrusted_connector_message() {
    let store = SqliteStore::in_memory().unwrap();
    let mut state = RunState::running(TransactionPolicy::CommitSuccesses, 1);
    state
        .record_step_failure(
            0,
            RunError::connector("ORA-01017", "untrusted-history-secret-fixture"),
        )
        .unwrap();

    store.append_run("run-with-error", &state).unwrap();

    assert!(!store
        .dump_for_test()
        .contains("untrusted-history-secret-fixture"));
}

#[test]
fn recovery_events_keep_each_decision_for_the_same_step() {
    let store = SqliteStore::in_memory().unwrap();
    let mut state = RunState::awaiting_recovery_after_step(1, 3).unwrap();
    state.apply_recovery(RecoveryAction::EditAndRetry).unwrap();
    state
        .record_step_failure(1, RunError::connector("ORA-00001", "retry failed"))
        .unwrap();
    state
        .apply_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();

    store.append_run("run-with-two-recoveries", &state).unwrap();

    assert_eq!(
        store.recovery_event_count_for_test("run-with-two-recoveries"),
        2
    );
}

#[test]
fn saving_a_flow_requires_both_referenced_connection_profiles() {
    let store = SqliteStore::in_memory().unwrap();
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();

    let error = store
        .save_flow(&flow_referencing("source", "target"))
        .unwrap_err();

    assert_eq!(error.code(), "SQLITE");
}

#[test]
fn opening_a_legacy_database_upgrades_flow_references_and_recovery_sequences() {
    let path = std::env::temp_dir().join(format!(
        "db-relay-legacy-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "
            CREATE TABLE connection_profiles (
                id TEXT PRIMARY KEY NOT NULL,
                display_name TEXT NOT NULL,
                kind TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                service_name TEXT NOT NULL,
                username TEXT NOT NULL,
                credential_ref TEXT NOT NULL,
                enabled INTEGER NOT NULL
            );
            CREATE TABLE flows (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                source_connection_id TEXT NOT NULL,
                target_connection_id TEXT NOT NULL,
                transaction_policy TEXT NOT NULL,
                version INTEGER NOT NULL
            );
            CREATE TABLE query_steps (
                flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                id TEXT NOT NULL,
                select_sql TEXT NOT NULL,
                upsert_sql TEXT NOT NULL,
                PRIMARY KEY (flow_id, position)
            );
            CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
            CREATE TABLE run_steps (
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                status_json TEXT NOT NULL,
                PRIMARY KEY (run_id, position)
            );
            CREATE TABLE recovery_events (
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                action TEXT NOT NULL,
                PRIMARY KEY (run_id, position)
            );
            INSERT INTO connection_profiles VALUES
                ('source', 'source', 'oracle', 'db.internal', 1521, 'XE', 'relay', 'opaque-source', 1),
                ('target', 'target', 'oracle', 'db.internal', 1521, 'XE', 'relay', 'opaque-target', 1);
            INSERT INTO flows VALUES ('legacy-flow', 'Legacy flow', 'source', 'target', 'commit_successes', 1);
            INSERT INTO runs VALUES ('legacy-run', '{}');
            INSERT INTO recovery_events VALUES ('legacy-run', 0, 'edit_and_retry');
            ",
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();

    let recovery_event_count = store.recovery_event_count_for_test("legacy-run");
    let flow_error_code = store
        .save_flow(&flow_referencing("source", "missing-target"))
        .unwrap_err()
        .code()
        .to_owned();
    let mut repeated_recovery = RunState::awaiting_recovery_after_step(1, 3).unwrap();
    repeated_recovery
        .apply_recovery(RecoveryAction::EditAndRetry)
        .unwrap();
    repeated_recovery
        .record_step_failure(1, RunError::connector("ORA-00001", "retry failed"))
        .unwrap();
    repeated_recovery
        .apply_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();
    store
        .append_run("legacy-upgraded-run", &repeated_recovery)
        .unwrap();
    let upgraded_recovery_event_count = store.recovery_event_count_for_test("legacy-upgraded-run");
    drop(store);
    std::fs::remove_file(path).unwrap();

    assert_eq!(recovery_event_count, 1);
    assert_eq!(flow_error_code, "SQLITE");
    assert_eq!(upgraded_recovery_event_count, 2);
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn settings_service_uses_the_stable_connection_id_for_keyring_storage() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let credentials = Arc::new(RecordingCredentialStore::default());
    let profile = profile("source", "opaque-reference-not-an-account-name");

    SettingsService::new(store, credentials.clone())
        .save_connection(&profile, ResolvedSecret::for_test("fixture"))
        .await
        .unwrap();

    assert_eq!(credentials.stored_connection_ids(), ["source"]);
}
