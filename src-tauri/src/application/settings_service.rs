use std::sync::Arc;

use uuid::Uuid;

use crate::{
    application::ports::{
        CredentialStore, DatabaseConnectorFactory, FlowRepository, PortError, ResolvedSecret,
    },
    domain::{ConnectionProfile, CredentialStorage},
};

pub struct SettingsService<R: FlowRepository + ?Sized, C: CredentialStore + ?Sized> {
    repository: Arc<R>,
    credentials: Arc<C>,
}

const UNAVAILABLE_KEYRING_PASSWORD_MASK: &str = "********";

impl<R: FlowRepository + ?Sized, C: CredentialStore + ?Sized> SettingsService<R, C> {
    pub fn new(repository: Arc<R>, credentials: Arc<C>) -> Self {
        Self {
            repository,
            credentials,
        }
    }

    pub async fn save_connection(
        &self,
        profile: &ConnectionProfile,
        credential: ResolvedSecret,
    ) -> Result<(), PortError> {
        if profile.credential_storage == CredentialStorage::Plaintext {
            return self.repository.save_connection(profile).await;
        }
        let mut persisted = profile.clone();
        persisted.credential_ref = credential_account(&profile.id);
        self.credentials
            .store(&persisted.credential_ref, credential)
            .await?;
        if let Err(error) = self.repository.save_connection(&persisted).await {
            let _ = self.credentials.delete(&persisted.credential_ref).await;
            return Err(error);
        }
        Ok(())
    }

    pub async fn update_connection(
        &self,
        profile: &ConnectionProfile,
        replacement: Option<ResolvedSecret>,
    ) -> Result<(), PortError> {
        let existing = self
            .repository
            .load_connection(&profile.id)
            .await?
            .ok_or_else(|| PortError::new("CONNECTION_NOT_FOUND", "connection not found"))?;

        let mut updated = profile.clone();
        match (existing.credential_storage, updated.credential_storage) {
            (CredentialStorage::Plaintext, CredentialStorage::Plaintext) => {
                updated.credential_ref = existing.credential_ref;
                updated.plaintext_password = replacement
                    .as_ref()
                    .map(|credential| credential.expose().to_owned())
                    .or(existing.plaintext_password);
                self.repository.update_connection(&updated).await
            }
            (CredentialStorage::Keyring, CredentialStorage::Plaintext) => {
                if replacement.is_none() {
                    updated.credential_ref = existing.credential_ref;
                    updated.credential_storage = CredentialStorage::Keyring;
                    updated.plaintext_password = None;
                    return self.repository.update_connection(&updated).await;
                }
                let credential = replacement.ok_or_else(|| {
                    PortError::new(
                        "CREDENTIAL_REQUIRED",
                        "a password is required when changing credential storage",
                    )
                })?;
                updated.credential_ref = existing.credential_ref.clone();
                updated.plaintext_password = Some(credential.expose().to_owned());
                self.repository.update_connection(&updated).await
            }
            (CredentialStorage::Plaintext, CredentialStorage::Keyring) => {
                let credential = replacement.ok_or_else(|| {
                    PortError::new(
                        "CREDENTIAL_REQUIRED",
                        "a password is required when changing credential storage",
                    )
                })?;
                updated.credential_ref = credential_account(&updated.id);
                updated.plaintext_password = None;
                self.credentials
                    .store(&updated.credential_ref, credential)
                    .await?;
                if let Err(error) = self.repository.update_connection(&updated).await {
                    let _ = self.credentials.delete(&updated.credential_ref).await;
                    return Err(error);
                }
                Ok(())
            }
            (CredentialStorage::Keyring, CredentialStorage::Keyring) => {
                updated.credential_ref = existing.credential_ref.clone();
                updated.plaintext_password = None;
                if let Some(credential) = replacement {
                    updated.credential_ref = credential_account(&updated.id);
                    self.credentials
                        .store(&updated.credential_ref, credential)
                        .await?;
                    if let Err(error) = self.repository.update_connection(&updated).await {
                        let _ = self.credentials.delete(&updated.credential_ref).await;
                        return Err(error);
                    }
                    if existing.credential_ref != updated.credential_ref {
                        let _ = self.credentials.delete(&existing.credential_ref).await;
                    }
                    return Ok(());
                }
                self.repository.update_connection(&updated).await
            }
        }
    }

    pub async fn test_connection(
        &self,
        connection_id: &str,
        connector: &dyn DatabaseConnectorFactory,
    ) -> Result<(), PortError> {
        let profile = self
            .repository
            .load_connection(connection_id)
            .await?
            .ok_or_else(|| PortError::new("CONNECTION_NOT_FOUND", "connection not found"))?;
        if !profile.enabled {
            return Err(PortError::new(
                "CONNECTION_DISABLED",
                "connection is disabled",
            ));
        }
        if connector.kind() != profile.kind {
            return Err(PortError::new(
                "CONNECTOR_KIND_MISMATCH",
                "connector kind does not match",
            ));
        }
        let credential = self.resolve_credential(&profile).await?;
        let _session = connector.open(&profile, &credential).await?;
        Ok(())
    }

    pub async fn list_connections(&self) -> Result<Vec<ConnectionProfile>, PortError> {
        self.repository.list_connections().await
    }

    pub async fn password_mask(&self, profile: &ConnectionProfile) -> String {
        match self.resolve_credential(profile).await {
            Ok(secret) => "*".repeat(secret.expose().chars().count()),
            Err(_) if profile.credential_storage == CredentialStorage::Keyring => {
                UNAVAILABLE_KEYRING_PASSWORD_MASK.into()
            }
            Err(_) => String::new(),
        }
    }

    pub async fn disable_connection(&self, connection_id: &str) -> Result<(), PortError> {
        self.repository.disable_connection(connection_id).await
    }

    async fn resolve_credential(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ResolvedSecret, PortError> {
        if profile.credential_storage == CredentialStorage::Plaintext {
            return profile
                .plaintext_password
                .clone()
                .map(ResolvedSecret::new)
                .ok_or_else(|| {
                    PortError::new("CREDENTIAL_NOT_FOUND", "plaintext password was not found")
                });
        }
        match self.credentials.resolve(&profile.credential_ref).await {
            Ok(credential) => Ok(credential),
            Err(error)
                if error.code() == "CREDENTIAL_NOT_FOUND"
                    && profile.credential_ref != profile.id =>
            {
                let credential = self.credentials.resolve(&profile.id).await?;
                self.credentials
                    .store(&profile.credential_ref, credential.clone())
                    .await?;
                Ok(credential)
            }
            Err(error) => Err(error),
        }
    }
}

fn credential_account(connection_id: &str) -> String {
    format!("{connection_id}:{}", Uuid::new_v4())
}
