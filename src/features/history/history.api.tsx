import { invokeCommand } from "../../lib/desktop";
import type { HistoryRun } from "./history.types";

export function listRunHistory(): Promise<HistoryRun[]> {
  return invokeCommand("list_run_history");
}
