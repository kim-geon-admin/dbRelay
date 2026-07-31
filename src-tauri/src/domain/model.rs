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
    Timestamp(String),
    Bytes(Vec<u8>),
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Row(Vec<(String, Value)>);

impl Row {
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
    pub rows: Vec<Row>,
}

impl RowSet {
    pub fn single<const N: usize>(columns: [(&str, Value); N]) -> Self {
        Self {
            rows: vec![Row::from(columns)],
        }
    }
}

pub type NamedRow = BTreeMap<String, Value>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum MappingError {
    MissingSourceColumn { parameter: String },
    DuplicateSourceColumn { column: String },
}
