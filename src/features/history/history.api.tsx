import { invokeCommand } from "../../lib/tauri";
import type { HistoryRun } from "./history.types";

export function listRunHistory(): Promise<HistoryRun[]> {
  return invokeCommand("list_run_history");
}
