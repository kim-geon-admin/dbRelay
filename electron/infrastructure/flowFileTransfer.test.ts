import { describe, expect, it, vi } from "vitest";

import { ElectronFlowFileTransfer } from "./flowFileTransfer";

describe("ElectronFlowFileTransfer", () => {
  it("writes a selected flow export as a JSON file", async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: false, filePath: "C:/Exports/daily.dbrelay-flow.json" });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const transfer = new ElectronFlowFileTransfer({
      showSaveDialog,
      showOpenDialog: vi.fn(),
    }, { readFile: vi.fn(), writeFile });

    await expect(transfer.save({
      format: "db-relay-flow",
      formatVersion: 1,
      flow: {
        id: "daily", name: "Daily", sourceConnectionId: "source", targetConnectionId: "target",
        querySteps: [{ id: "step-1", selectSql: "SELECT id FROM source_table", upsertSql: "INSERT INTO target_table (id) VALUES (:id)" }],
        transactionPolicy: "all_or_nothing", version: 4,
      },
    })).resolves.toBe(true);

    expect(writeFile).toHaveBeenCalledWith("C:/Exports/daily.dbrelay-flow.json", JSON.stringify({
      format: "db-relay-flow",
      formatVersion: 1,
      flow: {
        id: "daily", name: "Daily", sourceConnectionId: "source", targetConnectionId: "target",
        querySteps: [{ id: "step-1", selectSql: "SELECT id FROM source_table", upsertSql: "INSERT INTO target_table (id) VALUES (:id)" }],
        transactionPolicy: "all_or_nothing", version: 4,
      },
    }, null, 2), "utf8");
  });
});
