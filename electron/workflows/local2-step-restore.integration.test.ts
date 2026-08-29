import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { expect, it } from "vitest";

import { EditablePreviewCache } from "../application/editablePreviewCache";
import { FlowService } from "../application/flowService";
import { MigrationRunner } from "../application/migrationRunner";
import { OracleConnector } from "../connectors/oracleConnector";
import { SqliteRepository } from "../infrastructure/sqliteRepository";

const databasePath = "C:/Users/kg/AppData/Roaming/db-relay/db-relay.sqlite";
const enabled = process.env.DB_RELAY_LOCAL2_RESTORE_TEST === "1" && existsSync(databasePath);
const local2 = enabled ? it : it.skip;

local2("runs and restores update, insert, and upsert in two saved Local2 flows", async () => {
  const repository = SqliteRepository.open(databasePath);
  const source = repository.listConnections().find((profile) => profile.displayName === "로컬2");
  const target = repository.listConnections().find((profile) => profile.displayName === "로컬2-대상");
  expect(source).toBeDefined(); expect(target).toBeDefined();
  const runner = new MigrationRunner(new OracleConnector(), repository, repository, undefined, new EditablePreviewCache());
  const flowService = new FlowService(repository);
  const tag = `DBR Restore ${Date.now()}`;
  const baseId = 8_000_000 + (Date.now() % 100_000);
  try {
    for (const offset of [0, 10]) {
      const id = baseId + offset;
      const usesLoginIdKey = offset !== 0;
      const sourceKeySql = usesLoginIdKey
        ? "SELECT LOGIN_ID, 'DBR restore update' DISPLAY_NAME FROM TGT_USERS WHERE USER_ID = 1001"
        : "SELECT 1001 USER_ID, 'DBR restore update' DISPLAY_NAME FROM dual";
      const updateSql = usesLoginIdKey
        ? "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE LOGIN_ID = :LOGIN_ID"
        : "UPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME WHERE USER_ID = :USER_ID";
      const upsertSourceSql = usesLoginIdKey
        ? "SELECT LOGIN_ID, 'DBR restore upsert' DISPLAY_NAME FROM TGT_USERS WHERE USER_ID = 1001"
        : "SELECT 1001 USER_ID, 'DBR restore upsert' DISPLAY_NAME FROM dual";
      const upsertSql = usesLoginIdKey
        ? "MERGE INTO TGT_USERS target USING (SELECT :LOGIN_ID LOGIN_ID, :DISPLAY_NAME DISPLAY_NAME FROM dual) source ON (target.LOGIN_ID = source.LOGIN_ID) WHEN MATCHED THEN UPDATE SET target.DISPLAY_NAME = source.DISPLAY_NAME WHEN NOT MATCHED THEN INSERT (LOGIN_ID, DISPLAY_NAME) VALUES (source.LOGIN_ID, source.DISPLAY_NAME)"
        : "MERGE INTO TGT_USERS target USING (SELECT :USER_ID USER_ID, :DISPLAY_NAME DISPLAY_NAME FROM dual) source ON (target.USER_ID = source.USER_ID) WHEN MATCHED THEN UPDATE SET target.DISPLAY_NAME = source.DISPLAY_NAME WHEN NOT MATCHED THEN INSERT (USER_ID, DISPLAY_NAME) VALUES (source.USER_ID, source.DISPLAY_NAME)";
      await flowService.saveFlow({
        id: `local2-step-restore-${id}`, name: `${tag} ${offset === 0 ? "A" : "B"}`,
        sourceConnectionId: source!.id, targetConnectionId: target!.id,
        transactionPolicy: "all_or_nothing", version: 0,
        querySteps: [
          { id: "update", selectSql: sourceKeySql, upsertSql: updateSql },
          { id: "insert", selectSql: `SELECT ${id} USER_ID, 'dbr.${id}' LOGIN_ID, 'DBR Restore' DISPLAY_NAME, 'dbr.${id}@example.test' EMAIL FROM dual`, upsertSql: "INSERT INTO TGT_USERS (USER_ID, LOGIN_ID, DISPLAY_NAME, EMAIL) VALUES (:USER_ID, :LOGIN_ID, :DISPLAY_NAME, :EMAIL)" },
          { id: "upsert", selectSql: upsertSourceSql, upsertSql },
        ],
      });
      for (const step of repository.loadFlow(`local2-step-restore-${id}`)!.querySteps) {
        const run = await runner.runFlowStep({ sourceConnectionId: source!.id, targetConnectionId: target!.id, selectSql: step.selectSql, upsertSql: step.upsertSql, editorSessionId: randomUUID(), stepId: step.id });
        expect(run.restoreId).toEqual(expect.any(String));
        await expect(runner.restoreFlowStep({ restoreId: run.restoreId! })).resolves.toMatchObject({ affectedRows: 1 });
      }
    }
  } finally { repository.close(); }
}, 60_000);

local2("restores an edited preview with commented SQL and leaves an OR condition non-restorable", async () => {
  const repository = SqliteRepository.open(databasePath);
  const source = repository.listConnections().find((profile) => profile.id === "1254066f-3670-423e-8731-e23c2c1217c9");
  const target = repository.listConnections().find((profile) => profile.id === "local2-target-profile");
  expect(source).toBeDefined(); expect(target).toBeDefined();
  const runner = new MigrationRunner(new OracleConnector(), repository, repository, undefined, new EditablePreviewCache());
  try {
    const preview = await runner.previewFlowStep({
      sourceConnectionId: source!.id,
      selectSql: "SELECT 1001 USER_ID, 'DBR preview restore' DISPLAY_NAME FROM dual",
    });
    runner.saveEditedPreview({
      previewId: preview.previewId,
      columns: preview.columns,
      rows: [{ USER_ID: 1001, DISPLAY_NAME: "DBR preview edited restore" }],
    });
    const commented = await runner.runFlowStep({
      sourceConnectionId: source!.id,
      targetConnectionId: target!.id,
      selectSql: "SELECT 1001 USER_ID, 'DBR preview restore' DISPLAY_NAME FROM dual",
      upsertSql: "-- retained comment\nUPDATE TGT_USERS SET DISPLAY_NAME = :DISPLAY_NAME /* retained */ WHERE USER_ID = :USER_ID",
      previewId: preview.previewId,
      editorSessionId: randomUUID(),
      stepId: "commented-preview-update",
    });
    expect(commented.restoreId).toEqual(expect.any(String));
    await expect(runner.restoreFlowStep({ restoreId: commented.restoreId! }))
      .resolves.toMatchObject({ affectedRows: 1 });

    const unsupported = await runner.runFlowStep({
      sourceConnectionId: source!.id,
      targetConnectionId: target!.id,
      selectSql: "SELECT 1001 USER_ID FROM dual",
      upsertSql: "UPDATE TGT_USERS SET DISPLAY_NAME = DISPLAY_NAME WHERE USER_ID = :USER_ID OR 1 = 0",
      editorSessionId: randomUUID(),
      stepId: "or-condition-update",
    });
    expect(unsupported).toEqual({ affectedRows: 1 });
  } finally { repository.close(); }
}, 60_000);
