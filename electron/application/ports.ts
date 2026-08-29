import type { ConnectionProfile, Flow } from "../domain/models";
import type { RunState } from "../domain/runState";

export interface ConnectionRepository {
  loadConnection(connectionId: string): ConnectionProfile | undefined;
  loadRunnableConnection(connectionId: string): ConnectionProfile | undefined;
  saveConnection(profile: ConnectionProfile): void;
  updateConnection(profile: ConnectionProfile): void;
  listConnections(): ConnectionProfile[];
  disableConnection(connectionId: string): void;
  deleteConnection(connectionId: string): void;
}

export interface FlowRepository extends Pick<
  ConnectionRepository,
  "loadConnection" | "loadRunnableConnection"
> {
  loadFlow(flowId: string): Flow | undefined;
  saveFlow(flow: Flow): void;
  deleteFlow(flowId: string): void;
  listFlows(): Flow[];
}

export interface RunBinding {
  flow: Flow;
  sourceProfile: ConnectionProfile;
  targetProfile: ConnectionProfile;
}

export interface RunHistoryEntry {
  runId: string;
  flowId?: string;
  flowName?: string;
  sourceDbName?: string;
  targetDbName?: string;
  flowVersion?: number;
  stepTitles?: string[];
  startedAtMs: number;
  endedAtMs?: number;
  state: RunState;
}

export type BoundRecoveryApply =
  | "applied"
  | "configuration_changed"
  | "recovery_no_longer_available";

export interface HistoryRepository {
  createRun(runId: string, state: RunState): void;
  createRunForFlow(runId: string, state: RunState, flow: Flow): void;
  createBoundRun(runId: string, state: RunState, binding: RunBinding): void;
  appendRun(runId: string, state: RunState): void;
  appendBoundRun(runId: string, state: RunState, binding: RunBinding): void;
  loadRun(runId: string): RunState | undefined;
  listRuns(): RunHistoryEntry[];
  deleteRun(runId: string): boolean;
  clearRuns(): number;
  loadRunBinding(runId: string): RunBinding | undefined;
  applyBoundRecovery(
    runId: string,
    state: RunState,
    expectedState: RunState,
    expectedBinding: RunBinding,
    persistedBinding: RunBinding,
    updatedFlow?: Flow,
  ): BoundRecoveryApply;
}
