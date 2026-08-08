import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnectorFactory } from "./databaseConnector";
import { ConnectorRegistry } from "./registry";

describe("ConnectorRegistry", () => {
  it("resolves Oracle without exposing driver types to callers", () => {
    const oracle: DatabaseConnectorFactory = {
      kind: "oracle",
      open: vi.fn(),
    };

    expect(new ConnectorRegistry([oracle]).forKind("oracle")).toBe(oracle);
  });
});
