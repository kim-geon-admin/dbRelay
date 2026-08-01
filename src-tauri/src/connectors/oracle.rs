use std::sync::Arc;

use async_trait::async_trait;
use oracle_rs::{BatchBinds, Config, Connection};

use crate::{
    application::ports::{DatabaseConnectorFactory, DatabaseSession, PortError, ResolvedSecret},
    domain::{extract_named_binds, ConnectionProfile, DbKind, NamedRow, Row, RowSet, Value},
};

/// Oracle implementation of the application's connector ports.
///
/// `oracle-rs` is contained behind a small driver boundary so application
/// services and the migration runner remain independent from its types.
#[derive(Clone)]
pub struct OracleConnector {
    driver: Arc<dyn OracleDriver>,
}

impl Default for OracleConnector {
    fn default() -> Self {
        Self {
            driver: Arc::new(OracleRsDriver),
        }
    }
}

impl OracleConnector {
    /// Test-only connector implementation that does not open a network socket.
    #[doc(hidden)]
    pub fn for_test() -> Self {
        Self {
            driver: Arc::new(TestOracleDriver::default()),
        }
    }

    /// Test-only connector implementation that produces a mapped driver error.
    #[doc(hidden)]
    pub fn for_test_with_failure(
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            driver: Arc::new(TestOracleDriver {
                failure: Some(DriverError {
                    code: code.into(),
                    message: message.into(),
                    retryable,
                }),
            }),
        }
    }

    /// Opens a connector test session without exposing a raw secret constructor
    /// through the application ports.
    #[doc(hidden)]
    pub async fn open_for_test(
        &self,
        profile: &ConnectionProfile,
        password: &str,
    ) -> Result<Box<dyn DatabaseSession>, PortError> {
        self.open_with_password(profile, password).await
    }

    async fn open_with_password(
        &self,
        profile: &ConnectionProfile,
        password: &str,
    ) -> Result<Box<dyn DatabaseSession>, PortError> {
        if profile.kind != DbKind::Oracle {
            return Err(PortError::new(
                "CONNECTOR_KIND_MISMATCH",
                "connection profile is not an Oracle profile",
            ));
        }

        let session = self
            .driver
            .open(DriverConnectionInfo {
                host: &profile.host,
                port: profile.port,
                service_name: &profile.service_name,
                username: &profile.username,
                password,
            })
            .await
            .map_err(|error| port_error_with_credentials(error, [password]))?;
        Ok(Box::new(OracleSession {
            session,
            credential_values: vec![password.into()],
        }))
    }
}

#[async_trait]
impl DatabaseConnectorFactory for OracleConnector {
    fn kind(&self) -> DbKind {
        DbKind::Oracle
    }

    async fn open(
        &self,
        profile: &ConnectionProfile,
        secret: &ResolvedSecret,
    ) -> Result<Box<dyn DatabaseSession>, PortError> {
        self.open_with_password(profile, secret.expose()).await
    }
}

struct OracleSession {
    session: Box<dyn OracleDriverSession>,
    credential_values: Vec<String>,
}

impl OracleSession {
    fn port_error(&self, error: DriverError) -> PortError {
        port_error_with_credentials(error, self.credential_values.iter().cloned())
    }
}

#[async_trait]
impl DatabaseSession for OracleSession {
    async fn query(&mut self, sql: &str) -> Result<RowSet, PortError> {
        self.session
            .query(sql)
            .await
            .map_err(|error| self.port_error(error))
    }

    async fn begin(&mut self) -> Result<(), PortError> {
        self.session
            .begin()
            .await
            .map_err(|error| self.port_error(error))
    }

    async fn execute_named(&mut self, sql: &str, batch: &[NamedRow]) -> Result<u64, PortError> {
        if batch.is_empty() {
            return Ok(0);
        }

        let bind_names = extract_named_binds(sql)
            .map_err(|_| PortError::new("BIND_MAPPING", "unable to read named bind parameters"))?;
        let batch = batch
            .iter()
            .map(|row| bind_row(row, &bind_names))
            .collect::<Result<Vec<_>, _>>()?;

        self.session
            .execute_prepared(sql, &bind_names, &batch)
            .await
            .map_err(|error| self.port_error(error))
    }

    async fn commit(&mut self) -> Result<(), PortError> {
        self.session
            .commit()
            .await
            .map_err(|error| self.port_error(error))
    }

    async fn rollback(&mut self) -> Result<(), PortError> {
        self.session
            .rollback()
            .await
            .map_err(|error| self.port_error(error))
    }
}

fn bind_row(row: &NamedRow, bind_names: &[String]) -> Result<Vec<DriverValue>, PortError> {
    bind_names
        .iter()
        .map(|bind_name| {
            row.iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(bind_name))
                .map(|(_, value)| DriverValue::from(value))
                .ok_or_else(|| {
                    PortError::new(
                        "BIND_MAPPING",
                        format!("missing named bind parameter {bind_name}"),
                    )
                })
        })
        .collect()
}

#[derive(Clone, Debug)]
enum DriverValue {
    Null,
    Text(String),
    Int(i64),
    Decimal(String),
    Bool(bool),
    Timestamp(String),
    Bytes(Vec<u8>),
}

impl From<&Value> for DriverValue {
    fn from(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Text(value) => Self::Text(value.clone()),
            Value::Int(value) => Self::Int(*value),
            Value::Decimal(value) => Self::Decimal(value.clone()),
            Value::Bool(value) => Self::Bool(*value),
            Value::Timestamp(value) => Self::Timestamp(value.clone()),
            Value::Bytes(value) => Self::Bytes(value.clone()),
        }
    }
}

struct DriverConnectionInfo<'a> {
    host: &'a str,
    port: u16,
    service_name: &'a str,
    username: &'a str,
    password: &'a str,
}

#[derive(Clone)]
struct DriverError {
    code: String,
    message: String,
    retryable: bool,
}

fn port_error_with_credentials(
    error: DriverError,
    credential_values: impl IntoIterator<Item = impl Into<String>>,
) -> PortError {
    PortError::with_credential_values(
        error.code,
        error.message,
        error.retryable,
        credential_values,
    )
}

#[async_trait]
trait OracleDriver: Send + Sync {
    async fn open(
        &self,
        connection: DriverConnectionInfo<'_>,
    ) -> Result<Box<dyn OracleDriverSession>, DriverError>;
}

#[async_trait]
trait OracleDriverSession: Send {
    async fn query(&mut self, sql: &str) -> Result<RowSet, DriverError>;
    async fn begin(&mut self) -> Result<(), DriverError>;
    async fn execute_prepared(
        &mut self,
        sql: &str,
        bind_names: &[String],
        batch: &[Vec<DriverValue>],
    ) -> Result<u64, DriverError>;
    async fn commit(&mut self) -> Result<(), DriverError>;
    async fn rollback(&mut self) -> Result<(), DriverError>;
}

struct OracleRsDriver;

#[async_trait]
impl OracleDriver for OracleRsDriver {
    async fn open(
        &self,
        connection: DriverConnectionInfo<'_>,
    ) -> Result<Box<dyn OracleDriverSession>, DriverError> {
        let config = Config::new(
            connection.host,
            connection.port,
            connection.service_name,
            connection.username,
            connection.password,
        )
        .with_statement_cache_size(16);
        let connection = Connection::connect_with_config(config)
            .await
            .map_err(oracle_error)?;
        Ok(Box::new(OracleRsSession { connection }))
    }
}

struct OracleRsSession {
    connection: Connection,
}

#[async_trait]
impl OracleDriverSession for OracleRsSession {
    async fn query(&mut self, sql: &str) -> Result<RowSet, DriverError> {
        let result = self
            .connection
            .query(sql, &[])
            .await
            .map_err(oracle_error)?;
        let names = result
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect::<Vec<_>>();
        let rows = result
            .rows
            .into_iter()
            .map(|row| {
                Row::from_columns(
                    row.into_values()
                        .into_iter()
                        .enumerate()
                        .map(|(index, value)| {
                            (
                                names
                                    .get(index)
                                    .cloned()
                                    .unwrap_or_else(|| index.to_string()),
                                domain_value(value),
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        Ok(RowSet { rows })
    }

    async fn begin(&mut self) -> Result<(), DriverError> {
        // Oracle starts a transaction implicitly on the first DML statement.
        Ok(())
    }

    async fn execute_prepared(
        &mut self,
        sql: &str,
        _bind_names: &[String],
        batch: &[Vec<DriverValue>],
    ) -> Result<u64, DriverError> {
        if batch.first().is_some_and(Vec::is_empty) {
            let mut affected = 0;
            for _ in batch {
                affected += self
                    .connection
                    .execute(sql, &[])
                    .await
                    .map_err(oracle_error)?
                    .rows_affected;
            }
            return Ok(affected);
        }

        let mut prepared = BatchBinds::new(sql);
        for row in batch {
            prepared.add_row(row.iter().cloned().map(oracle_value).collect());
        }
        let result = self
            .connection
            .execute_batch(&prepared)
            .await
            .map_err(oracle_error)?;
        Ok(result.total_rows_affected)
    }

    async fn commit(&mut self) -> Result<(), DriverError> {
        self.connection.commit().await.map_err(oracle_error)
    }

    async fn rollback(&mut self) -> Result<(), DriverError> {
        self.connection.rollback().await.map_err(oracle_error)
    }
}

fn oracle_value(value: DriverValue) -> oracle_rs::Value {
    match value {
        DriverValue::Null => oracle_rs::Value::Null,
        DriverValue::Text(value) | DriverValue::Decimal(value) | DriverValue::Timestamp(value) => {
            oracle_rs::Value::String(value)
        }
        DriverValue::Int(value) => oracle_rs::Value::Integer(value),
        DriverValue::Bool(value) => oracle_rs::Value::Boolean(value),
        DriverValue::Bytes(value) => oracle_rs::Value::Bytes(value),
    }
}

fn domain_value(value: oracle_rs::Value) -> Value {
    match value {
        oracle_rs::Value::Null => Value::Null,
        oracle_rs::Value::String(value) => Value::Text(value),
        oracle_rs::Value::Bytes(value) => Value::Bytes(value),
        oracle_rs::Value::Integer(value) => Value::Int(value),
        oracle_rs::Value::Float(value) => Value::Decimal(value.to_string()),
        oracle_rs::Value::Number(value) => Value::Decimal(value.as_str().to_owned()),
        oracle_rs::Value::Boolean(value) => Value::Bool(value),
        oracle_rs::Value::Timestamp(value) => {
            Value::Timestamp(oracle_rs::Value::Timestamp(value).to_string())
        }
        other => Value::Text(other.to_string()),
    }
}

fn oracle_error(error: oracle_rs::Error) -> DriverError {
    use oracle_rs::Error;

    let retryable = error.is_recoverable() || error.is_connection_error();
    let (code, message) = match error {
        Error::OracleError { code, message } => (format!("ORA-{code:05}"), message),
        Error::InvalidServiceName { message, .. } => (
            "ORA-12514".into(),
            message.unwrap_or_else(|| "Oracle service name was not found".into()),
        ),
        Error::InvalidSid { message, .. } => (
            "ORA-12505".into(),
            message.unwrap_or_else(|| "Oracle SID was not found".into()),
        ),
        Error::InvalidCredentials => ("ORA-01017".into(), "invalid username or password".into()),
        Error::AuthenticationFailed(message) => ("ORA-01017".into(), message),
        other => ("ORACLE".into(), other.to_string()),
    };
    DriverError {
        code,
        message,
        retryable,
    }
}

#[derive(Default)]
struct TestOracleDriver {
    failure: Option<DriverError>,
}

#[async_trait]
impl OracleDriver for TestOracleDriver {
    async fn open(
        &self,
        _connection: DriverConnectionInfo<'_>,
    ) -> Result<Box<dyn OracleDriverSession>, DriverError> {
        Ok(Box::new(TestOracleSession {
            failure: self.failure.clone(),
        }))
    }
}

struct TestOracleSession {
    failure: Option<DriverError>,
}

#[async_trait]
impl OracleDriverSession for TestOracleSession {
    async fn query(&mut self, _sql: &str) -> Result<RowSet, DriverError> {
        Ok(RowSet::default())
    }

    async fn begin(&mut self) -> Result<(), DriverError> {
        Ok(())
    }

    async fn execute_prepared(
        &mut self,
        _sql: &str,
        _bind_names: &[String],
        batch: &[Vec<DriverValue>],
    ) -> Result<u64, DriverError> {
        self.failure.clone().map_or(Ok(batch.len() as u64), Err)
    }

    async fn commit(&mut self) -> Result<(), DriverError> {
        Ok(())
    }

    async fn rollback(&mut self) -> Result<(), DriverError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn converts_named_rows_in_sql_bind_order_case_insensitively() {
        let row = BTreeMap::from([
            ("label".into(), Value::Text("first".into())),
            ("ID".into(), Value::Int(7)),
        ]);

        let values = bind_row(&row, &["id".into(), "LABEL".into()]).unwrap();

        assert!(
            matches!(values.as_slice(), [DriverValue::Int(7), DriverValue::Text(label)] if label == "first")
        );
    }

    #[test]
    fn maps_native_oracle_errors_without_dropping_the_oracle_code() {
        let error = oracle_error(oracle_rs::Error::oracle(1, "unique constraint violated"));

        assert_eq!(error.code, "ORA-00001");
        assert!(!error.retryable);
    }
}
