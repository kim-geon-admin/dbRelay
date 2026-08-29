import { invokeCommand } from "../../lib/desktop";
import type { HistoryRun } from "./history.types";

export function listRunHistory(): Promise<HistoryRun[]> {
  return invokeCommand("list_run_history");
}

export function deleteRunHistory(runId: string): Promise<void> {
  return invokeCommand("delete_run_history", { request: { runId } });
}

export function clearRunHistory(): Promise<number> {
  return invokeCommand("clear_run_history").then((result) => result.deletedCount);
}
