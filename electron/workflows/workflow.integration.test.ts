import { expect, it } from "vitest";

import type { ConnectionDto } from "../ipc/commands";
import { createWorkflowHarness } from "./workflowTestHarness";

const integrationTest = process.env.DB_RELAY_ORACLE_TEST_URL?.trim() ? it : it.skip;

integrationTest("registers distinct Oracle connections without returning the password", async () => {
  const test = await createWorkflowHarness(process.env.DB_RELAY_ORACLE_TEST_URL!);
  try {
    await test.saveConnections();
    const connections = await test.handler("list_connections");

    expect(connections).toHaveLength(2);
    expect(connections.every(({ passwordMask }) =>
      passwordMask === "*".repeat(test.passwordLength))).toBe(true);
    assertConnectionDtoSchema(connections);
    assertNoCredentialMaterial(connections, test.secretSentinel);
  } finally {
    await test.close();
  }
}, 30_000);

function assertConnectionDtoSchema(connections: readonly ConnectionDto[]): void {
  const expectedKeys = [
    "displayName",
    "enabled",
    "host",
    "id",
    "kind",
    "passwordMask",
    "port",
    "sid",
    "username",
  ];
  for (const connection of connections) {
    expect(Object.keys(connection).sort()).toEqual(expectedKeys);
  }
}

function assertNoCredentialMaterial(
  connections: readonly ConnectionDto[],
  secret: string,
): void {
  for (const connection of connections) {
    if (Object.values(connection).some((value) => value === secret)) {
      throw new Error("connection DTO exposed credential material");
    }
  }
}
