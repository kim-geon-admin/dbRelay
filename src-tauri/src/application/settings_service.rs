use std::sync::Arc;

use crate::{
    application::ports::{
        CredentialStore, DatabaseConnectorFactory, FlowRepository, PortError, ResolvedSecret,
    },
    domain::ConnectionProfile,
};

pub struct SettingsService<R: FlowRepository + ?Sized, C: CredentialStore + ?Sized> {
    repository: Arc<R>,
    credentials: Arc<C>,
}

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
        self.credentials.store(&profile.id, credential).await?;
        self.repository.save_connection(profile).await
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
        updated.credential_ref = existing.credential_ref;
        if let Some(credential) = replacement {
            self.credentials.store(&updated.id, credential).await?;
        }
        self.repository.update_connection(&updated).await
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

    pub async fn disable_connection(&self, connection_id: &str) -> Result<(), PortError> {
        self.repository.disable_connection(connection_id).await
    }

    async fn resolve_credential(
        &self,
        profile: &ConnectionProfile,
    ) -> Result<ResolvedSecret, PortError> {
        match self.credentials.resolve(&profile.id).await {
            Ok(credential) => Ok(credential),
            Err(error)
                if error.code() == "CREDENTIAL_NOT_FOUND"
                    && profile.credential_ref != profile.id =>
            {
                let credential = self.credentials.resolve(&profile.credential_ref).await?;
                self.credentials
                    .store(&profile.id, credential.clone())
                    .await?;
                Ok(credential)
            }
            Err(error) => Err(error),
        }
    }
}
