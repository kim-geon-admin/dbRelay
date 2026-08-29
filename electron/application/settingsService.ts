import type { ConnectionProfile, DbKind } from "../domain/models";
import type { ConnectionRepository } from "./ports";

export type { ConnectionRepository } from "./ports";

const UNAVAILABLE_KEYRING_PASSWORD_MASK = "********";

export class SettingsServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SettingsServiceError";
  }
}

export interface CredentialStore {
  store(account: string, secret: string): Promise<void>;
  resolve(account: string): Promise<string>;
  delete(account: string): Promise<void>;
}

export interface DatabaseSession {
  close?(): Promise<void> | void;
}

export interface DatabaseConnectorFactory {
  kind: DbKind;
  open(profile: ConnectionProfile, secret: string): Promise<DatabaseSession>;
}

export interface ConnectionDto {
  id: string;
  displayName: string;
  kind: DbKind;
  host: string;
  port: number;
  sid: string;
  username: string;
  passwordMask: string;
  sourceReadOnly: boolean;
  enabled: boolean;
}

export function passwordMask(
  profile: Pick<ConnectionProfile, "credentialStorage" | "plaintextPassword">,
  resolvedKeyringSecret?: string,
): string {
  if (profile.credentialStorage === "plaintext") {
    return "*".repeat(Array.from(profile.plaintextPassword ?? "").length);
  }
  return resolvedKeyringSecret === undefined
    ? UNAVAILABLE_KEYRING_PASSWORD_MASK
    : "*".repeat(Array.from(resolvedKeyringSecret).length);
}

export class SettingsService {
  constructor(
    private readonly repository: ConnectionRepository,
    private readonly credentials?: CredentialStore,
  ) {}

  async saveConnection(profile: ConnectionProfile): Promise<void> {
    validateConnection(profile, true);
    this.repository.saveConnection({
      ...profile,
      credentialRef: profile.credentialRef || profile.id,
      credentialStorage: "plaintext",
    });
  }

  async updateConnection(profile: ConnectionProfile, replacementPassword?: string): Promise<void> {
    validateConnection(profile, false);
    const existing = this.repository.loadConnection(profile.id);
    if (existing === undefined) {
      throw new SettingsServiceError("CONNECTION_NOT_FOUND", "connection not found");
    }
    if (replacementPassword !== undefined && replacementPassword.length === 0) {
      throw new SettingsServiceError("VALIDATION", "credential is required");
    }
    this.repository.updateConnection({
      ...profile,
      credentialRef: existing.credentialRef,
      credentialStorage: replacementPassword === undefined
        ? existing.credentialStorage
        : "plaintext",
      plaintextPassword: replacementPassword === undefined
        ? existing.plaintextPassword
        : replacementPassword,
    });
  }

  async listConnections(): Promise<ConnectionProfile[]> {
    return this.repository.listConnections();
  }

  async listConnectionDtos(): Promise<ConnectionDto[]> {
    const profiles = this.repository.listConnections();
    return Promise.all(profiles.map(async (profile) => this.connectionDto(profile)));
  }

  async connectionDto(profile: ConnectionProfile): Promise<ConnectionDto> {
    let resolvedKeyringSecret: string | undefined;
    if (profile.credentialStorage === "keyring" && this.credentials !== undefined) {
      try {
        resolvedKeyringSecret = await this.resolveCredential(profile);
      } catch {
        resolvedKeyringSecret = undefined;
      }
    }
    return {
      id: profile.id,
      displayName: profile.displayName,
      kind: profile.kind,
      host: profile.host,
      port: profile.port,
      sid: profile.sid,
      username: profile.username,
      passwordMask: passwordMask(profile, resolvedKeyringSecret),
      sourceReadOnly: profile.sourceReadOnly,
      enabled: profile.enabled,
    };
  }

  async disableConnection(connectionId: string): Promise<void> {
    validateRequired(connectionId, "connection ID");
    this.repository.disableConnection(connectionId);
  }

  async setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void> {
    validateRequired(connectionId, "connection ID");
    const existing = this.repository.loadConnection(connectionId);
    if (existing === undefined) {
      throw new SettingsServiceError("CONNECTION_NOT_FOUND", "connection not found");
    }
    this.repository.updateConnection({ ...existing, enabled });
  }

  async deleteConnection(connectionId: string): Promise<void> {
    validateRequired(connectionId, "connection ID");
    this.repository.deleteConnection(connectionId);
  }

  async testConnection(
    connectionId: string,
    connector: DatabaseConnectorFactory,
  ): Promise<void> {
    validateRequired(connectionId, "connection ID");
    const profile = this.repository.loadConnection(connectionId);
    if (profile === undefined) {
      throw new SettingsServiceError("CONNECTION_NOT_FOUND", "connection not found");
    }
    if (!profile.enabled) {
      throw new SettingsServiceError("CONNECTION_DISABLED", "connection is disabled");
    }
    if (connector.kind !== profile.kind) {
      throw new SettingsServiceError(
        "CONNECTOR_KIND_MISMATCH",
        "connector kind does not match",
      );
    }
    const session = await connector.open(profile, await this.resolveCredential(profile));
    await session.close?.();
  }

  private async resolveCredential(profile: ConnectionProfile): Promise<string> {
    if (profile.credentialStorage === "plaintext") {
      if (profile.plaintextPassword === undefined || profile.plaintextPassword === null) {
        throw new SettingsServiceError(
          "CREDENTIAL_NOT_FOUND",
          "plaintext password was not found",
        );
      }
      return profile.plaintextPassword;
    }
    if (this.credentials === undefined) {
      throw new SettingsServiceError("CREDENTIAL_NOT_FOUND", "credential was not found");
    }
    try {
      return await this.credentials.resolve(profile.credentialRef);
    } catch (error) {
      if (!hasErrorCode(error, "CREDENTIAL_NOT_FOUND")
        || profile.credentialRef === profile.id) {
        throw error;
      }
      const legacy = await this.credentials.resolve(profile.id);
      await this.credentials.store(profile.credentialRef, legacy);
      return legacy;
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function validateConnection(profile: ConnectionProfile, requireCredential: boolean): void {
  validateRequired(profile.id, "connection ID");
  validateRequired(profile.displayName, "display name");
  validateRequired(profile.host, "host");
  validateRequired(profile.sid, "SID");
  validateRequired(profile.username, "username");
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535) {
    throw new SettingsServiceError("VALIDATION", "port must be between 1 and 65535");
  }
  if (requireCredential
    && profile.credentialStorage === "plaintext"
    && (profile.plaintextPassword === undefined || profile.plaintextPassword === null
      || profile.plaintextPassword.length === 0)) {
    throw new SettingsServiceError("VALIDATION", "credential is required");
  }
}

function validateRequired(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new SettingsServiceError("VALIDATION", `${label} is required`);
  }
}
