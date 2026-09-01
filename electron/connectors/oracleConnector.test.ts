import { describe, expect, it, vi } from "vitest";

import type { ConnectionProfile, NamedRow } from "../domain/models";
import { ConnectorError } from "./databaseConnector";
import { OracleConnector } from "./oracleConnector";

describe("OracleConnector", () => {
  it("opens an Oracle profile through an EZCONNECT service name", async () => {
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
      connectString: "db.example:1521/XE",
    });
    await session.close();
  });

  it("retries a missing service name as a SID", async () => {
    const recoveredConnection = { close: vi.fn().mockResolvedValue(undefined) };
    const { connector, driver } = fixture({
      getConnection: vi.fn()
        .mockRejectedValueOnce({ errorNum: 12514, message: "listener does not currently know of service requested" })
        .mockResolvedValueOnce(recoveredConnection),
    });

    const session = await connector.open(profile({ sid: "ORCLPDB1" }), "secret");

    expect(driver.getConnection).toHaveBeenNthCalledWith(1, {
      user: "relay",
      password: "secret",
      connectString: "localhost:1521/ORCLPDB1",
    });
    expect(driver.getConnection).toHaveBeenNthCalledWith(2, {
      user: "relay",
      password: "secret",
      connectString: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=1521))(CONNECT_DATA=(SID=ORCLPDB1)))",
    });
    await session.close();
  });

  it("does not retry as a SID after a non-service connection error", async () => {
    const { connector, driver } = fixture({
      getConnection: vi.fn().mockRejectedValue({ errorNum: 1017, message: "invalid username/password" }),
    });

    await expect(connector.open(profile(), "secret")).rejects.toMatchObject({ code: "ORA-01017" });

    expect(driver.getConnection).toHaveBeenCalledOnce();
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

  it("classifies numeric and text target columns from USER_TAB_COLUMNS", async () => {
    const { connector, connection } = fixture({
      execute: vi.fn().mockResolvedValue({
        rows: [
          { COLUMN_NAME: "USER_ID", DATA_TYPE: "NUMBER" },
          { COLUMN_NAME: "LOGIN_ID", DATA_TYPE: "VARCHAR2" },
        ],
      }),
    });
    const session = await connector.open(profile(), "secret");

    expect(session.describeTargetColumns).toBeTypeOf("function");
    await expect(session.describeTargetColumns!("TGT_USERS", ["USER_ID", "LOGIN_ID"]))
      .resolves.toEqual({ USER_ID: "numeric", LOGIN_ID: "text" });
    expect(connection.execute).toHaveBeenCalledWith(
      expect.stringContaining("USER_TAB_COLUMNS"), expect.anything(), expect.anything(),
    );
    await session.close();
  });

  it("uses ALL_TAB_COLUMNS when USER_TAB_COLUMNS is incomplete", async () => {
    const { connector, connection } = fixture({
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ COLUMN_NAME: "USER_ID", DATA_TYPE: "NUMBER" }] })
        .mockResolvedValueOnce({ rows: [
          { COLUMN_NAME: "USER_ID", DATA_TYPE: "NUMBER" },
          { COLUMN_NAME: "LOGIN_ID", DATA_TYPE: "VARCHAR2" },
        ] }),
    });
    const session = await connector.open(profile(), "secret");

    expect(session.describeTargetColumns).toBeTypeOf("function");
    await expect(session.describeTargetColumns!("TGT_USERS", ["USER_ID", "LOGIN_ID"]))
      .resolves.toEqual({ USER_ID: "numeric", LOGIN_ID: "text" });
    expect(connection.execute.mock.calls[1][0]).toContain("ALL_TAB_COLUMNS");
    await session.close();
  });

  it("returns Oracle ROWIDs from a named DML returning batch", async () => {
    const { connector, connection } = fixture({
      executeMany: vi.fn().mockResolvedValue({
        rowsAffected: 2,
        outBinds: [
          { DBR_RESTORE_ROWID: ["AAABBB"] },
          { DBR_RESTORE_ROWID: ["AAABBC"] },
        ],
      }),
    });
    const session = await connector.open(profile(), "secret");

    await expect(session.executeNamedReturningRowIds?.(
      "INSERT INTO T (ID) VALUES (:ID) RETURNING ROWID INTO :DBR_RESTORE_ROWID",
      [{ ID: 1 }, { ID: 2 }],
    )).resolves.toEqual({ affectedRows: 2, rowIds: ["AAABBB", "AAABBC"] });

    expect(connection.executeMany).toHaveBeenCalledWith(
      "INSERT INTO T (ID) VALUES (:ID) RETURNING ROWID INTO :DBR_RESTORE_ROWID",
      [{ ID: 1 }, { ID: 2 }],
      {
        autoCommit: false,
        bindDefs: {
          ID: { type: "DB_TYPE_NUMBER" },
          DBR_RESTORE_ROWID: { type: "DB_TYPE_ROWID", dir: "BIND_OUT", maxSize: 200 },
        },
      },
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

  it("reads driver Date values for DATE and zoned TIMESTAMP columns", async () => {
    // Would fail if temporal columns were fetched as text: node-oracledb Thin
    // mode would answer with Date.toString() instead of the session format.
    const { connector, connection, driver } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [
          { name: "LAST_LOGIN_AT", dbType: "DB_TYPE_DATE" },
          { name: "PASSWORD_CHANGED_AT", dbType: "DB_TYPE_TIMESTAMP", precision: 6 },
          { name: "SEEN_AT", dbType: "DB_TYPE_TIMESTAMP_TZ" },
        ],
        rows: [{
          LAST_LOGIN_AT: new Date(2026, 8, 1, 14, 30, 25),
          PASSWORD_CHANGED_AT: new Date(2026, 8, 1, 14, 30, 25, 123),
          SEEN_AT: new Date(2026, 8, 1, 14, 30, 25, 500),
        }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT last_login_at, password_changed_at, seen_at FROM relay_test");

    expect(result).toEqual({
      columns: ["LAST_LOGIN_AT", "PASSWORD_CHANGED_AT", "SEEN_AT"],
      unsupportedBindColumns: [],
      rows: [{
        LAST_LOGIN_AT: { year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25 },
        PASSWORD_CHANGED_AT: {
          year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
          microsecond: 123_000, tzHourOffset: 0, tzMinuteOffset: 0,
        },
        SEEN_AT: {
          year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
          microsecond: 500_000, tzHourOffset: 0, tzMinuteOffset: 0,
        },
      }],
    });
    const fetchType = queryOptions(connection).fetchTypeHandler;
    expect(fetchType({ dbType: driver.DB_TYPE_DATE })).toBeUndefined();
    expect(fetchType({ dbType: driver.DB_TYPE_TIMESTAMP })).toBeUndefined();
    expect(fetchType({ dbType: driver.DB_TYPE_TIMESTAMP_TZ })).toBeUndefined();
    expect(fetchType({ dbType: driver.DB_TYPE_NUMBER })).toEqual({ type: driver.DB_TYPE_VARCHAR });
    await session.close();
  });

  it("preserves six-digit TIMESTAMP values instead of omitting them from source rows", async () => {
    const { connector, connection, driver } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [{
          name: "HAPPENED_AT",
          dbType: "DB_TYPE_TIMESTAMP",
          precision: 6,
        }],
        rows: [{ HAPPENED_AT: "2026-09-01 14:30:25.123456" }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT happened_at FROM relay_test");

    expect(result).toEqual({
      columns: ["HAPPENED_AT"],
      unsupportedBindColumns: [],
      rows: [{
        HAPPENED_AT: {
          year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
          microsecond: 123_456, tzHourOffset: 0, tzMinuteOffset: 0,
        },
      }],
    });
    expect(sessionFormats(connection)).toEqual([
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6'",
      "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM'",
    ]);
    await session.close();
  });

  it("keeps a temporal value the session format does not describe as readable text", async () => {
    // Would fail if an unexpected DATE or TIMESTAMP rendering dropped the whole
    // column, which hides a populated value from the preview.
    const { connector } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [
          { name: "REGISTERED_AT", dbType: "DB_TYPE_DATE" },
          { name: "HAPPENED_AT", dbType: "DB_TYPE_TIMESTAMP" },
          { name: "MILLIS_AT", dbType: "DB_TYPE_TIMESTAMP" },
        ],
        rows: [{
          REGISTERED_AT: "01-SEP-26",
          HAPPENED_AT: "2026-09-01T14:30:25.123456789",
          MILLIS_AT: "2026-09-01 14:30:25.123",
        }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT registered_at, happened_at, millis_at FROM relay_test");

    expect(result).toEqual({
      columns: ["REGISTERED_AT", "HAPPENED_AT", "MILLIS_AT"],
      unsupportedBindColumns: [],
      rows: [{
        REGISTERED_AT: "01-SEP-26",
        HAPPENED_AT: {
          year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
          microsecond: 123_456, tzHourOffset: 0, tzMinuteOffset: 0,
        },
        MILLIS_AT: {
          year: 2026, month: 9, day: 1, hour: 14, minute: 30, second: 25,
          microsecond: 123_000, tzHourOffset: 0, tzMinuteOffset: 0,
        },
      }],
    });
    await session.close();
  });

  it("keeps zoned timestamp text instead of omitting the column", async () => {
    // Would fail if TIMESTAMP WITH (LOCAL) TIME ZONE columns stayed unsupported,
    // which removed them from the preview even when the row had a value.
    const { connector } = fixture({
      execute: vi.fn().mockResolvedValue({
        metaData: [
          { name: "REGISTERED_AT", dbType: "DB_TYPE_TIMESTAMP_TZ" },
          { name: "SEEN_AT", dbType: "DB_TYPE_TIMESTAMP_LTZ" },
        ],
        rows: [{
          REGISTERED_AT: "2026-09-01 14:30:25.123456 +09:00",
          SEEN_AT: "2026-09-01 14:30:25.123456 +00:00",
        }],
      }),
    });
    const session = await connector.open(profile(), "secret");

    const result = await session.query("SELECT registered_at, seen_at FROM relay_test");

    expect(result).toEqual({
      columns: ["REGISTERED_AT", "SEEN_AT"],
      unsupportedBindColumns: [],
      rows: [{
        REGISTERED_AT: "2026-09-01 14:30:25.123456 +09:00",
        SEEN_AT: "2026-09-01 14:30:25.123456 +00:00",
      }],
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

    expect(queryOptions(connection).fetchTypeHandler({ dbType: driver.DB_TYPE_NUMBER })).toEqual({
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
    // Would fail if a bind carried sub-millisecond digits the driver cannot read
    // back: the restore snapshot then never matches the row it just wrote.
    expect(convertedRows[0].HAPPENED_AT.getMilliseconds()).toBe(123);
    expect(convertedRows[0].HAPPENED_AT.getUTCMilliseconds()).toBe(123);
    await session.close();
  });

  it("binds a bigint as DB_TYPE_NUMBER", async () => {
    const { connector, connection } = fixture();
    const session = await connector.open(profile(), "secret");

    await session.executeNamed("MERGE INTO t USING :ID", [{ ID: 9_007_199_254_740_993n }]);

    expect(connection.executeMany).toHaveBeenCalledWith("MERGE INTO t USING :ID", [
      { ID: 9_007_199_254_740_993n },
    ], {
      autoCommit: false,
      bindDefs: { ID: { type: "DB_TYPE_NUMBER" } },
    });
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
    DB_TYPE_TIMESTAMP_TZ: "DB_TYPE_TIMESTAMP_TZ",
    DB_TYPE_TIMESTAMP_LTZ: "DB_TYPE_TIMESTAMP_LTZ",
    DB_TYPE_VARCHAR: "DB_TYPE_VARCHAR",
    DB_TYPE_ROWID: "DB_TYPE_ROWID",
    BIND_OUT: "BIND_OUT",
    getConnection: vi.fn().mockResolvedValue(connection),
    ...overrides,
  };
  return { connection, driver, connector: new OracleConnector(driver) };
}

// The session opens with ALTER SESSION format statements, so tests read the
// statement they care about instead of a fixed call index.
type ExecuteCall = [string, unknown, { fetchTypeHandler: (metadata: { dbType: string }) => unknown }];
type MockedConnection = { execute: { mock: { calls: unknown[][] } } };

function executeCalls(connection: MockedConnection): ExecuteCall[] {
  return connection.execute.mock.calls as ExecuteCall[];
}

function sessionFormats(connection: MockedConnection): string[] {
  return executeCalls(connection)
    .map(([sql]) => sql)
    .filter((sql) => sql.startsWith("ALTER SESSION"));
}

function queryOptions(connection: MockedConnection): ExecuteCall[2] {
  const call = executeCalls(connection).find(([sql]) => !sql.startsWith("ALTER SESSION"));
  if (call === undefined) throw new Error("no query was executed");
  return call[2];
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
