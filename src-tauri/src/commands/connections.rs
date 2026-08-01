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
    pub credential_storage: CredentialStorage,
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
    pub credential_storage: CredentialStorage,
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
    pub credential_storage: CredentialStorage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
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
            credential_storage: profile.credential_storage,
            password: (profile.credential_storage == CredentialStorage::Plaintext)
                .then_some(profile.plaintext_password)
                .flatten(),
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
    SettingsService::new(state.repository.clone(), state.credentials.clone())
        .list_connections()
        .await
        .map(|profiles| profiles.into_iter().map(ConnectionResponse::from).collect())
        .map_err(CommandErrorDto::from_port)
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
            credential_storage: self.credential_storage,
            plaintext_password: (self.credential_storage == CredentialStorage::Plaintext)
                .then_some(self.secret.clone()),
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
            credential_storage: self.credential_storage,
            plaintext_password: (self.credential_storage == CredentialStorage::Plaintext)
                .then_some(self.replacement_secret.clone())
                .flatten(),
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
