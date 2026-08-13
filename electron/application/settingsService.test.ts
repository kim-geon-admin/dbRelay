import { describe, expect, it } from "vitest";

import {
  SettingsService,
  passwordMask,
  type ConnectionRepository,
  type DatabaseConnectorFactory,
} from "./settingsService";
import type { ConnectionProfile } from "../domain/models";

describe("passwordMask", () => {
  it("projects a plaintext password as a same-length mask", () => {
    expect(passwordMask({
      plaintextPassword: "secret123",
      credentialStorage: "plaintext",
    })).toBe("*********");
  });
});

describe("SettingsService", () => {
  it("requires all connection fields including SID", async () => {
    const repository = new MemoryConnectionRepository();
    const service = new SettingsService(repository);

    await expect(service.saveConnection({ ...profile(), sid: " " }))
      .rejects.toMatchObject({ code: "VALIDATION", message: "SID is required" });
    expect(repository.listConnections()).toEqual([]);
  });

  it("stores current profiles as plaintext and projects only a password mask", async () => {
    const repository = new MemoryConnectionRepository();
    const service = new SettingsService(repository);

    await service.saveConnection(profile());
    const projected = await service.listConnectionDtos();

    expect(projected).toEqual([expect.objectContaining({ passwordMask: "*********" })]);
    expect(projected[0]).not.toHaveProperty("plaintextPassword");
    expect(projected[0]).not.toHaveProperty("credentialRef");
  });

  it("preserves a password when changing enabled state without a replacement", async () => {
    const repository = new MemoryConnectionRepository();
    const service = new SettingsService(repository);
    await service.saveConnection(profile());

    await service.updateConnection({ ...profile(), enabled: false });

    expect(repository.loadConnection("production")).toMatchObject({
      enabled: false,
      plaintextPassword: "secret123",
    });
  });

  it("enables an existing connection without replacing its password", async () => {
    const repository = new MemoryConnectionRepository();
    const service = new SettingsService(repository);
    await service.saveConnection({ ...profile(), enabled: false });

    await service.setConnectionEnabled("production", true);

    expect(repository.loadConnection("production")).toMatchObject({
      enabled: true,
      plaintextPassword: "secret123",
      host: "db.example.test",
    });
  });

  it("delegates connection testing with the resolved plaintext password", async () => {
    const repository = new MemoryConnectionRepository();
    const opened: Array<{ id: string; secret: string }> = [];
    const connector: DatabaseConnectorFactory = {
      kind: "oracle",
      open: async (connection, secret) => {
        opened.push({ id: connection.id, secret });
        return { close: async () => undefined };
      },
    };
    const service = new SettingsService(repository);
    await service.saveConnection(profile());

    await service.testConnection("production", connector);

    expect(opened).toEqual([{ id: "production", secret: "secret123" }]);
  });

  it("does not use a legacy account after a non-not-found keyring failure", async () => {
    const repository = new MemoryConnectionRepository();
    repository.saveConnection({
      ...profile(),
      credentialRef: "production:versioned",
      credentialStorage: "keyring",
      plaintextPassword: undefined,
    });
    const resolvedAccounts: string[] = [];
    const credentials = {
      store: async () => undefined,
      resolve: async (account: string) => {
        resolvedAccounts.push(account);
        if (account === "production:versioned") {
          throw Object.assign(new Error("keyring unavailable"), {
            code: "CREDENTIAL_UNAVAILABLE",
          });
        }
        return "stale-secret";
      },
      delete: async () => undefined,
    };
    const service = new SettingsService(repository, credentials);
    const connector: DatabaseConnectorFactory = {
      kind: "oracle",
      open: async () => ({ close: async () => undefined }),
    };

    await expect(service.testConnection("production", connector))
      .rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(resolvedAccounts).toEqual(["production:versioned"]);
  });
});

class MemoryConnectionRepository implements ConnectionRepository {
  private readonly profiles = new Map<string, ConnectionProfile>();

  loadConnection(id: string): ConnectionProfile | undefined {
    return this.profiles.get(id);
  }

  loadRunnableConnection(id: string): ConnectionProfile | undefined {
    return this.loadConnection(id);
  }

  saveConnection(connection: ConnectionProfile): void {
    this.profiles.set(connection.id, structuredClone(connection));
  }

  updateConnection(connection: ConnectionProfile): void {
    this.profiles.set(connection.id, structuredClone(connection));
  }

  listConnections(): ConnectionProfile[] {
    return [...this.profiles.values()].map((connection) => structuredClone(connection));
  }

  disableConnection(id: string): void {
    const connection = this.profiles.get(id);
    if (connection !== undefined) {
      connection.enabled = false;
    }
  }

  deleteConnection(id: string): void {
    this.profiles.delete(id);
  }
}

function profile(): ConnectionProfile {
  return {
    id: "production",
    displayName: "Production",
    kind: "oracle",
    host: "db.example.test",
    port: 1521,
    sid: "XE",
    username: "relay",
    credentialRef: "production",
    credentialStorage: "plaintext",
    plaintextPassword: "secret123",
    enabled: true,
    sourceReadOnly: true,
  };
}
