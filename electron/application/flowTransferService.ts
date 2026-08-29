import type { Flow } from "../domain/models";
import type { FlowRepository } from "./ports";

export const FLOW_TRANSFER_FORMAT = "db-relay-flow";
export const FLOW_TRANSFER_FORMAT_VERSION = 1;

export type FlowTransferFile = {
  format: typeof FLOW_TRANSFER_FORMAT;
  formatVersion: typeof FLOW_TRANSFER_FORMAT_VERSION;
  flow: Flow;
};

export interface FlowFileTransfer {
  save(file: FlowTransferFile): Promise<boolean>;
  open(): Promise<unknown | undefined>;
}

export type FlowImportResult =
  | { kind: "cancelled" }
  | { kind: "ready"; flow: Flow }
  | { kind: "needs_connection_selection"; flow: Flow };

export class FlowTransferError extends Error {
  constructor(public readonly code: "FLOW_NOT_FOUND" | "FLOW_FILE_INVALID", message: string) {
    super(message);
    this.name = "FlowTransferError";
  }
}

export class FlowTransferService {
  constructor(
    private readonly repository: FlowRepository,
    private readonly files: FlowFileTransfer,
    private readonly createId: () => string,
  ) {}

  async exportFlow(flowId: string): Promise<boolean> {
    const flow = this.repository.loadFlow(flowId);
    if (flow === undefined) {
      throw new FlowTransferError("FLOW_NOT_FOUND", "flow not found");
    }
    return this.files.save({
      format: FLOW_TRANSFER_FORMAT,
      formatVersion: FLOW_TRANSFER_FORMAT_VERSION,
      flow: structuredClone(flow),
    });
  }

  async importFlow(): Promise<FlowImportResult> {
    const file = await this.files.open();
    if (file === undefined) return { kind: "cancelled" };
    if (!isFlowTransferFile(file)) {
      throw new FlowTransferError("FLOW_FILE_INVALID", "flow file is invalid");
    }

    const imported = structuredClone(file.flow);
    const flow: Flow = {
      ...imported,
      id: this.createId(),
      version: 0,
      sourceConnectionId: this.repository.loadConnection(imported.sourceConnectionId) === undefined
        ? ""
        : imported.sourceConnectionId,
      targetConnectionId: this.repository.loadConnection(imported.targetConnectionId) === undefined
        ? ""
        : imported.targetConnectionId,
    };
    return flow.sourceConnectionId.length > 0 && flow.targetConnectionId.length > 0
      ? { kind: "ready", flow }
      : { kind: "needs_connection_selection", flow };
  }
}

function isFlowTransferFile(value: unknown): value is FlowTransferFile {
  if (!isRecord(value)
    || value.format !== FLOW_TRANSFER_FORMAT
    || value.formatVersion !== FLOW_TRANSFER_FORMAT_VERSION
    || !hasOnlyKeys(value, ["format", "formatVersion", "flow"])) {
    return false;
  }
  return isFlow(value.flow);
}

function isFlow(value: unknown): value is Flow {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "id", "name", "sourceConnectionId", "targetConnectionId", "querySteps", "transactionPolicy", "version",
    ])
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.sourceConnectionId === "string"
    && typeof value.targetConnectionId === "string"
    && Array.isArray(value.querySteps)
    && value.querySteps.every(isQueryStep)
    && (value.transactionPolicy === "all_or_nothing" || value.transactionPolicy === "commit_successes")
    && Number.isInteger(value.version)
    && typeof value.version === "number"
    && value.version >= 0;
}

function isQueryStep(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "title", "selectSql", "upsertSql"])
    && typeof value.id === "string"
    && (value.title === undefined || typeof value.title === "string")
    && typeof value.selectSql === "string"
    && typeof value.upsertSql === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
