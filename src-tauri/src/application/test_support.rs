use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::SystemTime,
};

use async_trait::async_trait;

use crate::{
    application::ports::{
        Clock, CredentialStore, DatabaseConnectorFactory, DatabaseSession, PortError,
        ResolvedSecret,
    },
    domain::{ConnectionProfile, DbKind, NamedRow, RowSet},
};

#[derive(Clone)]
pub struct FakeSession {
    state: Arc<Mutex<FakeSessionState>>,
}

struct FakeSessionState {
    rows: RowSet,
    operations: Vec<String>,
    executed_sql: Vec<String>,
    failures_by_sql: BTreeMap<String, PortError>,
}

impl FakeSession {
    pub fn with_rows(rows: RowSet) -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeSessionState {
                rows,
                operations: Vec::new(),
                executed_sql: Vec::new(),
                failures_by_sql: BTreeMap::new(),
            })),
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
        self.state
            .lock()
            .expect("fake session lock poisoned")
            .operations
            .push("begin".into());
        Ok(())
    }

    async fn execute_named(&mut self, sql: &str, batch: &[NamedRow]) -> Result<u64, PortError> {
        let mut state = self.state.lock().expect("fake session lock poisoned");
        state.operations.push(format!("execute:{sql}"));
        state.executed_sql.push(sql.into());

        if let Some(error) = state.failures_by_sql.get(sql) {
            return Err(error.clone());
        }

        Ok(batch.len() as u64)
    }

    async fn commit(&mut self) -> Result<(), PortError> {
        self.state
            .lock()
            .expect("fake session lock poisoned")
            .operations
            .push("commit".into());
        Ok(())
    }

    async fn rollback(&mut self) -> Result<(), PortError> {
        self.state
            .lock()
            .expect("fake session lock poisoned")
            .operations
            .push("rollback".into());
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeConnectorFactory {
    sessions: HashMap<String, FakeSession>,
}

impl FakeConnectorFactory {
    pub fn with_session(connection_id: impl Into<String>, session: FakeSession) -> Self {
        let mut factory = Self::default();
        factory.register(connection_id, session);
        factory
    }

    pub fn register(&mut self, connection_id: impl Into<String>, session: FakeSession) {
        self.sessions.insert(connection_id.into(), session);
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
        self.sessions
            .get(&profile.id)
            .cloned()
            .map(|session| Box::new(session) as Box<dyn DatabaseSession>)
            .ok_or_else(|| PortError::new("FAKE_CONNECTION", "configured fake session not found"))
    }
}

#[derive(Clone, Default)]
pub struct MemoryCredentialStore {
    secrets: Arc<Mutex<BTreeMap<String, String>>>,
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
            .insert(credential_ref.into(), secret.into());
    }
}

#[async_trait]
impl CredentialStore for MemoryCredentialStore {
    async fn store(&self, credential_ref: &str, secret: ResolvedSecret) -> Result<(), PortError> {
        self.secrets
            .lock()
            .expect("memory credential store lock poisoned")
            .insert(credential_ref.into(), secret.into_inner());
        Ok(())
    }

    async fn resolve(&self, credential_ref: &str) -> Result<ResolvedSecret, PortError> {
        self.secrets
            .lock()
            .expect("memory credential store lock poisoned")
            .get(credential_ref)
            .cloned()
            .map(ResolvedSecret::new)
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

pub struct FixedClock(SystemTime);

impl FixedClock {
    pub fn new(now: SystemTime) -> Self {
        Self(now)
    }
}

impl Clock for FixedClock {
    fn now(&self) -> SystemTime {
        self.0
    }
}
