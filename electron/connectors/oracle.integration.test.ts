import { expect, it } from "vitest";

import type { ConnectionProfile } from "../domain/models";
import { OracleConnector } from "./oracleConnector";

const oracleTestUrl = process.env.DB_RELAY_ORACLE_TEST_URL;
const integrationTest = oracleTestUrl === undefined || oracleTestUrl.trim() === ""
  ? it.skip
  : it;

integrationTest("runs a disposable named MERGE and rollback fixture", async () => {
  const { profile, password } = parseOracleTestUrl(oracleTestUrl as string);
  const table = `DBR_IT_${process.pid}_${Date.now() % 100_000}`;
  const session = await new OracleConnector().open(profile, password);
  const dropFixture = `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${table} PURGE'; `
    + "EXCEPTION WHEN OTHERS THEN IF SQLCODE != -942 THEN RAISE; END IF; END;";

  try {
    await session.executeNamed(dropFixture, [{}]);
    await session.executeNamed(
      `BEGIN EXECUTE IMMEDIATE 'CREATE TABLE ${table} (`
        + "id NUMBER PRIMARY KEY, label VARCHAR2(30), happened_on DATE, "
        + "happened_at TIMESTAMP(6))'; END;",
      [{}],
    );
    const merge = `MERGE INTO ${table} target `
      + "USING (SELECT :ID id, :LABEL label, :HAPPENED_ON happened_on, "
      + ":HAPPENED_AT happened_at FROM dual) source "
      + "ON (target.id = source.id) "
      + "WHEN MATCHED THEN UPDATE SET target.label = source.label, "
      + "target.happened_on = source.happened_on, target.happened_at = source.happened_at "
      + "WHEN NOT MATCHED THEN INSERT (id, label, happened_on, happened_at) "
      + "VALUES (source.id, source.label, source.happened_on, source.happened_at)";
    const happenedOn = {
      year: 2026, month: 8, day: 1, hour: 12, minute: 30, second: 0,
    } as const;
    const happenedAt = {
      ...happenedOn,
      microsecond: 123_456,
      tzHourOffset: 0,
      tzMinuteOffset: 0,
    } as const;

    await session.begin();
    await session.executeNamed(merge, [{
      ID: 1,
      LABEL: "merged",
      HAPPENED_ON: happenedOn,
      HAPPENED_AT: happenedAt,
    }]);
    await session.commit();
    expect(await session.query(
      `SELECT label, happened_on, happened_at FROM ${table} WHERE id = 1`,
    )).toMatchObject({
      unsupportedBindColumns: ["HAPPENED_AT"],
      rows: [{
        LABEL: "merged",
        HAPPENED_ON: happenedOn,
      }],
    });
    expect(await session.query(
      `SELECT TO_CHAR(happened_at, 'FF6') fraction FROM ${table} WHERE id = 1`,
    )).toMatchObject({ rows: [{ FRACTION: "123456" }] });

    await session.begin();
    await session.executeNamed(merge, [{
      ID: 2,
      LABEL: "rolled back",
      HAPPENED_ON: happenedOn,
      HAPPENED_AT: happenedAt,
    }]);
    await session.rollback();
    expect((await session.query(
      `SELECT label FROM ${table} WHERE id = 2`,
    )).rows).toEqual([]);
  } finally {
    try {
      await session.executeNamed(dropFixture, [{}]);
    } finally {
      await session.close();
    }
  }
}, 30_000);

function parseOracleTestUrl(value: string): {
  profile: ConnectionProfile;
  password: string;
} {
  const url = new URL(value);
  if (url.protocol !== "oracle:") {
    throw new Error("DB_RELAY_ORACLE_TEST_URL must use oracle://");
  }
  const sid = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (url.hostname === "" || sid === "" || url.username === "") {
    throw new Error("DB_RELAY_ORACLE_TEST_URL must include user, host, and SID");
  }
  const username = decodeURIComponent(url.username);
  return {
    profile: {
      id: "oracle-integration",
      displayName: "Oracle integration",
      kind: "oracle",
      host: url.hostname,
      port: url.port === "" ? 1521 : Number(url.port),
      sid,
      username,
      credentialRef: "oracle-integration",
      credentialStorage: "plaintext",
      plaintextPassword: undefined,
      enabled: true,
      sourceReadOnly: true,
    },
    password: decodeURIComponent(url.password),
  };
}
