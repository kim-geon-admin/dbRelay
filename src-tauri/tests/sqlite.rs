use std::sync::Arc;

use async_trait::async_trait;
use db_relay::{
    application::{
        flow_service::FlowService,
        ports::{CredentialStore, FlowRepository, PortError, ResolvedSecret},
        settings_service::SettingsService,
    },
    domain::{
        ConnectionProfile, DbKind, Flow, QueryStep, RecoveryAction, RunState, TransactionPolicy,
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
