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
  flowVersion: number;
  startedAt: number;
  endedAt: number | null;
  policy: TransactionPolicy;
  status: RunStatus;
  steps: StepStatus[];
  events: RunEvent[];
}

export class HistoryService {
  constructor(private readonly history: Pick<HistoryRepository, "listRuns">) {}

  async listRunHistory(): Promise<HistoryRunDto[]> {
    return this.history.listRuns().map((run) => ({
      runId: run.runId,
      flowId: run.flowId ?? "",
      flowVersion: run.flowVersion ?? 0,
      startedAt: run.startedAtMs,
      endedAt: run.endedAtMs ?? null,
      policy: run.state.policy(),
      status: run.state.status(),
      steps: run.state.steps().map((step) => step.status),
      events: [...run.state.events()],
    }));
  }
}
