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

    fn entry(credential_ref: &str) -> Result<Entry, PortError> {
        Entry::new(SERVICE_NAME, Self::account_name(credential_ref))
            .map_err(|_| PortError::new("CREDENTIAL_STORE", "credential store is unavailable"))
    }

    fn account_name(credential_ref: &str) -> &str {
        credential_ref
    }
}

#[async_trait]
impl CredentialStore for KeyringCredentialStore {
    async fn store(&self, credential_ref: &str, secret: ResolvedSecret) -> Result<(), PortError> {
        Self::entry(credential_ref)?
            .set_password(secret.expose())
            .map_err(|_| PortError::new("CREDENTIAL_STORE", "credential could not be saved"))
    }

    async fn resolve(&self, credential_ref: &str) -> Result<ResolvedSecret, PortError> {
        let password = Self::entry(credential_ref)?.get_password().map_err(|_| {
            PortError::new("CREDENTIAL_NOT_FOUND", "credential reference not found")
        })?;
        Ok(ResolvedSecret::new(password))
    }

    async fn delete(&self, credential_ref: &str) -> Result<(), PortError> {
        Self::entry(credential_ref)?
            .delete_credential()
            .map_err(|_| PortError::new("CREDENTIAL_STORE", "credential could not be deleted"))
    }
}

#[cfg(test)]
mod tests {
    use super::KeyringCredentialStore;

    #[test]
    fn credential_references_with_matching_final_segments_use_distinct_accounts() {
        let first = KeyringCredentialStore::account_name("credential://db-relay/team-a/prod");
        let second = KeyringCredentialStore::account_name("credential://db-relay/team-b/prod");

        assert_eq!(first, "credential://db-relay/team-a/prod");
        assert_ne!(first, second);
    }
}
