use async_trait::async_trait;
use keyring::Entry;

use crate::application::ports::{CredentialStore, PortError, ResolvedSecret};

const SERVICE_NAME: &str = "db-relay";

#[derive(Default)]
pub struct KeyringCredentialStore;

impl KeyringCredentialStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(connection_id: &str) -> Result<Entry, PortError> {
        Entry::new(SERVICE_NAME, Self::account_name(connection_id))
            .map_err(|_| PortError::new("CREDENTIAL_STORE", "credential store is unavailable"))
    }

    fn account_name(connection_id: &str) -> &str {
        connection_id
    }
}

#[async_trait]
impl CredentialStore for KeyringCredentialStore {
    async fn store(&self, connection_id: &str, secret: ResolvedSecret) -> Result<(), PortError> {
        Self::entry(connection_id)?
            .set_password(secret.expose())
            .map_err(|_| PortError::new("CREDENTIAL_STORE", "credential could not be saved"))
    }

    async fn resolve(&self, connection_id: &str) -> Result<ResolvedSecret, PortError> {
        let password = Self::entry(connection_id)?.get_password().map_err(|_| {
            PortError::new("CREDENTIAL_NOT_FOUND", "credential reference not found")
        })?;
        Ok(ResolvedSecret::new(password))
    }

    async fn delete(&self, connection_id: &str) -> Result<(), PortError> {
        Self::entry(connection_id)?
            .delete_credential()
            .map_err(|_| PortError::new("CREDENTIAL_STORE", "credential could not be deleted"))
    }
}

#[cfg(test)]
mod tests {
    use super::KeyringCredentialStore;

    #[test]
    fn stable_connection_id_is_used_as_the_keyring_account_name() {
        let connection_id = "source-production-7";

        assert_eq!(
            KeyringCredentialStore::account_name(connection_id),
            connection_id
        );
    }
}
