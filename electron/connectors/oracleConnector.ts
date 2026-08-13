// node-oracledb 6.x does not publish TypeScript declarations.
// @ts-expect-error The module is constrained behind the typed adapter below.
import oracledb from "oracledb";

import { maskSensitiveText } from "../domain/errorMasking";
import { extractNamedBinds } from "../domain/mapping";
import type {
  ConnectionProfile,
  DomainValue,
  NamedRow,
  OracleDate,
  OracleTimestamp,
  Row,
} from "../domain/models";
import {
  ConnectorError,
  type DatabaseConnectorFactory,
  type DatabaseSession,
} from "./databaseConnector";

type OracleType = unknown;

interface OracleMetadata {
  name: string;
  dbType?: OracleType;
  precision?: number;
}

interface OracleResult {
  metaData?: OracleMetadata[];
  rows?: unknown[];
  rowsAffected?: number;
}

interface OracleConnection {
  execute(
    sql: string,
    binds: readonly unknown[],
    options: {
      outFormat: unknown;
      fetchTypeHandler: (metadata: OracleMetadata) => { type: OracleType } | undefined;
    },
  ): Promise<OracleResult>;
  executeMany(
    sql: string,
    rowsOrIterations: readonly Record<string, unknown>[] | number,
    options: {
      autoCommit: false;
      bindDefs: Record<string, { type: OracleType; maxSize?: number }>;
    },
  ): Promise<OracleResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface OracleDriver {
  readonly OUT_FORMAT_OBJECT: unknown;
  readonly DB_TYPE_BOOLEAN: OracleType;
  readonly DB_TYPE_DATE: OracleType;
  readonly DB_TYPE_NUMBER: OracleType;
  readonly DB_TYPE_RAW: OracleType;
  readonly DB_TYPE_TIMESTAMP: OracleType;
  readonly DB_TYPE_VARCHAR: OracleType;
  readonly DB_TYPE_BINARY_INTEGER?: OracleType;
  readonly DB_TYPE_CHAR?: OracleType;
  readonly DB_TYPE_LONG?: OracleType;
  readonly DB_TYPE_LONG_RAW?: OracleType;
  readonly DB_TYPE_NCHAR?: OracleType;
  readonly DB_TYPE_NVARCHAR?: OracleType;
  getConnection(options: {
    user: string;
    password: string;
    connectString: string;
  }): Promise<OracleConnection>;
}

const productionDriver = oracledb as OracleDriver;

export class OracleConnector implements DatabaseConnectorFactory {
  readonly kind = "oracle" as const;

  constructor(private readonly driver: OracleDriver = productionDriver) {}

  async open(profile: ConnectionProfile, secret: string): Promise<DatabaseSession> {
    if (profile.kind !== this.kind) {
      throw new ConnectorError(
        "CONNECTOR_KIND_MISMATCH",
        "connection profile is not an Oracle profile",
      );
    }
    validateDescriptorPart(profile.host, "host");
    validateDescriptorPart(profile.sid, "SID");

    try {
      const connection = await this.driver.getConnection({
        user: profile.username,
        password: secret,
        connectString: sidDescriptor(profile.host, profile.port, profile.sid),
      });
      return new OracleSession(this.driver, connection, secret);
    } catch (error) {
      throw connectorError(error, [secret]);
    }
  }
}

class OracleSession implements DatabaseSession {
  private closed = false;

  constructor(
    private readonly driver: OracleDriver,
    private readonly connection: OracleConnection,
    private readonly secret: string,
  ) {}

  async query(sql: string) {
    this.requireOpen();
    try {
      const result = await this.connection.execute(sql, [], {
        outFormat: this.driver.OUT_FORMAT_OBJECT,
        fetchTypeHandler: (metadata) => metadata.dbType === this.driver.DB_TYPE_NUMBER
          ? { type: this.driver.DB_TYPE_VARCHAR }
          : undefined,
      });
      const metadata = result.metaData ?? [];
      const omittedColumns = new Set(metadata
        .filter((column) => !isSupportedColumnType(this.driver, column))
        .map((column) => column.name));
      const unsupportedBindColumns = new Set(omittedColumns);
      const sourceRows = (result.rows ?? [])
        .map((row) => isRecord(row) ? row : Object.create(null) as Record<string, unknown>);
      for (const column of metadata) {
        if (omittedColumns.has(column.name)) {
          continue;
        }
        const convertedValues = sourceRows
          .filter((row) => row[column.name] !== undefined)
          .map((row) => convertQueryValue(row[column.name], column.dbType, this.driver));
        const hasUnrepresentableValue = convertedValues.some((value) => value === undefined);
        if (hasUnrepresentableValue) {
          omittedColumns.add(column.name);
          unsupportedBindColumns.add(column.name);
        } else if (column.dbType === this.driver.DB_TYPE_NUMBER
          && convertedValues.some((value) => typeof value === "bigint" || typeof value === "string")) {
          unsupportedBindColumns.add(column.name);
        }
      }
      const orderedUnsupportedBindColumns = metadata
        .filter((column) => unsupportedBindColumns.has(column.name))
        .map((column) => column.name);
      const rows = sourceRows.map((driverRow) =>
        convertRow(driverRow, metadata, omittedColumns, this.driver));
      return {
        columns: metadata.map((column) => column.name),
        unsupportedBindColumns: orderedUnsupportedBindColumns,
        rows,
      };
    } catch (error) {
      throw connectorError(error, [this.secret]);
    }
  }

  async begin(): Promise<void> {
    this.requireOpen();
    // Oracle starts a transaction implicitly with the first DML statement.
  }

  async executeNamed(sql: string, rows: readonly NamedRow[]): Promise<number> {
    this.requireOpen();
    if (rows.length === 0) {
      return 0;
    }

    let converted: Record<string, unknown>[];
    let bindDefs: Record<string, { type: OracleType; maxSize?: number }>;
    try {
      const bindNames = extractNamedBinds(sql);
      converted = rows.map((row) => mapBindRow(row, bindNames));
      bindDefs = buildBindDefinitions(this.driver, bindNames, rows);
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw error;
      }
      throw new ConnectorError("BIND_MAPPING", "unable to read named bind parameters");
    }

    try {
      const rowsOrIterations = Object.keys(bindDefs).length === 0
        ? rows.length
        : converted;
      const result = await this.connection.executeMany(sql, rowsOrIterations, {
        autoCommit: false,
        bindDefs,
      });
      return result.rowsAffected ?? 0;
    } catch (error) {
      // Driver batch errors may contain bind data. Retain the native Oracle
      // code, but never propagate their message across the connector boundary.
      throw connectorError(error, [this.secret], true);
    }
  }

  async commit(): Promise<void> {
    this.requireOpen();
    try {
      await this.connection.commit();
    } catch (error) {
      throw connectorError(error, [this.secret]);
    }
  }

  async rollback(): Promise<void> {
    this.requireOpen();
    try {
      await this.connection.rollback();
    } catch (error) {
      throw connectorError(error, [this.secret]);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.connection.close();
      this.closed = true;
    } catch (error) {
      throw connectorError(error, [this.secret]);
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new ConnectorError("SESSION_CLOSED", "Oracle session is closed");
    }
  }
}

function sidDescriptor(host: string, port: number, sid: string): string {
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))`
    + `(CONNECT_DATA=(SID=${sid})))`;
}

function validateDescriptorPart(value: string, label: string): void {
  if (value.length === 0 || /[()=\s]/u.test(value)) {
    throw new ConnectorError(
      "CONNECT_PROFILE_INVALID",
      `Oracle ${label} contains unsupported connect-descriptor characters`,
    );
  }
}

function convertRow(
  driverRow: unknown,
  metadata: readonly OracleMetadata[],
  unsupported: ReadonlySet<string>,
  driver: OracleDriver,
): Row {
  const source = isRecord(driverRow)
    ? driverRow
    : Object.create(null) as Record<string, unknown>;
  const row = Object.create(null) as Row;
  for (const column of metadata) {
    if (unsupported.has(column.name)) {
      continue;
    }
    const value = convertQueryValue(source[column.name], column.dbType, driver);
    if (value !== undefined) {
      row[column.name] = value;
    }
  }
  return row;
}

function convertQueryValue(
  value: unknown,
  dbType: OracleType,
  driver: OracleDriver,
): DomainValue | undefined {
  if (value === null) {
    return value;
  }
  if (dbType === driver.DB_TYPE_NUMBER) {
    if (typeof value === "string") {
      return losslessOracleNumber(value);
    }
    if (typeof value === "number") {
      return Number.isFinite(value) && Number.isSafeInteger(value) ? value : undefined;
    }
    return undefined;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    if (dbType === driver.DB_TYPE_DATE) {
      return oracleDateFromDate(value);
    }
    if (dbType === driver.DB_TYPE_TIMESTAMP) {
      return oracleTimestampFromDate(value);
    }
  }
  return undefined;
}

function losslessOracleNumber(value: string): number | bigint | string | undefined {
  const sourceCanonical = canonicalDecimal(value);
  if (sourceCanonical === undefined) {
    return undefined;
  }
  const converted = Number(value);
  if (Number.isFinite(converted)) {
    const convertedCanonical = canonicalDecimal(converted.toString());
    if (sourceCanonical === convertedCanonical) {
      return sourceCanonical.includes(".") || Number.isSafeInteger(converted)
        ? converted
        : BigInt(sourceCanonical);
    }
  }
  return sourceCanonical.includes(".") ? sourceCanonical : BigInt(sourceCanonical);
}

function canonicalDecimal(value: string): string | undefined {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(value.trim());
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) {
    return undefined;
  }
  const integer = match[2];
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    return undefined;
  }
  const digits = integer + fraction;
  const decimalPosition = integer.length + exponent;
  let expanded: string;
  if (decimalPosition <= 0) {
    expanded = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    expanded = digits + "0".repeat(decimalPosition - digits.length);
  } else {
    expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  const [wholePart, fractionPart = ""] = expanded.split(".");
  const whole = wholePart.replace(/^0+(?=\d)/u, "") || "0";
  const fractional = fractionPart.replace(/0+$/u, "");
  const unsigned = fractional === "" ? whole : `${whole}.${fractional}`;
  const isZero = /^0(?:\.0*)?$/u.test(unsigned);
  return match[1] === "-" && !isZero ? `-${unsigned}` : unsigned;
}

function isSupportedColumnType(driver: OracleDriver, metadata: OracleMetadata): boolean {
  const { dbType } = metadata;
  if (dbType === driver.DB_TYPE_TIMESTAMP
    && metadata.precision !== undefined
    && metadata.precision > 3) {
    return false;
  }
  return [
    driver.DB_TYPE_BOOLEAN,
    driver.DB_TYPE_DATE,
    driver.DB_TYPE_NUMBER,
    driver.DB_TYPE_RAW,
    driver.DB_TYPE_TIMESTAMP,
    driver.DB_TYPE_VARCHAR,
    driver.DB_TYPE_BINARY_INTEGER,
    driver.DB_TYPE_CHAR,
    driver.DB_TYPE_LONG,
    driver.DB_TYPE_LONG_RAW,
    driver.DB_TYPE_NCHAR,
    driver.DB_TYPE_NVARCHAR,
  ].some((supported) => supported !== undefined && supported === dbType);
}

function oracleDateFromDate(value: Date): OracleDate {
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
    hour: value.getHours(),
    minute: value.getMinutes(),
    second: value.getSeconds(),
  };
}

function oracleTimestampFromDate(value: Date): OracleTimestamp {
  return {
    ...oracleDateFromDate(value),
    microsecond: value.getMilliseconds() * 1_000,
    tzHourOffset: 0,
    tzMinuteOffset: 0,
  };
}

function mapBindRow(row: NamedRow, bindNames: readonly string[]): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const bindName of bindNames) {
    const match = Object.entries(row).find(([name]) =>
      name.toUpperCase() === bindName.toUpperCase());
    if (match === undefined) {
      throw new ConnectorError(
        "BIND_MAPPING",
        `missing named bind parameter ${bindName}`,
      );
    }
    result[bindName] = toOracleBindValue(match[1]);
  }
  return result;
}

function buildBindDefinitions(
  driver: OracleDriver,
  bindNames: readonly string[],
  rows: readonly NamedRow[],
): Record<string, { type: OracleType; maxSize?: number }> {
  const definitions = Object.create(null) as Record<
    string,
    { type: OracleType; maxSize?: number }
  >;
  for (const bindName of bindNames) {
    const values = rows.map((row) => {
      const entry = Object.entries(row).find(([name]) =>
        name.toUpperCase() === bindName.toUpperCase());
      if (entry === undefined) {
        throw new ConnectorError(
          "BIND_MAPPING",
          `missing named bind parameter ${bindName}`,
        );
      }
      return entry[1];
    });
    definitions[bindName] = bindDefinition(driver, values);
  }
  return definitions;
}

function bindDefinition(
  driver: OracleDriver,
  values: readonly DomainValue[],
): { type: OracleType; maxSize?: number } {
  const nonNull = values.filter((value) => value !== null);
  if (nonNull.length === 0) {
    return { type: driver.DB_TYPE_VARCHAR, maxSize: 1 };
  }
  const kinds = new Set(nonNull.map(bindKind));
  if (kinds.size !== 1 || kinds.has("unsupported")) {
    throw new ConnectorError(
      "BIND_TYPE_UNSUPPORTED",
      "Oracle batch bind values must have one supported type per named parameter",
    );
  }
  switch ([...kinds][0]) {
    case "string":
      return {
        type: driver.DB_TYPE_VARCHAR,
        maxSize: Math.max(1, ...nonNull.map((value) =>
          Buffer.byteLength(value as string, "utf8"))),
      };
    case "number":
      return { type: driver.DB_TYPE_NUMBER };
    case "boolean":
      return { type: driver.DB_TYPE_BOOLEAN };
    case "date":
      return { type: driver.DB_TYPE_DATE };
    case "timestamp":
      return { type: driver.DB_TYPE_TIMESTAMP };
    case "bytes":
      return {
        type: driver.DB_TYPE_RAW,
        maxSize: Math.max(1, ...nonNull.map((value) =>
          (value as Uint8Array).byteLength)),
      };
    default:
      throw new ConnectorError("BIND_TYPE_UNSUPPORTED", "unsupported Oracle bind type");
  }
}

function bindKind(value: DomainValue): string {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "bigint") return "unsupported";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Uint8Array) return "bytes";
  if (isOracleTimestamp(value)) return "timestamp";
  if (isOracleDate(value)) return "date";
  return "unsupported";
}

function toOracleBindValue(value: DomainValue): unknown {
  if (isOracleTimestamp(value)) {
    if (value.tzHourOffset !== 0 || value.tzMinuteOffset !== 0) {
      throw new ConnectorError(
        "BIND_TYPE_UNSUPPORTED",
        "timestamp with timezone values are unsupported by the Oracle batch driver",
      );
    }
    return structuredTimestamp(value);
  }
  if (isOracleDate(value)) {
    return structuredDate(value, 0);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ConnectorError("BIND_TYPE_UNSUPPORTED", "non-finite Oracle numbers are unsupported");
  }
  return value;
}

function structuredDate(value: OracleDate, millisecond: number): Date {
  if (!Number.isInteger(millisecond) || millisecond < 0 || millisecond > 999) {
    throw new ConnectorError(
      "BIND_TYPE_UNSUPPORTED",
      "Oracle timestamp precision exceeds the JavaScript driver representation",
    );
  }
  const result = new Date(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    millisecond,
  );
  validateStructuredDate(value, result);
  return result;
}

function structuredTimestamp(value: OracleTimestamp): Date {
  if (value.microsecond < 0 || value.microsecond > 999_999) {
    throw new ConnectorError("BIND_TYPE_UNSUPPORTED", "invalid Oracle timestamp precision");
  }
  const result = new PreciseOracleTimestampDate(value);
  validateStructuredDate(value, result);
  return result;
}

function validateStructuredDate(value: OracleDate, result: Date): void {
  const roundTrip = oracleDateFromDate(result);
  if (Object.entries(roundTrip).some(([key, part]) =>
    value[key as keyof OracleDate] !== part)) {
    throw new ConnectorError("BIND_TYPE_UNSUPPORTED", "invalid structured Oracle date");
  }
}

class PreciseOracleTimestampDate extends Date {
  private readonly oracleMicrosecond: number;

  constructor(value: OracleTimestamp) {
    super(
      value.year,
      value.month - 1,
      value.day,
      value.hour,
      value.minute,
      value.second,
      Math.floor(value.microsecond / 1_000),
    );
    this.oracleMicrosecond = value.microsecond;
  }

  override getUTCMilliseconds(): number {
    // node-oracledb Thin mode multiplies this accessor by 1_000_000 when
    // encoding TIMESTAMP fractional seconds, so a fractional millisecond
    // preserves the domain model's full six-digit microsecond value.
    return this.oracleMicrosecond / 1_000;
  }
}

function isOracleDate(value: DomainValue): value is OracleDate {
  return isRecord(value)
    && ["year", "month", "day", "hour", "minute", "second"]
      .every((key) => Number.isInteger(value[key]));
}

function isOracleTimestamp(value: DomainValue): value is OracleTimestamp {
  return isOracleDate(value)
    && "microsecond" in value
    && Number.isInteger(value.microsecond)
    && "tzHourOffset" in value
    && Number.isInteger(value.tzHourOffset)
    && "tzMinuteOffset" in value
    && Number.isInteger(value.tzMinuteOffset);
}

function connectorError(
  error: unknown,
  secrets: readonly string[],
  redactDriverMessage = false,
): ConnectorError {
  if (error instanceof ConnectorError) {
    return error;
  }
  const code = oracleErrorCode(error);
  const message = redactDriverMessage
    ? `[REDACTED] (${code})`
    : maskSensitiveText(errorMessage(error), secrets);
  return new ConnectorError(code, message, isRetryable(error, code));
}

function oracleErrorCode(error: unknown): string {
  const errorNumber = isRecord(error) && typeof error.errorNum === "number"
    ? Math.abs(Math.trunc(error.errorNum))
    : undefined;
  if (errorNumber !== undefined) {
    return `ORA-${String(errorNumber).padStart(5, "0")}`;
  }
  const candidates = [
    isRecord(error) && typeof error.code === "string" ? error.code : "",
    errorMessage(error),
  ];
  for (const candidate of candidates) {
    const match = /ORA-(\d{1,5})/iu.exec(candidate);
    if (match !== null) {
      return `ORA-${match[1].padStart(5, "0")}`;
    }
  }
  return "ORACLE";
}

function isRetryable(error: unknown, code: string): boolean {
  if (isRecord(error) && error.isRecoverable === true) {
    return true;
  }
  return new Set([
    "ORA-03113", "ORA-03114", "ORA-12170", "ORA-12537", "ORA-12541",
    "ORA-12543", "ORA-12545",
  ]).has(code);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Oracle database operation failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
