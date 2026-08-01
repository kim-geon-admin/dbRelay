use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DbKind {
    Oracle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConnectionProfile {
    pub id: String,
    pub display_name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub service_name: String,
    pub username: String,
    pub credential_ref: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Flow {
    pub id: String,
    pub name: String,
    pub source_connection_id: String,
    pub target_connection_id: String,
    pub query_steps: Vec<QueryStep>,
    pub transaction_policy: TransactionPolicy,
    pub version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct QueryStep {
    pub id: String,
    pub select_sql: String,
    pub upsert_sql: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionPolicy {
    AllOrNothing,
    CommitSuccesses,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Value {
    Null,
    Text(String),
    Int(i64),
    Decimal(String),
    Bool(bool),
    /// A legacy textual timestamp. It is deliberately not accepted for an
    /// Oracle bind because its type, precision, and timezone are ambiguous.
    Timestamp(String),
    OracleDate(OracleDate),
    OracleTimestamp(OracleTimestamp),
    Bytes(Vec<u8>),
}

/// The complete Oracle DATE payload, kept structured until the connector
/// writes an Oracle typed bind.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OracleDate {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

/// The complete plain Oracle TIMESTAMP payload exposed by oracle-rs.
/// Timezone-bearing timestamp values are rejected by the connector because
/// oracle-rs 0.1.7 batches them as a plain TIMESTAMP.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OracleTimestamp {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub microsecond: u32,
    pub tz_hour_offset: i8,
    pub tz_minute_offset: i8,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Row(Vec<(String, Value)>);

impl Row {
    pub fn from_columns(columns: Vec<(String, Value)>) -> Self {
        Self(columns)
    }

    pub fn normalized_index(&self) -> Result<HashMap<String, Value>, MappingError> {
        let mut columns = HashMap::with_capacity(self.0.len());

        for (column, value) in &self.0 {
            let normalized = column.to_ascii_uppercase();
            if columns.insert(normalized.clone(), value.clone()).is_some() {
                return Err(MappingError::DuplicateSourceColumn { column: normalized });
            }
        }

        Ok(columns)
    }
}

impl<const N: usize> From<[(&str, Value); N]> for Row {
    fn from(columns: [(&str, Value); N]) -> Self {
        Self(
            columns
                .into_iter()
                .map(|(column, value)| (column.into(), value))
                .collect(),
        )
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct RowSet {
    #[serde(default)]
    pub columns: Vec<String>,
    /// Source column names whose driver type cannot be converted to a target
    /// bind without changing its meaning. This never contains values or SQL.
    #[serde(default)]
    pub unsupported_bind_columns: Vec<String>,
    pub rows: Vec<Row>,
}

impl RowSet {
    pub fn single<const N: usize>(columns: [(&str, Value); N]) -> Self {
        let column_names = columns.iter().map(|(column, _)| (*column).into()).collect();
        Self {
            columns: column_names,
            unsupported_bind_columns: Vec::new(),
            rows: vec![Row::from(columns)],
        }
    }
}

pub type NamedRow = BTreeMap<String, Value>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum MappingError {
    MissingSourceColumn { parameter: String },
    DuplicateSourceColumn { column: String },
    NumericBind { parameter: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationError {
    message: &'static str,
}

impl ValidationError {
    pub(crate) const fn new(message: &'static str) -> Self {
        Self { message }
    }

    pub fn message(&self) -> &'static str {
        self.message
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ValidationError {}
