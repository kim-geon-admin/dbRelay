import type {
  RunEvent,
  RunStatus,
  StepStatus,
  TransactionPolicy,
} from "../domain/models";
import type { HistoryRepository } from "./ports";

export interface HistoryRunDto {
  runId: string;
  flowId: string;
  flowName: string;
  sourceDbName: string;
  targetDbName: string;
  flowVersion: number;
  stepTitles: string[];
  startedAt: number;
  endedAt: number | null;
  policy: TransactionPolicy;
  status: RunStatus;
  steps: StepStatus[];
  events: RunEvent[];
}

export class HistoryService {
  constructor(private readonly history: Pick<HistoryRepository, "listRuns" | "deleteRun" | "clearRuns">) {}

  async listRunHistory(): Promise<HistoryRunDto[]> {
    return this.history.listRuns().map((run) => ({
      runId: run.runId,
      flowId: run.flowId ?? "",
      flowName: run.flowName ?? run.flowId ?? "",
      sourceDbName: run.sourceDbName ?? "",
      targetDbName: run.targetDbName ?? "",
      flowVersion: run.flowVersion ?? 0,
      stepTitles: run.stepTitles ?? [],
      startedAt: run.startedAtMs,
      endedAt: run.endedAtMs ?? null,
      policy: run.state.policy(),
      status: run.state.status(),
      steps: run.state.steps().map((step) => step.status),
      events: [...run.state.events()],
    }));
  }

  async deleteRunHistory(runId: string): Promise<void> {
    this.history.deleteRun(runId);
  }

  async clearRunHistory(): Promise<number> { return this.history.clearRuns(); }
}
