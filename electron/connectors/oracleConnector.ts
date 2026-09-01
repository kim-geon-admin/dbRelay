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
  type TargetColumnKind,
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
  outBinds?: Array<Record<string, unknown>>;
}

interface OracleBindDefinition {
  type: OracleType;
  maxSize?: number;
  dir?: unknown;
}

interface OracleConnection {
  execute(
    sql: string,
    binds: unknown,
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
      bindDefs: Record<string, OracleBindDefinition>;
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
  readonly DB_TYPE_ROWID?: OracleType;
  readonly BIND_OUT?: unknown;
  readonly DB_TYPE_BINARY_INTEGER?: OracleType;
  readonly DB_TYPE_CHAR?: OracleType;
  readonly DB_TYPE_LONG?: OracleType;
  readonly DB_TYPE_LONG_RAW?: OracleType;
  readonly DB_TYPE_NCHAR?: OracleType;
  readonly DB_TYPE_NVARCHAR?: OracleType;
  readonly DB_TYPE_TIMESTAMP_TZ?: OracleType;
  readonly DB_TYPE_TIMESTAMP_LTZ?: OracleType;
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
    validateDescriptorPart(profile.sid, "service name");

    try {
      const connectionOptions = {
        user: profile.username,
        password: secret,
        connectString: serviceNameConnectString(profile.host, profile.port, profile.sid),
      };
      let connection: OracleConnection;
      try {
        connection = await this.driver.getConnection(connectionOptions);
      } catch (error) {
        if (!shouldRetryWithSid(error)) throw error;
        connection = await this.driver.getConnection({
          ...connectionOptions,
          connectString: sidDescriptor(profile.host, profile.port, profile.sid),
        });
      }
      return new OracleSession(this.driver, connection, secret);
    } catch (error) {
      throw connectorError(error, [secret]);
    }
  }
}

class OracleSession implements DatabaseSession {
  private closed = false;
  private temporalFormatsConfigured = false;

  constructor(
    private readonly driver: OracleDriver,
    private readonly connection: OracleConnection,
    private readonly secret: string,
  ) {}

  async query(sql: string) {
    return this.queryWithBinds(sql, []);
  }

  async queryNamed(sql: string, rows: readonly NamedRow[]) {
    if (rows.length === 0) return { columns: [], rows: [], unsupportedBindColumns: [] };
    const bindNames = extractNamedBinds(sql);
    const results = await Promise.all(rows.map((row) => this.queryWithBinds(sql, mapBindRow(row, bindNames))));
    return {
      columns: results[0]?.columns ?? [],
      rows: results.flatMap((result) => result.rows),
      unsupportedBindColumns: results[0]?.unsupportedBindColumns ?? [],
    };
  }

  async describeTargetColumns(
    table: string,
    columns: readonly string[],
  ): Promise<Record<string, TargetColumnKind>> {
    this.requireOpen();
    const tableName = dictionaryIdentifier(table);
    const columnNames = uniqueDictionaryIdentifiers(columns);
    if (tableName === undefined || columnNames === undefined || columnNames.length === 0) {
      return {};
    }
    try {
      const userColumns = await this.queryTargetColumns("USER_TAB_COLUMNS", tableName, columnNames);
      const userKinds = completeTargetColumnKinds(userColumns, columnNames);
      if (userKinds !== undefined) return userKinds;

      const allColumns = await this.queryTargetColumns("ALL_TAB_COLUMNS", tableName, columnNames);
      return completeTargetColumnKinds(allColumns, columnNames) ?? {};
    } catch (error) {
      throw connectorError(error, [this.secret]);
    }
  }

  private async queryTargetColumns(
    dictionary: "USER_TAB_COLUMNS" | "ALL_TAB_COLUMNS",
    tableName: string,
    columnNames: readonly string[],
  ): Promise<unknown[]> {
    const binds = Object.fromEntries([
      ["TABLE_NAME", tableName],
      ...columnNames.map((column, index) => [`COLUMN_${index}`, column]),
    ]);
    const placeholders = columnNames.map((_, index) => `:COLUMN_${index}`).join(", ");
    const result = await this.connection.execute(
      `SELECT COLUMN_NAME, DATA_TYPE FROM ${dictionary} WHERE TABLE_NAME = :TABLE_NAME AND COLUMN_NAME IN (${placeholders})`,
      binds,
      {
        outFormat: this.driver.OUT_FORMAT_OBJECT,
        fetchTypeHandler: () => undefined,
      },
    );
    return result.rows ?? [];
  }

  private async queryWithBinds(sql: string, binds: unknown) {
    this.requireOpen();
    try {
      await this.configureTemporalFormats();
      const result = await this.connection.execute(sql, binds, {
        outFormat: this.driver.OUT_FORMAT_OBJECT,
        fetchTypeHandler: (metadata) => isTextFetchedColumnType(this.driver, metadata.dbType)
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
    // Text binds reach a temporal column through an implicit conversion, so the
    // target session needs the same formats the preview was rendered with.
    await this.configureTemporalFormats();

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

  private async configureTemporalFormats(): Promise<void> {
    if (this.temporalFormatsConfigured) return;
    this.temporalFormatsConfigured = true;
    for (const format of [
      "NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6'",
      "NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM'",
    ]) {
      await this.connection.execute(
        `ALTER SESSION SET ${format}`,
        [],
        { outFormat: this.driver.OUT_FORMAT_OBJECT, fetchTypeHandler: () => undefined },
      );
    }
  }

  async executeNamedReturningRowIds(
    sql: string,
    rows: readonly NamedRow[],
  ): Promise<{ affectedRows: number; rowIds: string[] }> {
    this.requireOpen();
    if (rows.length === 0) return { affectedRows: 0, rowIds: [] };
    if (this.driver.DB_TYPE_ROWID === undefined || this.driver.BIND_OUT === undefined) {
      throw new ConnectorError("RETURNING_UNSUPPORTED", "Oracle ROWID returning is not available");
    }

    const outputBind = "DBR_RESTORE_ROWID";
    let converted: Record<string, unknown>[];
    let bindDefs: Record<string, OracleBindDefinition>;
    try {
      const bindNames = extractNamedBinds(sql);
      if (!bindNames.some((name) => name.toUpperCase() === outputBind)) {
        throw new ConnectorError("RETURNING_INVALID", "ROWID output bind was not found");
      }
      const inputBindNames = bindNames.filter((name) => name.toUpperCase() !== outputBind);
      converted = rows.map((row) => mapBindRow(row, inputBindNames));
      bindDefs = buildBindDefinitions(this.driver, inputBindNames, rows);
      bindDefs[outputBind] = {
        type: this.driver.DB_TYPE_ROWID,
        dir: this.driver.BIND_OUT,
        maxSize: 200,
      };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("BIND_MAPPING", "unable to read named bind parameters");
    }

    try {
      const result = await this.connection.executeMany(sql, converted, {
        autoCommit: false,
        bindDefs,
      });
      return {
        affectedRows: result.rowsAffected ?? 0,
        rowIds: returnedRowIds(result.outBinds, outputBind),
      };
    } catch (error) {
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

function serviceNameConnectString(host: string, port: number, serviceName: string): string {
  return `${host}:${port}/${serviceName}`;
}

function shouldRetryWithSid(error: unknown): boolean {
  return new Set(["ORA-12505", "ORA-12514"]).has(oracleErrorCode(error));
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
  // A session format the parser does not recognise keeps the raw text: the
  // preview shows the value instead of dropping the whole column.
  if (dbType === driver.DB_TYPE_DATE && typeof value === "string") {
    return oracleDateFromString(value) ?? value;
  }
  if (dbType === driver.DB_TYPE_TIMESTAMP && typeof value === "string") {
    return oracleTimestampFromString(value) ?? value;
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
    // A zoned column arrives as the same instant in the local zone: the driver
    // has already resolved its offset, so it is read like a plain timestamp.
    if (dbType === driver.DB_TYPE_TIMESTAMP
      || dbType === driver.DB_TYPE_TIMESTAMP_TZ
      || dbType === driver.DB_TYPE_TIMESTAMP_LTZ) {
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

function completeTargetColumnKinds(
  rows: readonly unknown[],
  columnNames: readonly string[],
): Record<string, TargetColumnKind> | undefined {
  const result: Record<string, TargetColumnKind> = {};
  for (const columnName of columnNames) {
    const matchingKinds = rows.flatMap((row) => {
      if (!isRecord(row) || row.COLUMN_NAME !== columnName || typeof row.DATA_TYPE !== "string") {
        return [];
      }
      return [oracleTargetColumnKind(row.DATA_TYPE)];
    });
    if (matchingKinds.length !== 1) return undefined;
    result[columnName] = matchingKinds[0];
  }
  return result;
}

function oracleTargetColumnKind(dataType: string): TargetColumnKind {
  return new Set(["NUMBER", "FLOAT", "BINARY_FLOAT", "BINARY_DOUBLE"])
    .has(dataType.trim().toUpperCase())
    ? "numeric"
    : "text";
}

function uniqueDictionaryIdentifiers(values: readonly string[]): string[] | undefined {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const identifier = dictionaryIdentifier(value);
    if (identifier === undefined) return undefined;
    if (!seen.has(identifier)) {
      seen.add(identifier);
      result.push(identifier);
    }
  }
  return result;
}

function dictionaryIdentifier(value: string): string | undefined {
  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    let part = "";
    if (value[index] === '"') {
      index += 1;
      while (index < value.length) {
        if (value[index] !== '"') {
          part += value[index];
          index += 1;
        } else if (value[index + 1] === '"') {
          part += '"';
          index += 2;
        } else {
          index += 1;
          break;
        }
      }
      if (part === "" || value[index - 1] !== '"') return undefined;
    } else {
      const match = /^[\p{L}_][\p{L}\p{M}\p{Nd}_$#]*/u.exec(value.slice(index));
      if (match === null) return undefined;
      part = match[0].toUpperCase();
      index += part.length;
    }
    parts.push(part);
    if (index === value.length) break;
    if (value[index] !== ".") return undefined;
    index += 1;
    if (index === value.length) return undefined;
  }
  return parts[parts.length - 1];
}

function isSupportedColumnType(driver: OracleDriver, metadata: OracleMetadata): boolean {
  const { dbType } = metadata;
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
    driver.DB_TYPE_ROWID,
    driver.DB_TYPE_TIMESTAMP_TZ,
    driver.DB_TYPE_TIMESTAMP_LTZ,
  ].some((supported) => supported !== undefined && supported === dbType);
}

// Only NUMBER: node-oracledb Thin mode holds NUMBER as text internally, so
// asking for a string keeps every digit. Temporal columns are decoded into a
// JavaScript Date first, and a string fetch would only run Date.toString() on
// it ("Tue Sep 01 2026 14:00:22 GMT+0900"), losing the session format.
function isTextFetchedColumnType(driver: OracleDriver, dbType: OracleType): boolean {
  return dbType === driver.DB_TYPE_NUMBER;
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

// The session formats set by configureTemporalFormats, plus the ISO-like
// variants another session setting can produce: the separator may be a space or
// T, the time and fraction may be absent, the fraction may hold one to nine
// digits, and a zone offset may follow.
const temporalText =
  /^(\d{4,5})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/u;

function temporalPartsFromString(
  value: string,
): { date: OracleDate; fraction: string; zone?: string } | undefined {
  const match = temporalText.exec(value.trim());
  if (match === null) return undefined;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const [hour, minute, second] = match.slice(4, 7)
    .map((part) => part === undefined ? 0 : Number(part));
  const date = { year, month, day, hour, minute, second };
  if (!isRepresentableDate(date)) return undefined;
  return { date, fraction: match[7] ?? "", ...(match[8] === undefined ? {} : { zone: match[8] }) };
}

function isRepresentableDate(value: OracleDate): boolean {
  const candidate = new Date(
    value.year, value.month - 1, value.day, value.hour, value.minute, value.second,
  );
  return candidate.getFullYear() === value.year
    && candidate.getMonth() === value.month - 1
    && candidate.getDate() === value.day
    && candidate.getHours() === value.hour
    && candidate.getMinutes() === value.minute
    && candidate.getSeconds() === value.second;
}

function oracleDateFromString(value: string): OracleDate | undefined {
  return temporalPartsFromString(value)?.date;
}

function oracleTimestampFromString(value: string): OracleTimestamp | undefined {
  const parts = temporalPartsFromString(value);
  if (parts === undefined) return undefined;
  return {
    ...parts.date,
    microsecond: parts.fraction === "" ? 0 : Number(parts.fraction.padEnd(6, "0").slice(0, 6)),
    ...zoneOffset(parts.zone),
  };
}

function zoneOffset(zone: string | undefined): { tzHourOffset: number; tzMinuteOffset: number } {
  if (zone === undefined || zone === "Z") return { tzHourOffset: 0, tzMinuteOffset: 0 };
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return {
    tzHourOffset: sign * Number(digits.slice(0, 2)),
    tzMinuteOffset: sign * Number(digits.slice(2, 4)),
  };
}

function returnedRowIds(
  outBinds: readonly Record<string, unknown>[] | undefined,
  outputBind: string,
): string[] {
  if (outBinds === undefined) return [];
  return outBinds.flatMap((entry) => {
    const value = Object.entries(entry).find(([name]) =>
      name.toUpperCase() === outputBind.toUpperCase())?.[1];
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
  });
}

function buildBindDefinitions(
  driver: OracleDriver,
  bindNames: readonly string[],
  rows: readonly NamedRow[],
): Record<string, OracleBindDefinition> {
  const definitions = Object.create(null) as Record<
    string,
    OracleBindDefinition
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
    definitions[bindName] = bindDefinition(driver, bindName, values);
  }
  return definitions;
}

function bindDefinition(
  driver: OracleDriver,
  bindName: string,
  values: readonly DomainValue[],
): { type: OracleType; maxSize?: number } {
  const nonNull = values.filter((value) => value !== null);
  if (nonNull.length === 0) {
    return { type: driver.DB_TYPE_VARCHAR, maxSize: 1 };
  }
  const kinds = new Set(nonNull.map(bindKind));
  if (kinds.size !== 1) {
    throw new ConnectorError(
      "BIND_TYPE_UNSUPPORTED",
      `bind-type-unsupported:${bindName}:mixed`,
    );
  }
  if (kinds.has("unsupported")) {
    throw new ConnectorError("BIND_TYPE_UNSUPPORTED", `bind-type-unsupported:${bindName}:large_integer`);
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
  if (typeof value === "bigint") return "number";
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

// The driver decodes a fetched TIMESTAMP into a JavaScript Date, so a value is
// only ever read back at millisecond resolution. Binding at the same resolution
// keeps a written row equal to the row the next read reports, which is what the
// restore snapshot compares against.
function structuredTimestamp(value: OracleTimestamp): Date {
  if (value.microsecond < 0 || value.microsecond > 999_999) {
    throw new ConnectorError("BIND_TYPE_UNSUPPORTED", "invalid Oracle timestamp precision");
  }
  const result = structuredDate(value, Math.floor(value.microsecond / 1_000));
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
