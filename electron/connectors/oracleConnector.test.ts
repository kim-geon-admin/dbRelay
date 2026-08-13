import { describe, expect, it, vi } from "vitest";

import type { ConnectionProfile, NamedRow } from "../domain/models";
import { ConnectorError } from "./databaseConnector";
import { OracleConnector } from "./oracleConnector";

describe("OracleConnector", () => {
  it("opens an Oracle SID profile through a SID connect descriptor", async () => {
    const { connector, driver } = fixture();

    const session = await connector.open(profile({
      host: "db.example",
      port: 1521,
      sid: "XE",
      username: "relay",
    }), "secret");

    expect(driver.getConnection).toHaveBeenCalledWith({
      user: "relay",
      password: "secret",
      connectString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example)(PORT=1521))(CONNECT_DATA=(SID=XE)))",
    });
    await session.close();
  });

  it("executes named batches with executeMany and explicit non-autocommit bind definitions", async () => {
    const { connector, connection } = fixture();
    const session = await connector.open(profile(), "secret");

    const affected = await session.executeNamed("MERGE INTO t USING :ID", [{ ID: 7 }]);

    expect(connection.executeMany).toHaveBeenCalledOnce();
    expect(connection.executeMany).toHaveBeenCalledWith(
      "MERGE INTO t USING :ID",
      [{ ID: 7 }],
      {
        autoCommit: false,
        bindDefs: { ID: { type: "DB_TYPE_NUMBER" } },
      },
    );
    expect(affected).toBe(1);
    await session.close();
  });

  it("uses numeric iterations for executeMany statements without binds", async () => {
    const { connector, connection } = fixture();
    const session = await connector.open(profile(), "secret");

    await session.executeNamed("BEGIN NULL; END;", [{}, {}]);

    expect(connection.executeMany).toHaveBeenCalledWith(
      "BEGIN NULL; END;",
      2,
      { autoCommit: false, bindDefs: {} },
    );
    await session.close();
  });

  it("queries object rows and preserves supported values without stringifying unsupported values", async () => {
    const happenedOn = new Date(2026, 7, 1, 12, 30, 0, 0);
    const happenedAt = new Date(2026, 7, 1, 12, 30, 0, 123);
    const unsupported = { opaque: true };
    const { connector, connection } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [
          { name: "ID", dbType: "DB_TYPE_NUMBER" },
          { name: "LABEL", dbType: "DB_TYPE_VARCHAR" },
          { name: "HAPPENED_ON", dbType: "DB_TYPE_DATE" },
          { name: "HAPPENED_AT", dbType: "DB_TYPE_TIMESTAMP", precision: 3 },
          { name: "PAYLOAD", dbType: "DB_TYPE_RAW" },
          { name: "OPAQUE", dbType: "DB_TYPE_JSON" },
        ],
        rows: [{
          ID: 7,
          LABEL: "first",
          HAPPENED_ON: happenedOn,
          HAPPENED_AT: happenedAt,
          PAYLOAD: Buffer.from([1, 2, 3]),
          OPAQUE: unsupported,
        }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT * FROM relay_test");

    expect(connection.execute).toHaveBeenCalledWith(
      "SELECT * FROM relay_test",
      [],
      expect.objectContaining({ outFormat: "OUT_FORMAT_OBJECT" }),
    );
    expect(result).toEqual({
      columns: ["ID", "LABEL", "HAPPENED_ON", "HAPPENED_AT", "PAYLOAD", "OPAQUE"],
      unsupportedBindColumns: ["OPAQUE"],
      rows: [{
        ID: 7,
        LABEL: "first",
        HAPPENED_ON: {
          year: 2026, month: 8, day: 1, hour: 12, minute: 30, second: 0,
        },
        HAPPENED_AT: {
          year: 2026, month: 8, day: 1, hour: 12, minute: 30, second: 0,
          microsecond: 123_000, tzHourOffset: 0, tzMinuteOffset: 0,
        },
        PAYLOAD: new Uint8Array([1, 2, 3]),
      }],
    });
    expect(Object.values(result.rows[0])).not.toContain(String(unsupported));
    await session.close();
  });

  it("marks timestamp columns with sub-millisecond source precision as unsupported", async () => {
    const { connector } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [{
          name: "HAPPENED_AT",
          dbType: "DB_TYPE_TIMESTAMP",
          precision: 6,
        }],
        rows: [{ HAPPENED_AT: new Date(2026, 7, 1, 12, 30, 0, 123) }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT happened_at FROM relay_test");

    expect(result).toEqual({
      columns: ["HAPPENED_AT"],
      unsupportedBindColumns: ["HAPPENED_AT"],
      rows: [{}],
    });
    await session.close();
  });

  it("keeps every valid Oracle NUMBER in source rows without lossy JavaScript conversion", async () => {
    const { connector, connection, driver } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [
          { name: "SAFE_ID", dbType: "DB_TYPE_NUMBER" },
          { name: "AMOUNT", dbType: "DB_TYPE_NUMBER" },
          { name: "ROUND_TRIP_UNSAFE_ID", dbType: "DB_TYPE_NUMBER" },
          { name: "UNSAFE_ID", dbType: "DB_TYPE_NUMBER" },
          { name: "PRECISE_AMOUNT", dbType: "DB_TYPE_NUMBER" },
        ],
        rows: [{
          SAFE_ID: "7",
          AMOUNT: "123.45",
          ROUND_TRIP_UNSAFE_ID: "9007199254740992",
          UNSAFE_ID: "9007199254740993",
          PRECISE_AMOUNT: "0.12345678901234567890123456789012345678",
        }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT numbers FROM relay_test");

    const options = connection.execute.mock.calls[0][2];
    expect(options.fetchTypeHandler({ dbType: driver.DB_TYPE_NUMBER })).toEqual({
      type: driver.DB_TYPE_VARCHAR,
    });
    expect(result).toEqual({
      columns: ["SAFE_ID", "AMOUNT", "ROUND_TRIP_UNSAFE_ID", "UNSAFE_ID", "PRECISE_AMOUNT"],
      unsupportedBindColumns: ["ROUND_TRIP_UNSAFE_ID", "UNSAFE_ID", "PRECISE_AMOUNT"],
      rows: [{
        SAFE_ID: 7,
        AMOUNT: 123.45,
        ROUND_TRIP_UNSAFE_ID: 9_007_199_254_740_992n,
        UNSAFE_ID: 9_007_199_254_740_993n,
        PRECISE_AMOUNT: "0.12345678901234567890123456789012345678",
      }],
    });
    await session.close();
  });

  it("derives batch bind definitions across every row and converts structured dates", async () => {
    const { connector, connection } = fixture();
    const session = await connector.open(profile(), "secret");
    const rows: NamedRow[] = [
      {
        LABEL: null,
        HAPPENED_ON: {
          year: 2026, month: 8, day: 1, hour: 12, minute: 30, second: 0,
        },
        HAPPENED_AT: {
          year: 2026, month: 8, day: 1, hour: 12, minute: 30, second: 0,
          microsecond: 123_456, tzHourOffset: 0, tzMinuteOffset: 0,
        },
        PAYLOAD: new Uint8Array([1, 2]),
      },
      {
        LABEL: "longer label",
        HAPPENED_ON: null,
        HAPPENED_AT: null,
        PAYLOAD: new Uint8Array([1, 2, 3, 4]),
      },
    ];

    await session.executeNamed(
      "MERGE INTO t USING :LABEL, :HAPPENED_ON, :HAPPENED_AT, :PAYLOAD",
      rows,
    );

    const [, convertedRows, options] = connection.executeMany.mock.calls[0];
    expect(options).toEqual({
      autoCommit: false,
      bindDefs: {
        LABEL: { type: "DB_TYPE_VARCHAR", maxSize: 12 },
        HAPPENED_ON: { type: "DB_TYPE_DATE" },
        HAPPENED_AT: { type: "DB_TYPE_TIMESTAMP" },
        PAYLOAD: { type: "DB_TYPE_RAW", maxSize: 4 },
      },
    });
    expect(convertedRows[0]).toMatchObject({
      HAPPENED_ON: expect.any(Date),
      HAPPENED_AT: expect.any(Date),
      PAYLOAD: expect.any(Buffer),
    });
    expect(convertedRows[0].HAPPENED_ON.getHours()).toBe(12);
    expect(convertedRows[0].HAPPENED_AT.getHours()).toBe(12);
    expect(convertedRows[0].HAPPENED_AT.getMilliseconds()).toBe(123);
    expect(convertedRows[0].HAPPENED_AT.getUTCMilliseconds()).toBe(123.456);
    await session.close();
  });

  it("rejects bigint binds that are unsupported by the declared node-oracledb 6.2 contract", async () => {
    const { connector, connection } = fixture();
    const session = await connector.open(profile(), "secret");

    const error = await expectConnectorRejection(
      session.executeNamed("MERGE INTO t USING :ID", [{ ID: 9_007_199_254_740_993n }]),
    );

    expect(error).toMatchObject({ code: "BIND_TYPE_UNSUPPORTED" });
    expect(connection.executeMany).not.toHaveBeenCalled();
    await session.close();
  });

  it("delegates commit, rollback, and close while begin remains implicit", async () => {
    const { connector, connection } = fixture();
    const session = await connector.open(profile(), "secret");

    await session.begin();
    await session.commit();
    await session.rollback();
    await session.close();
    await session.close();

    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("masks close failures and allows the caller to retry closing the connection", async () => {
    const close = vi.fn()
      .mockRejectedValueOnce(new Error("ORA-03113: password=secret"))
      .mockResolvedValueOnce(undefined);
    const { connector } = fixture({ close });
    const session = await connector.open(profile(), "secret");

    const error = await expectConnectorRejection(session.close());
    await session.close();

    expect(error).toMatchObject({ code: "ORA-03113", retryable: true });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("secret");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves normalized Oracle error codes while redacting credentials and bind rows", async () => {
    const leakedMessage = "ORA-00001: password=secret bind row {\"ID\":7}";
    const { connector } = fixture({
      executeMany: vi.fn().mockRejectedValue(Object.assign(new Error(leakedMessage), {
        errorNum: 1,
        isRecoverable: false,
      })),
    });
    const session = await connector.open(profile(), "secret");

    const error = await expectConnectorRejection(
      session.executeNamed("MERGE INTO t USING :ID", [{ ID: 7 }]),
    );

    expect(error).toMatchObject({
      code: "ORA-00001",
      retryable: false,
    });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("{\"ID\":7}");
    expect(error).not.toHaveProperty("rows");
    await session.close();
  });

  it("normalizes open failures without exposing the password", async () => {
    const { connector } = fixture({
      getConnection: vi.fn().mockRejectedValue(Object.assign(
        new Error("ORA-01017: invalid username/password; password=secret"),
        { errorNum: 1017 },
      )),
    });

    const error = await expectConnectorRejection(connector.open(profile(), "secret"));

    expect(error).toMatchObject({ code: "ORA-01017", retryable: false });
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("secret");
  });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const connection = {
    execute: vi.fn().mockResolvedValue({ metaData: [], rows: [] }),
    executeMany: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const driver = {
    OUT_FORMAT_OBJECT: "OUT_FORMAT_OBJECT",
    DB_TYPE_BOOLEAN: "DB_TYPE_BOOLEAN",
    DB_TYPE_DATE: "DB_TYPE_DATE",
    DB_TYPE_NUMBER: "DB_TYPE_NUMBER",
    DB_TYPE_RAW: "DB_TYPE_RAW",
    DB_TYPE_TIMESTAMP: "DB_TYPE_TIMESTAMP",
    DB_TYPE_VARCHAR: "DB_TYPE_VARCHAR",
    getConnection: vi.fn().mockResolvedValue(connection),
    ...overrides,
  };
  return { connection, driver, connector: new OracleConnector(driver) };
}

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: "oracle-test",
    displayName: "Oracle test",
    kind: "oracle",
    host: "localhost",
    port: 1521,
    sid: "XE",
    username: "relay",
    credentialRef: "oracle-test",
    credentialStorage: "plaintext",
    plaintextPassword: "secret",
    enabled: true,
    sourceReadOnly: true,
    ...overrides,
  };
}

function expectConnectorError(caught: unknown): ConnectorError {
  expect(caught).toBeInstanceOf(ConnectorError);
  if (!(caught instanceof ConnectorError)) {
    throw caught;
  }
  return caught;
}

async function expectConnectorRejection<T>(promise: Promise<T>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (caught) {
    return expectConnectorError(caught);
  }
  throw new Error("expected connector operation to reject");
}
