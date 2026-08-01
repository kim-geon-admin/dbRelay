use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(feature = "test-support")]
use std::sync::Mutex;

use async_trait::async_trait;
use db_relay::{
    application::{
        flow_service::FlowService,
        ports::{CredentialStore, FlowRepository, PortError, ResolvedSecret, RunBinding},
        settings_service::SettingsService,
    },
    domain::{
        ConnectionProfile, CredentialStorage, DbKind, Flow, QueryStep, RecoveryAction, RunError,
        RunEvent, RunState, RunStatus, TransactionPolicy,
    },
    infrastructure::sqlite::SqliteStore,
};

#[cfg(feature = "test-support")]
use db_relay::{
    application::ports::{DatabaseConnectorFactory, DatabaseSession},
    domain::{NamedRow, RowSet},
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
    deleted_connection_ids: Mutex<Vec<String>>,
    secrets: Mutex<std::collections::BTreeMap<String, ResolvedSecret>>,
}

#[cfg(feature = "test-support")]
impl RecordingCredentialStore {
    fn stored_connection_ids(&self) -> Vec<String> {
        self.stored_connection_ids
            .lock()
            .expect("recording credential store lock poisoned")
            .clone()
    }

    fn deleted_connection_ids(&self) -> Vec<String> {
        self.deleted_connection_ids
            .lock()
            .expect("recording credential store lock poisoned")
            .clone()
    }
}

#[cfg(feature = "test-support")]
#[async_trait]
impl CredentialStore for RecordingCredentialStore {
    async fn store(&self, connection_id: &str, secret: ResolvedSecret) -> Result<(), PortError> {
        self.stored_connection_ids
            .lock()
            .expect("recording credential store lock poisoned")
            .push(connection_id.into());
        self.secrets
            .lock()
            .expect("recording credential store lock poisoned")
            .insert(connection_id.into(), secret);
        Ok(())
    }

    async fn resolve(&self, connection_id: &str) -> Result<ResolvedSecret, PortError> {
        self.secrets
            .lock()
            .expect("recording credential store lock poisoned")
            .get(connection_id)
            .cloned()
            .ok_or_else(|| PortError::new("CREDENTIAL_NOT_FOUND", "credential reference not found"))
    }

    async fn delete(&self, connection_id: &str) -> Result<(), PortError> {
        self.deleted_connection_ids
            .lock()
            .expect("recording credential store lock poisoned")
            .push(connection_id.into());
        self.secrets
            .lock()
            .expect("recording credential store lock poisoned")
            .remove(connection_id);
        Ok(())
    }
}

#[cfg(feature = "test-support")]
struct MetadataFailureRepository;

#[cfg(feature = "test-support")]
#[async_trait]
impl FlowRepository for MetadataFailureRepository {
    async fn load_flow(&self, _flow_id: &str) -> Result<Option<Flow>, PortError> {
        unreachable!()
    }
    async fn save_flow(&self, _flow: &Flow) -> Result<(), PortError> {
        unreachable!()
    }
    async fn list_flows(&self) -> Result<Vec<Flow>, PortError> {
        unreachable!()
    }
    async fn load_connection(
        &self,
        _connection_id: &str,
    ) -> Result<Option<ConnectionProfile>, PortError> {
        unreachable!()
    }
    async fn save_connection(&self, _profile: &ConnectionProfile) -> Result<(), PortError> {
        Err(PortError::new("SQLITE", "metadata persistence failed"))
    }
    async fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError> {
        unreachable!()
    }
    async fn update_connection(&self, _profile: &ConnectionProfile) -> Result<(), PortError> {
        unreachable!()
    }
    async fn disable_connection(&self, _connection_id: &str) -> Result<(), PortError> {
        unreachable!()
    }
    async fn delete_connection(&self, _connection_id: &str) -> Result<(), PortError> {
        unreachable!()
    }
}

#[cfg(feature = "test-support")]
#[derive(Default)]
struct LegacyCredentialStore {
    resolved_account_names: Mutex<Vec<String>>,
    stored_account_names: Mutex<Vec<String>>,
}

#[cfg(feature = "test-support")]
impl LegacyCredentialStore {
    fn resolved_account_names(&self) -> Vec<String> {
        self.resolved_account_names
            .lock()
            .expect("legacy credential store lock poisoned")
            .clone()
    }

    fn stored_account_names(&self) -> Vec<String> {
        self.stored_account_names
            .lock()
            .expect("legacy credential store lock poisoned")
            .clone()
    }
}

#[cfg(feature = "test-support")]
#[async_trait]
impl CredentialStore for LegacyCredentialStore {
    async fn store(&self, connection_id: &str, _secret: ResolvedSecret) -> Result<(), PortError> {
        self.stored_account_names
            .lock()
            .expect("legacy credential store lock poisoned")
            .push(connection_id.into());
        Ok(())
    }

    async fn resolve(&self, account_name: &str) -> Result<ResolvedSecret, PortError> {
        self.resolved_account_names
            .lock()
            .expect("legacy credential store lock poisoned")
            .push(account_name.into());
        if account_name == "legacy-opaque-reference" {
            Ok(ResolvedSecret::for_test("fixture"))
        } else {
            Err(PortError::new(
                "CREDENTIAL_NOT_FOUND",
                "credential not found",
            ))
        }
    }

    async fn delete(&self, _connection_id: &str) -> Result<(), PortError> {
        Ok(())
    }
}

#[cfg(feature = "test-support")]
struct AcceptingConnector;

#[cfg(feature = "test-support")]
#[async_trait]
impl DatabaseConnectorFactory for AcceptingConnector {
    fn kind(&self) -> DbKind {
        DbKind::Oracle
    }

    async fn open(
        &self,
        _profile: &ConnectionProfile,
        _secret: &ResolvedSecret,
    ) -> Result<Box<dyn DatabaseSession>, PortError> {
        Ok(Box::new(AcceptingSession))
    }
}

#[cfg(feature = "test-support")]
struct AcceptingSession;

#[cfg(feature = "test-support")]
#[async_trait]
impl DatabaseSession for AcceptingSession {
    async fn query(&mut self, _sql: &str) -> Result<RowSet, PortError> {
        Ok(RowSet::default())
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

fn profile(id: &str, credential_ref: &str) -> ConnectionProfile {
    ConnectionProfile {
        id: id.into(),
        display_name: format!("{id} database"),
        kind: DbKind::Oracle,
        host: "db.internal".into(),
        port: 1521,
        sid: "XE".into(),
        username: "relay".into(),
        credential_ref: credential_ref.into(),
        credential_storage: CredentialStorage::Keyring,
        plaintext_password: None,
        enabled: true,
        source_read_only: true,
    }
}

#[test]
fn legacy_profile_json_with_service_name_deserializes_as_sid() {
    let profile: ConnectionProfile = serde_json::from_str(
        r#"{"id":"legacy","display_name":"Legacy","kind":"oracle","host":"db.example","port":1521,"service_name":"XE","username":"relay","credential_ref":"","enabled":true}"#,
    )
    .unwrap();

    assert_eq!(profile.sid, "XE");
}

#[test]
fn legacy_sqlite_service_name_column_loads_as_sid() {
    let path = std::env::temp_dir().join(format!(
        "db-relay-legacy-sid-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            r#"
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
            INSERT INTO connection_profiles VALUES
                ('legacy', 'Legacy', 'oracle', 'db.example', 1521, 'XE', 'relay', '', 1);
            "#,
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();
    let loaded = store.load_connection("legacy").unwrap();
    drop(store);
    std::fs::remove_file(path).unwrap();

    assert_eq!(loaded.sid, "XE");
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
fn listing_connections_returns_the_source_read_only_attestation() {
    let store = SqliteStore::in_memory().unwrap();
    let mut source = profile("source", "credential://db-relay/source");
    source.source_read_only = false;
    store.save_connection(&source).unwrap();

    let connections = store.list_connections().unwrap();

    assert_eq!(connections.len(), 1);
    assert!(!connections[0].source_read_only);
}

#[test]
fn plaintext_connection_round_trips_its_explicit_password() {
    let store = SqliteStore::in_memory().unwrap();
    let profile = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("visible-password".into()),
        ..profile("source", "unused")
    };
    store.save_connection(&profile).unwrap();

    let loaded = store.load_connection("source").unwrap();

    assert_eq!(loaded.credential_storage, CredentialStorage::Plaintext);
    assert_eq!(
        loaded.plaintext_password.as_deref(),
        Some("visible-password")
    );
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn testing_a_plaintext_connection_does_not_require_a_keyring_entry() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let profile = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("visible-password".into()),
        ..profile("source", "unused")
    };
    store.save_connection(&profile).unwrap();

    SettingsService::new(store, Arc::new(RecordingCredentialStore::default()))
        .test_connection("source", &AcceptingConnector)
        .await
        .unwrap();
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn saving_a_plaintext_connection_does_not_write_to_the_keyring() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let credentials = Arc::new(RecordingCredentialStore::default());
    let profile = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("visible-password".into()),
        ..profile("source", "unused")
    };

    SettingsService::new(store.clone(), credentials.clone())
        .save_connection(&profile, ResolvedSecret::for_test("visible-password"))
        .await
        .unwrap();

    assert!(credentials.stored_connection_ids().is_empty());
    assert_eq!(
        store
            .load_connection("source")
            .unwrap()
            .plaintext_password
            .as_deref(),
        Some("visible-password")
    );
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn keyring_credentials_are_projected_as_same_length_asterisks() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let credentials = Arc::new(RecordingCredentialStore::default());
    let service = SettingsService::new(store.clone(), credentials);
    let profile = profile("source", "unused");

    service
        .save_connection(&profile, ResolvedSecret::for_test("eight123"))
        .await
        .unwrap();
    let saved = store.load_connection("source").unwrap();

    assert_eq!(service.password_mask(&saved).await, "********");
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn plaintext_credentials_are_projected_as_same_length_asterisks() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let profile = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("secret123".into()),
        ..profile("source", "unused")
    };
    let service = SettingsService::new(store, Arc::new(RecordingCredentialStore::default()));

    assert_eq!(service.password_mask(&profile).await, "*********");
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn unavailable_keyring_credentials_still_have_a_visible_password_mask() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let profile = profile("source", "missing-keyring-entry");
    store.save_connection(&profile).unwrap();

    let service = SettingsService::new(store, Arc::new(RecordingCredentialStore::default()));

    assert_eq!(service.password_mask(&profile).await, "********");
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

#[test]
fn saving_a_stale_flow_version_is_rejected_without_overwriting_the_current_flow() {
    let store = SqliteStore::in_memory().unwrap();
    store
        .save_connection(&profile("source", "credential://db-relay/source"))
        .unwrap();
    store
        .save_connection(&profile("target", "credential://db-relay/target"))
        .unwrap();
    let original = flow_referencing("source", "target");
    store.save_flow(&original).unwrap();
    let current = store.load_flow("daily-sync").unwrap();

    let mut updated = current.clone();
    updated.name = "Current update".into();
    store.save_flow(&updated).unwrap();

    let mut stale = current;
    stale.name = "Stale update".into();
    let error = store.save_flow(&stale).unwrap_err();

    assert_eq!(error.code(), "FLOW_VERSION_CONFLICT");
    assert_eq!(
        store.load_flow("daily-sync").unwrap().name,
        "Current update"
    );
    assert_eq!(store.load_flow("daily-sync").unwrap().version, 2);
}

#[test]
fn saving_a_client_preincremented_flow_version_is_rejected_without_overwriting() {
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

    let mut stale = store.load_flow("daily-sync").unwrap();
    stale.version = 2;
    stale.name = "Stale update".into();
    let error = store.save_flow(&stale).unwrap_err();

    assert_eq!(error.code(), "FLOW_VERSION_CONFLICT");
    let saved = store.load_flow("daily-sync").unwrap();
    assert_eq!(saved.name, "Daily sync");
    assert_eq!(saved.version, 1);
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

#[cfg(feature = "test-support")]
#[tokio::test]
async fn updating_legacy_keyring_metadata_without_a_password_keeps_keyring_storage() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let existing = profile("source", "credential://db-relay/original");
    store.save_connection(&existing).unwrap();
    let requested = ConnectionProfile {
        display_name: "Renamed source".into(),
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: None,
        ..existing.clone()
    };

    SettingsService::new(store.clone(), Arc::new(RecordingCredentialStore::default()))
        .update_connection(&requested, None)
        .await
        .unwrap();

    let saved = store.load_connection("source").unwrap();
    assert_eq!(saved.display_name, "Renamed source");
    assert_eq!(saved.credential_storage, CredentialStorage::Keyring);
    assert_eq!(saved.credential_ref, existing.credential_ref);
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn replacing_a_legacy_keyring_password_keeps_the_keyring_entry() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let existing = profile("source", "credential://db-relay/original");
    store.save_connection(&existing).unwrap();
    let requested = ConnectionProfile {
        credential_storage: CredentialStorage::Plaintext,
        plaintext_password: Some("new-plaintext-password".into()),
        ..existing.clone()
    };
    let credentials = Arc::new(RecordingCredentialStore::default());

    SettingsService::new(store.clone(), credentials.clone())
        .update_connection(
            &requested,
            Some(ResolvedSecret::for_test("new-plaintext-password")),
        )
        .await
        .unwrap();

    let saved = store.load_connection("source").unwrap();
    assert_eq!(saved.credential_storage, CredentialStorage::Plaintext);
    assert_eq!(
        saved.plaintext_password.as_deref(),
        Some("new-plaintext-password")
    );
    assert!(credentials.deleted_connection_ids().is_empty());
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
fn initial_run_history_insert_rejects_a_collision_without_overwriting_the_first_run() {
    let store = SqliteStore::in_memory().unwrap();
    let first = RunState::running(TransactionPolicy::AllOrNothing, 1);
    let second = RunState::from_history(
        TransactionPolicy::AllOrNothing,
        RunStatus::Failed,
        vec![db_relay::domain::StepStatus::Failed],
        vec![],
    );

    store.create_run("opaque-run-id", &first).unwrap();
    let error = store.create_run("opaque-run-id", &second).unwrap_err();

    assert_eq!(error.code(), "RUN_ID_COLLISION");
    assert_eq!(store.load_run("opaque-run-id").unwrap(), Some(first));
}

#[test]
fn reopening_releases_an_interrupted_recovery_reservation() {
    // Would fail if a crash after reserving Skip/Edit left a saved run in a
    // state that ordinary recovery cannot reopen.
    let path = std::env::temp_dir().join(format!(
        "db-relay-pending-recovery-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store = SqliteStore::open(&path).unwrap();
    let source = profile("source", "credential://db-relay/source");
    let target = profile("target", "credential://db-relay/target");
    let flow = flow_referencing("source", "target");
    store.save_connection(&source).unwrap();
    store.save_connection(&target).unwrap();
    store.save_flow(&flow).unwrap();
    let binding = RunBinding {
        flow,
        source_profile: source,
        target_profile: target,
    };
    let mut state = RunState::awaiting_recovery_after_step(1, 2).unwrap();
    state
        .reserve_recovery(RecoveryAction::SkipAndContinue)
        .unwrap();
    store
        .append_bound_run("reserved-run", &state, &binding)
        .unwrap();
    drop(store);

    let reopened = SqliteStore::open(&path).unwrap();
    let loaded = reopened.load_run("reserved-run").unwrap().unwrap();
    drop(reopened);
    std::fs::remove_file(path).unwrap();

    assert_eq!(
        loaded.status(),
        RunStatus::AwaitingRecovery { failed_step: 1 }
    );
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
fn run_history_never_persists_an_untrusted_connector_code() {
    let store = SqliteStore::in_memory().unwrap();
    let mut state = RunState::running(TransactionPolicy::CommitSuccesses, 1);
    state
        .record_step_failure(
            0,
            RunError::connector("untrusted-history-code-secret-fixture", "connection failed"),
        )
        .unwrap();

    store.append_run("run-with-untrusted-code", &state).unwrap();

    assert!(!store
        .dump_for_test()
        .contains("untrusted-history-code-secret-fixture"));
}

#[test]
fn bound_run_history_excludes_sql_and_connection_credentials() {
    // Would fail if recovery configuration were serialized directly into the
    // run-history document instead of a safe audit projection.
    let store = SqliteStore::in_memory().unwrap();
    let source = profile("source", "credential://history-source-secret");
    let target = profile("target", "credential://history-target-secret");
    store.save_connection(&source).unwrap();
    store.save_connection(&target).unwrap();
    let flow = flow_referencing("source", "target");
    store.save_flow(&flow).unwrap();
    let binding = RunBinding {
        flow: flow.clone(),
        source_profile: source,
        target_profile: target,
    };

    store
        .create_bound_run(
            "safe-history-run",
            &RunState::running(TransactionPolicy::AllOrNothing, 1),
            &binding,
        )
        .unwrap();

    let dump = store.run_history_json_for_test("safe-history-run").unwrap();

    assert!(!dump.contains(&flow.query_steps[0].select_sql));
    assert!(!dump.contains(&flow.query_steps[0].upsert_sql));
    assert!(!dump.contains("history-source-secret"));
    assert!(!dump.contains("history-target-secret"));
}

#[test]
fn run_history_projects_safe_flow_metadata_timing_and_connector_detail() {
    // Would fail if the history list discarded safe audit fields or replaced a
    // sanitized Oracle diagnostic with a generic message.
    let store = SqliteStore::in_memory().unwrap();
    let source = profile("source", "credential://source");
    let target = profile("target", "credential://target");
    store.save_connection(&source).unwrap();
    store.save_connection(&target).unwrap();
    let flow = flow_referencing("source", "target");
    store.save_flow(&flow).unwrap();
    let binding = RunBinding {
        flow: flow.clone(),
        source_profile: source,
        target_profile: target,
    };
    let mut state = RunState::running(TransactionPolicy::CommitSuccesses, 1);
    state
        .record_step_failure(
            0,
            RunError::connector_with_retryable("ORA-00001", "unique constraint violated", true),
        )
        .unwrap();

    store
        .create_bound_run("auditable-run", &state, &binding)
        .unwrap();
    store
        .append_bound_run("auditable-run", &state, &binding)
        .unwrap();
    let entry = store.list_runs().unwrap().pop().unwrap();

    assert_eq!(entry.flow_id.as_deref(), Some("daily-sync"));
    assert_eq!(entry.flow_version, Some(3));
    assert!(entry.started_at_ms > 0);
    assert!(entry.ended_at_ms.is_none());
    assert!(matches!(
        entry.state.events(),
        [RunEvent::StepFailed { error, .. }]
            if error.history_code() == "ORA-00001"
                && error.connector_message() == Some("unique constraint violated")
                && error.retryable()
    ));
}

#[test]
fn preflight_history_keeps_flow_identity_without_serializing_a_recovery_binding() {
    let store = SqliteStore::in_memory().unwrap();
    let flow = flow_referencing("missing-source", "missing-target");
    let state = RunState::from_history(
        TransactionPolicy::AllOrNothing,
        RunStatus::Failed,
        vec![db_relay::domain::StepStatus::Failed],
        vec![],
    );

    store
        .create_run_for_flow("preflight-flow-audit", &state, &flow)
        .unwrap();
    let entry = store.list_runs().unwrap().pop().unwrap();
    let json = store
        .run_history_json_for_test("preflight-flow-audit")
        .unwrap();

    assert_eq!(entry.flow_id.as_deref(), Some("daily-sync"));
    assert_eq!(entry.flow_version, Some(3));
    assert!(entry.ended_at_ms.is_some());
    assert!(!json.contains("select_sql"));
    assert!(!json.contains("credential_ref"));
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
            r#"
            PRAGMA foreign_keys = OFF;
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
            INSERT INTO flows VALUES ('orphan-flow', 'Orphan flow', 'source', 'missing-target', 'commit_successes', 1);
            INSERT INTO runs VALUES ('legacy-run', '{}');
            INSERT INTO run_steps VALUES ('missing-run', 0, '"not_run"');
            INSERT INTO recovery_events VALUES ('legacy-run', 0, 'edit_and_retry');
            INSERT INTO recovery_events VALUES ('missing-run', 0, 'stop');
            "#,
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();

    let recovery_event_count = store.recovery_event_count_for_test("legacy-run");
    let orphan_recovery_event_count = store.recovery_event_count_for_test("missing-run");
    let migrated_flow_ids = store
        .list_flows()
        .unwrap()
        .into_iter()
        .map(|flow| flow.id)
        .collect::<Vec<_>>();
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
    assert_eq!(orphan_recovery_event_count, 0);
    assert_eq!(migrated_flow_ids, ["legacy-flow"]);
    assert_eq!(flow_error_code, "SQLITE");
    assert_eq!(upgraded_recovery_event_count, 2);
}

#[test]
fn opening_a_legacy_failed_run_rewrites_it_as_safe_readable_history() {
    let path = std::env::temp_dir().join(format!(
        "db-relay-legacy-history-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            r#"
            CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
            INSERT INTO runs VALUES (
                'legacy-failed-run',
                '{"policy":"commit_successes","status":{"awaiting_recovery":{"failed_step":0}},"steps":[{"status":"failed"}],"events":[{"type":"step_failed","step":0,"error":{"type":"connector","detail":{"code":"ORA-01017","message":"legacy-raw-history-secret-fixture"}}}]}'
            );
            "#,
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();
    let loaded = store.load_run("legacy-failed-run").unwrap();
    let dump = store.dump_for_test();
    drop(store);
    std::fs::remove_file(path).unwrap();

    assert!(loaded.is_some());
    assert!(!dump.contains("legacy-raw-history-secret-fixture"));
}

#[test]
fn opening_a_legacy_stored_run_resanitizes_an_arbitrary_connector_code() {
    let path = std::env::temp_dir().join(format!(
        "db-relay-legacy-stored-run-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            r#"
            CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
            INSERT INTO runs VALUES (
                'legacy-stored-run',
                '{"policy":"commit_successes","status":{"awaiting_recovery":{"failed_step":0}},"steps":["failed"],"events":[{"type":"step_failed","step":0,"error_code":"legacy-stored-code-secret-fixture"}]}'
            );
            "#,
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();
    let loaded = store.load_run("legacy-stored-run").unwrap();
    let dump = store.dump_for_test();
    drop(store);
    std::fs::remove_file(path).unwrap();

    assert!(loaded.is_some());
    assert!(!dump.contains("legacy-stored-code-secret-fixture"));
}

#[test]
fn normalizing_legacy_commit_pending_marks_the_indoubt_run_as_ended() {
    let path = std::env::temp_dir().join(format!(
        "db-relay-legacy-commit-pending-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            r#"
            CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
            INSERT INTO runs VALUES (
                'legacy-commit-pending',
                '{"policy":"all_or_nothing","status":{"commit_pending":{"step":0}},"steps":[{"status":{"succeeded":{"affected_rows":1}}}],"events":[]}'
            );
            "#,
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();
    let entry = store.list_runs().unwrap().pop().unwrap();
    drop(store);
    std::fs::remove_file(path).unwrap();

    assert!(matches!(entry.state.status(), RunStatus::InDoubt { .. }));
    assert!(entry.ended_at_ms.is_some());
}

#[test]
fn opening_a_legacy_bound_run_rewrites_its_raw_configuration_as_safe_binding() {
    let path = std::env::temp_dir().join(format!(
        "db-relay-legacy-binding-{}-{}.sqlite",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let legacy = rusqlite::Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            r#"
            CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL);
            INSERT INTO runs VALUES ('legacy-bound-run',
              '{"policy":"all_or_nothing","status":"completed","steps":[],"events":[],"binding":{"flow":{"id":"legacy-flow","name":"Legacy","source_connection_id":"source","target_connection_id":"target","query_steps":[{"id":"step","select_sql":"SELECT legacy_history_sql_secret FROM t","upsert_sql":"MERGE legacy_history_sql_secret"}],"transaction_policy":"all_or_nothing","version":7},"source_profile":{"id":"source","display_name":"source","kind":"oracle","host":"db.example","port":1521,"service_name":"XE","username":"relay","credential_ref":"credential://legacy-history-secret","enabled":true},"target_profile":{"id":"target","display_name":"target","kind":"oracle","host":"db.example","port":1521,"service_name":"XE","username":"relay","credential_ref":"credential://legacy-history-secret","enabled":true}}}');
            "#,
        )
        .unwrap();
    drop(legacy);

    let store = SqliteStore::open(&path).unwrap();
    let state_json = store.run_history_json_for_test("legacy-bound-run").unwrap();
    let history = store.list_runs().unwrap();
    drop(store);
    std::fs::remove_file(path).unwrap();

    assert!(state_json.contains("legacy-flow"));
    assert!(!state_json.contains("legacy_history_sql_secret"));
    assert!(!state_json.contains("legacy-history-secret"));
    assert_eq!(history[0].flow_id.as_deref(), Some("legacy-flow"));
    assert_eq!(history[0].flow_version, Some(7));
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn settings_service_uses_a_versioned_keyring_account_for_new_metadata() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let credentials = Arc::new(RecordingCredentialStore::default());
    let profile = profile("source", "opaque-reference-not-an-account-name");

    SettingsService::new(store.clone(), credentials.clone())
        .save_connection(&profile, ResolvedSecret::for_test("fixture"))
        .await
        .unwrap();

    let persisted = store.load_connection("source").unwrap();
    assert!(persisted.credential_ref.starts_with("source:"));
    assert_eq!(
        credentials.stored_connection_ids(),
        [persisted.credential_ref]
    );
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn replacement_credential_is_persisted_before_the_old_key_is_deleted() {
    // Would fail if SQLite silently restored the old credential_ref after the
    // replacement key was stored, leaving the profile unable to resolve the
    // supplied replacement.
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let credentials = Arc::new(RecordingCredentialStore::default());
    let service = SettingsService::new(store.clone(), credentials.clone());
    let initial_profile = profile("source", "legacy-ref");

    service
        .save_connection(&initial_profile, ResolvedSecret::for_test("old-secret"))
        .await
        .unwrap();
    let old_ref = store.load_connection("source").unwrap().credential_ref;
    let mut update = profile("source", "ignored-by-service");
    update.display_name = "Updated source".into();

    service
        .update_connection(
            &update,
            Some(ResolvedSecret::for_test("replacement-secret")),
        )
        .await
        .unwrap();

    let persisted = store.load_connection("source").unwrap();
    assert_ne!(persisted.credential_ref, old_ref);
    assert!(credentials.resolve(&persisted.credential_ref).await.is_ok());
    assert_eq!(credentials.deleted_connection_ids(), vec![old_ref]);
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn settings_service_resolves_a_legacy_credential_reference_without_losing_it() {
    let store = Arc::new(SqliteStore::in_memory().unwrap());
    let credentials = Arc::new(LegacyCredentialStore::default());
    let profile = profile("source", "legacy-opaque-reference");
    store.save_connection(&profile).unwrap();
    let factory = AcceptingConnector;

    SettingsService::new(store, credentials.clone())
        .test_connection("source", &factory)
        .await
        .unwrap();

    assert_eq!(
        credentials.resolved_account_names(),
        ["legacy-opaque-reference"]
    );
    assert!(credentials.stored_account_names().is_empty());
}

#[cfg(feature = "test-support")]
#[tokio::test]
async fn failed_connection_metadata_persistence_deletes_the_new_keyring_account() {
    let credentials = Arc::new(RecordingCredentialStore::default());
    let error = SettingsService::new(Arc::new(MetadataFailureRepository), credentials.clone())
        .save_connection(
            &profile("source", "legacy-opaque-reference"),
            ResolvedSecret::for_test("fixture"),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code(), "SQLITE");
    let stored = credentials.stored_connection_ids();
    assert_eq!(stored.len(), 1);
    assert!(stored[0].starts_with("source:"));
    assert_eq!(credentials.deleted_connection_ids(), stored);
}
