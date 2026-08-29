// @ts-expect-error node-oracledb does not publish TypeScript declarations.
import oracledb from "oracledb";
import { join } from "node:path";

import { expect, it } from "vitest";

import { EditablePreviewCache } from "../application/editablePreviewCache";
import { MigrationRunner } from "../application/migrationRunner";
import { OracleConnector } from "../connectors/oracleConnector";
import { SqliteRepository } from "../infrastructure/sqliteRepository";

const enabled = process.env.DB_RELAY_LOCAL2_KOREAN_BIND_TEST === "1";
const local2KoreanBindTest = enabled ? it : it.skip;

local2KoreanBindTest("Oracle accepts a Korean named bind with the saved Local2 target profile", async () => {
  const repository = SqliteRepository.open(join(process.env.APPDATA ?? "", "db-relay", "db-relay.sqlite"));
  const profile = repository.listConnections().find((connection) => connection.displayName === "로컬2-대상");
  expect(profile?.plaintextPassword).toEqual(expect.any(String));
  expect(profile).toBeDefined();
  const connection = await oracledb.getConnection({
    user: profile!.username,
    password: profile!.plaintextPassword!,
    connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${profile!.host})(PORT=${profile!.port}))(CONNECT_DATA=(SERVICE_NAME=${profile!.sid})))`,
  });
  try {
    const result = await connection.execute(
      "SELECT USER_ID FROM TGT_USERS WHERE USER_ID = :사용자ID",
      { 사용자ID: 1001 },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    expect(result.rows).toHaveLength(1);
  } finally {
    await connection.close();
    repository.close();
  }
}, 30_000);

local2KoreanBindTest("DB Relay maps a Korean Source alias to a Korean Target bind", async () => {
  const repository = SqliteRepository.open(join(process.env.APPDATA ?? "", "db-relay", "db-relay.sqlite"));
  const source = repository.listConnections().find((connection) => connection.displayName === "로컬2");
  const target = repository.listConnections().find((connection) => connection.displayName === "로컬2-대상");
  expect(source).toBeDefined();
  expect(target).toBeDefined();
  const runner = new MigrationRunner(new OracleConnector(), repository, repository, undefined, new EditablePreviewCache());
  try {
    await expect(runner.runFlowStep({
      sourceConnectionId: source!.id,
      targetConnectionId: target!.id,
      selectSql: "SELECT 1001 AS \"사용자ID\" FROM dual",
      upsertSql: "UPDATE TGT_USERS SET DISPLAY_NAME = DISPLAY_NAME WHERE USER_ID = :사용자ID",
    })).resolves.toEqual({ affectedRows: 1 });
  } finally {
    repository.close();
  }
}, 30_000);
