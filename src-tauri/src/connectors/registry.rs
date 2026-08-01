use crate::{application::ports::DatabaseConnectorFactory, domain::DbKind};

use super::OracleConnector;

/// Resolves a database kind to its port-compatible connector factory.
///
/// The registry owns concrete adapters so application services only ever see
/// the database ports, not a driver's connection or value types.
pub struct ConnectorRegistry {
    oracle: Box<dyn DatabaseConnectorFactory>,
}

impl ConnectorRegistry {
    pub fn with_oracle(oracle: OracleConnector) -> Self {
        Self {
            oracle: Box::new(oracle),
        }
    }

    pub fn for_kind(&self, kind: DbKind) -> Option<&dyn DatabaseConnectorFactory> {
        match kind {
            DbKind::Oracle => Some(self.oracle.as_ref()),
        }
    }
}
