use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;

use db_relay::{
    application::ports::{
        CredentialStore, DatabaseConnectorFactory, DatabaseSession, PortError, ResolvedSecret,
    },
    domain::{ConnectionProfile, DbKind, NamedRow, RowSet},
};

pub struct FakeSession {
    state: Mutex<FakeSessionState>,
    observer: Option<FakeSessionObserver>,
}

#[derive(Clone)]
struct FakeSessionState {
    rows: RowSet,
    operations: Vec<String>,
    executed_sql: Vec<String>,
    failures_by_sql: BTreeMap<String, PortError>,
}

#[derive(Clone)]
struct FakeSessionTemplate {
    rows: RowSet,
    failures_by_sql: BTreeMap<String, PortError>,
}

#[derive(Clone)]
struct FakeSessionObserver {
    opened_sessions: Arc<Mutex<Vec<Vec<String>>>>,
    open_index: usize,
}

impl FakeSessionObserver {
    fn record(&self, operation: String) {
        self.opened_sessions
            .lock()
            .expect("fake session observer lock poisoned")
            .get_mut(self.open_index)
            .expect("opened fake session should have an observer slot")
            .push(operation);
    }
}

impl FakeSession {
    pub fn with_rows(rows: RowSet) -> Self {
        Self {
            state: Mutex::new(FakeSessionState {
                rows,
                operations: Vec::new(),
                executed_sql: Vec::new(),
                failures_by_sql: BTreeMap::new(),
            }),
            observer: None,
        }
    }

    fn from_template(template: FakeSessionTemplate, observer: FakeSessionObserver) -> Self {
        Self {
            state: Mutex::new(FakeSessionState {
                rows: template.rows,
                operations: Vec::new(),
                executed_sql: Vec::new(),
                failures_by_sql: template.failures_by_sql,
            }),
            observer: Some(observer),
        }
    }

    fn template(&self) -> FakeSessionTemplate {
        let state = self.state.lock().expect("fake session lock poisoned");
        FakeSessionTemplate {
            rows: state.rows.clone(),
            failures_by_sql: state.failures_by_sql.clone(),
        }
    }

    pub fn fail_on_execute_named(&self, sql: impl Into<String>) {
        let sql = sql.into();
        self.fail_on_execute_named_with(sql.clone(), PortError::new("FAKE_EXECUTE", sql));
    }

    pub fn fail_on_execute_named_with(&self, sql: impl Into<String>, error: PortError) {
        self.state
            .lock()
            .expect("fake session lock poisoned")
            .failures_by_sql
            .insert(sql.into(), error);
    }

    pub fn operations(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("fake session lock poisoned")
            .operations
            .clone()
    }

    pub fn executed_sql(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("fake session lock poisoned")
            .executed_sql
            .clone()
    }

    fn record_operation(&self, state: &mut FakeSessionState, operation: String) {
        state.operations.push(operation.clone());
        if let Some(observer) = &self.observer {
            observer.record(operation);
        }
    }
}

#[async_trait]
impl DatabaseSession for FakeSession {
    async fn query(&mut self, _sql: &str) -> Result<RowSet, PortError> {
        Ok(self
            .state
            .lock()
            .expect("fake session lock poisoned")
            .rows
            .clone())
    }

    async fn begin(&mut self) -> Result<(), PortError> {
        let mut state = self.state.lock().expect("fake session lock poisoned");
        self.record_operation(&mut state, "begin".into());
        Ok(())
    }

    async fn execute_named(&mut self, sql: &str, batch: &[NamedRow]) -> Result<u64, PortError> {
        let mut state = self.state.lock().expect("fake session lock poisoned");
        self.record_operation(&mut state, format!("execute:{sql}"));
        state.executed_sql.push(sql.into());

        if let Some(error) = state.failures_by_sql.get(sql) {
            return Err(error.clone());
        }

        Ok(batch.len() as u64)
    }

    async fn commit(&mut self) -> Result<(), PortError> {
        let mut state = self.state.lock().expect("fake session lock poisoned");
        self.record_operation(&mut state, "commit".into());
        Ok(())
    }

    async fn rollback(&mut self) -> Result<(), PortError> {
        let mut state = self.state.lock().expect("fake session lock poisoned");
        self.record_operation(&mut state, "rollback".into());
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeConnectorFactory {
    session_templates: HashMap<String, FakeSessionTemplate>,
    observers: HashMap<String, Arc<Mutex<Vec<Vec<String>>>>>,
}

impl FakeConnectorFactory {
    pub fn with_session(connection_id: impl Into<String>, session: FakeSession) -> Self {
        let mut factory = Self::default();
        factory.register(connection_id, session);
        factory
    }

    pub fn register(&mut self, connection_id: impl Into<String>, session: FakeSession) {
        let connection_id = connection_id.into();
        self.session_templates
            .insert(connection_id.clone(), session.template());
        self.observers
            .insert(connection_id, Arc::new(Mutex::new(Vec::new())));
    }

    pub fn operations_for_open(&self, connection_id: &str, open_index: usize) -> Vec<String> {
        self.observers
            .get(connection_id)
            .and_then(|observer| {
                observer
                    .lock()
                    .expect("fake session observer lock poisoned")
                    .get(open_index)
                    .cloned()
            })
            .unwrap_or_default()
    }
}

#[async_trait]
impl DatabaseConnectorFactory for FakeConnectorFactory {
    fn kind(&self) -> DbKind {
        DbKind::Oracle
    }

    async fn open(
        &self,
        profile: &ConnectionProfile,
        _secret: &ResolvedSecret,
    ) -> Result<Box<dyn DatabaseSession>, PortError> {
        let template = self.session_templates.get(&profile.id).ok_or_else(|| {
            PortError::new("FAKE_CONNECTION", "configured fake session not found")
        })?;
        let opened_sessions = self.observers.get(&profile.id).ok_or_else(|| {
            PortError::new(
                "FAKE_CONNECTION",
                "configured fake session observer not found",
            )
        })?;
        let open_index = {
            let mut opened_sessions = opened_sessions
                .lock()
                .expect("fake session observer lock poisoned");
            opened_sessions.push(Vec::new());
            opened_sessions.len() - 1
        };

        Ok(Box::new(FakeSession::from_template(
            template.clone(),
            FakeSessionObserver {
                opened_sessions: Arc::clone(opened_sessions),
                open_index,
            },
        )))
    }
}

#[derive(Clone, Default)]
pub struct MemoryCredentialStore {
    secrets: Arc<Mutex<BTreeMap<String, ResolvedSecret>>>,
}

impl MemoryCredentialStore {
    pub fn with_secret(credential_ref: impl Into<String>, secret: impl Into<String>) -> Self {
        let store = Self::default();
        store.insert(credential_ref, secret);
        store
    }

    pub fn insert(&self, credential_ref: impl Into<String>, secret: impl Into<String>) {
        self.secrets
            .lock()
            .expect("memory credential store lock poisoned")
            .insert(credential_ref.into(), ResolvedSecret::new(secret));
    }
}

#[async_trait]
impl CredentialStore for MemoryCredentialStore {
    async fn store(&self, credential_ref: &str, secret: ResolvedSecret) -> Result<(), PortError> {
        self.secrets
            .lock()
            .expect("memory credential store lock poisoned")
            .insert(credential_ref.into(), secret);
        Ok(())
    }

    async fn resolve(&self, credential_ref: &str) -> Result<ResolvedSecret, PortError> {
        self.secrets
            .lock()
            .expect("memory credential store lock poisoned")
            .get(credential_ref)
            .cloned()
            .ok_or_else(|| PortError::new("CREDENTIAL_NOT_FOUND", "credential reference not found"))
    }

    async fn delete(&self, credential_ref: &str) -> Result<(), PortError> {
        self.secrets
            .lock()
            .expect("memory credential store lock poisoned")
            .remove(credential_ref);
        Ok(())
    }
}
