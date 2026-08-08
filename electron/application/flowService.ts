import type { ConnectionProfile, Flow } from "../domain/models";
import {
  SqlValidationError,
  validateSourceStatement,
  validateTargetStatement,
} from "../domain/sqlValidation";
import type { FlowRepository } from "./ports";

export type { FlowRepository } from "./ports";

export class FlowServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FlowServiceError";
  }
}

export class FlowService {
  constructor(private readonly repository: FlowRepository) {}

  async saveFlow(flow: Flow): Promise<Flow> {
    validateFlow(flow);
    if (flow.sourceConnectionId === flow.targetConnectionId) {
      throw new FlowServiceError(
        "CONNECTIONS_NOT_DISTINCT",
        "source and target connections must be different",
      );
    }
    if (this.repository.loadConnection(flow.sourceConnectionId) === undefined) {
      throw new FlowServiceError(
        "CONNECTION_NOT_FOUND",
        "source connection was not found",
      );
    }
    if (this.repository.loadConnection(flow.targetConnectionId) === undefined) {
      throw new FlowServiceError(
        "CONNECTION_NOT_FOUND",
        "target connection was not found",
      );
    }
    this.repository.saveFlow(flow);
    const saved = this.repository.loadFlow(flow.id);
    if (saved === undefined) {
      throw new FlowServiceError("FLOW_NOT_FOUND", "flow could not be reloaded");
    }
    return saved;
  }

  async listFlows(): Promise<Flow[]> {
    return this.repository.listFlows();
  }

  async duplicateFlow(flowId: string, duplicateId: string): Promise<Flow> {
    validateRequired(flowId, "flow ID");
    validateRequired(duplicateId, "duplicate flow ID");
    if (this.repository.loadFlow(duplicateId) !== undefined) {
      throw new FlowServiceError("FLOW_ALREADY_EXISTS", "flow ID already exists");
    }
    const source = this.repository.loadFlow(flowId);
    if (source === undefined) {
      throw new FlowServiceError("FLOW_NOT_FOUND", "flow not found");
    }
    return this.saveFlow({
      ...structuredClone(source),
      id: duplicateId,
      name: `${source.name} copy`,
    });
  }
}

function validateFlow(flow: Flow): void {
  validateRequired(flow.id, "flow ID");
  validateRequired(flow.name, "flow name");
  validateRequired(flow.sourceConnectionId, "source connection ID");
  validateRequired(flow.targetConnectionId, "target connection ID");
  if (flow.querySteps.length === 0) {
    throw new FlowServiceError("VALIDATION", "at least one query step is required");
  }
  for (const step of flow.querySteps) {
    validateRequired(step.id, "query step ID");
    validateRequired(step.selectSql, "source SQL");
    validateRequired(step.upsertSql, "target SQL");
    try {
      validateSourceStatement(step.selectSql);
      validateTargetStatement("oracle", step.upsertSql);
    } catch (error) {
      if (error instanceof SqlValidationError) {
        throw new FlowServiceError("VALIDATION", error.message);
      }
      throw error;
    }
  }
}

function validateRequired(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new FlowServiceError("VALIDATION", `${label} is required`);
  }
}
