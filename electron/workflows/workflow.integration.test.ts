import { expect, it } from "vitest";

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
    expect(JSON.stringify(connections)).not.toContain(test.secretSentinel);
  } finally {
    await test.close();
  }
}, 30_000);
