import { invokeCommand } from "../../lib/tauri";
import type { Connection, ConnectionSaveInput, ConnectionTestResult } from "./connections.types";

export function listConnections(): Promise<Connection[]> {
  return invokeCommand("list_connections");
}

export function saveConnection(input: ConnectionSaveInput): Promise<Connection> {
  if (input.enabled === undefined) {
    return invokeCommand("save_connection", {
      request: {
        id: input.id,
        displayName: input.displayName,
        kind: input.kind,
        host: input.host,
        port: input.port,
        sid: input.sid,
        username: input.username,
        secret: input.password ?? "",
      },
    });
  }

  return invokeCommand("update_connection", {
    request: {
      id: input.id,
      displayName: input.displayName,
      kind: input.kind,
      host: input.host,
      port: input.port,
      sid: input.sid,
      username: input.username,
      enabled: input.enabled,
      replacementSecret: input.password || undefined,
    },
  });
}

export function testConnection(id: string): Promise<ConnectionTestResult> {
  return invokeCommand("test_connection", { request: { connectionId: id } });
}

export function disableConnection(id: string): Promise<Connection> {
  return invokeCommand("disable_connection", { request: { connectionId: id } });
}
