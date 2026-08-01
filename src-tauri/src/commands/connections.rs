use std::fmt;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    application::{ports::ResolvedSecret, settings_service::SettingsService},
    domain::{ConnectionProfile, CredentialStorage, DbKind},
};

use super::{ApplicationContainer, CommandErrorDto};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRequest {
    pub id: String,
    pub display_name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub service_name: String,
    pub username: String,
    #[serde(default)]
    pub source_read_only: bool,
    pub secret: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionRequest {
    pub id: String,
    pub display_name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub service_name: String,
    pub username: String,
    #[serde(default)]
    pub source_read_only: bool,
    pub enabled: bool,
    pub replacement_secret: Option<String>,
}

impl fmt::Debug for ConnectionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectionRequest")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("service_name", &self.service_name)
            .field("username", &self.username)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

impl fmt::Debug for UpdateConnectionRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UpdateConnectionRequest")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("service_name", &self.service_name)
            .field("username", &self.username)
            .field("enabled", &self.enabled)
            .field(
                "replacement_secret",
                &self.replacement_secret.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdRequest {
    pub connection_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionResponse {
    pub id: String,
    pub display_name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub service_name: String,
    pub username: String,
    pub password_mask: String,
    pub source_read_only: bool,
    pub enabled: bool,
}

impl From<ConnectionProfile> for ConnectionResponse {
    fn from(profile: ConnectionProfile) -> Self {
        Self {
            id: profile.id,
            display_name: profile.display_name,
            kind: profile.kind,
            host: profile.host,
            port: profile.port,
            service_name: profile.service_name,
            username: profile.username,
            password_mask: String::new(),
            source_read_only: profile.source_read_only,
            enabled: profile.enabled,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResponse {
    pub connection_id: String,
    pub connected: bool,
}

#[tauri::command]
pub async fn list_connections(
    state: State<'_, ApplicationContainer>,
) -> Result<Vec<ConnectionResponse>, CommandErrorDto> {
    let service = SettingsService::new(state.repository.clone(), state.credentials.clone());
    let profiles = service
        .list_connections()
        .await
        .map_err(CommandErrorDto::from_port)?;
    let mut responses = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let mut response = ConnectionResponse::from(profile.clone());
        response.password_mask = service.password_mask(&profile).await;
        responses.push(response);
    }
    Ok(responses)
}

#[tauri::command]
pub async fn save_connection(
    request: ConnectionRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<ConnectionResponse, CommandErrorDto> {
    let profile = request.new_profile()?;
    SettingsService::new(state.repository.clone(), state.credentials.clone())
        .save_connection(&profile, ResolvedSecret::new(request.secret))
        .await
        .map(|()| profile.into())
        .map_err(CommandErrorDto::from_port)
}

#[tauri::command]
pub async fn update_connection(
    request: UpdateConnectionRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<ConnectionResponse, CommandErrorDto> {
    let replacement_secret = request
        .replacement_secret
        .as_ref()
        .map(|secret| validate_secret(secret).map(|()| ResolvedSecret::new(secret.clone())))
        .transpose()?;
    let profile = request.profile()?;
    SettingsService::new(state.repository.clone(), state.credentials.clone())
        .update_connection(&profile, replacement_secret)
        .await
        .map(|()| profile.into())
        .map_err(CommandErrorDto::from_port)
}

#[tauri::command]
pub async fn disable_connection(
    request: ConnectionIdRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<ConnectionResponse, CommandErrorDto> {
    validate_id(&request.connection_id, "connection ID")?;
    let service = SettingsService::new(state.repository.clone(), state.credentials.clone());
    service
        .disable_connection(&request.connection_id)
        .await
        .map_err(CommandErrorDto::from_port)?;
    let profile = state
        .repository
        .load_connection(&request.connection_id)
        .await
        .map_err(CommandErrorDto::from_port)?
        .ok_or_else(|| {
            CommandErrorDto::from_run_error(
                "CONNECTION_NOT_FOUND",
                "connection not found",
                "",
                None,
            )
        })?;
    Ok(profile.into())
}

#[tauri::command]
pub async fn test_connection(
    request: ConnectionIdRequest,
    state: State<'_, ApplicationContainer>,
) -> Result<TestConnectionResponse, CommandErrorDto> {
    validate_id(&request.connection_id, "connection ID")?;
    SettingsService::new(state.repository.clone(), state.credentials.clone())
        .test_connection(&request.connection_id, state.connector.as_ref())
        .await
        .map(|()| TestConnectionResponse {
            connection_id: request.connection_id,
            connected: true,
        })
        .map_err(CommandErrorDto::from_port)
}

impl ConnectionRequest {
    fn new_profile(&self) -> Result<ConnectionProfile, CommandErrorDto> {
        validate_connection_fields(
            &self.id,
            &self.display_name,
            &self.host,
            self.port,
            &self.service_name,
            &self.username,
        )?;
        validate_secret(&self.secret)?;
        Ok(ConnectionProfile {
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            kind: self.kind,
            host: self.host.clone(),
            port: self.port,
            service_name: self.service_name.clone(),
            username: self.username.clone(),
            credential_ref: self.id.clone(),
            credential_storage: CredentialStorage::Plaintext,
            plaintext_password: Some(self.secret.clone()),
            enabled: true,
            source_read_only: self.source_read_only,
        })
    }
}

impl UpdateConnectionRequest {
    fn profile(&self) -> Result<ConnectionProfile, CommandErrorDto> {
        validate_connection_fields(
            &self.id,
            &self.display_name,
            &self.host,
            self.port,
            &self.service_name,
            &self.username,
        )?;
        Ok(ConnectionProfile {
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            kind: self.kind,
            host: self.host.clone(),
            port: self.port,
            service_name: self.service_name.clone(),
            username: self.username.clone(),
            credential_ref: String::new(),
            credential_storage: CredentialStorage::Plaintext,
            plaintext_password: self.replacement_secret.clone(),
            enabled: self.enabled,
            source_read_only: self.source_read_only,
        })
    }
}

fn validate_connection_fields(
    id: &str,
    display_name: &str,
    host: &str,
    port: u16,
    service_name: &str,
    username: &str,
) -> Result<(), CommandErrorDto> {
    validate_id(id, "connection ID")?;
    for (value, label) in [
        (display_name, "display name"),
        (host, "host"),
        (service_name, "service name"),
        (username, "username"),
    ] {
        if value.trim().is_empty() {
            return Err(CommandErrorDto::validation(format!("{label} is required")));
        }
    }
    if port == 0 {
        return Err(CommandErrorDto::validation(
            "port must be between 1 and 65535",
        ));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<(), CommandErrorDto> {
    if value.trim().is_empty() {
        return Err(CommandErrorDto::validation(format!("{label} is required")));
    }
    Ok(())
}

fn validate_secret(secret: &str) -> Result<(), CommandErrorDto> {
    if secret.is_empty() {
        return Err(CommandErrorDto::validation("credential is required"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_connection_profiles_store_the_supplied_password_as_plaintext() {
        let request = ConnectionRequest {
            id: "production".into(),
            display_name: "Production".into(),
            kind: DbKind::Oracle,
            host: "db.example.test".into(),
            port: 1521,
            service_name: "ORCLPDB1".into(),
            username: "relay".into(),
            source_read_only: false,
            secret: "plain-secret".into(),
        };

        let profile = request.new_profile().unwrap();

        assert_eq!(profile.credential_storage, CredentialStorage::Plaintext);
        assert_eq!(profile.plaintext_password.as_deref(), Some("plain-secret"));
    }
}
