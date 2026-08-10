import { invokeCommand } from "../../lib/desktop";
import type { Flow } from "./flows.types";

export function listFlows(): Promise<Flow[]> { return invokeCommand("list_flows"); }

export function saveFlow(input: Flow): Promise<Flow> {
  return invokeCommand("save_flow", { request: input });
}

export function duplicateFlow(id: string): Promise<Flow> {
  const duplicateId = globalThis.crypto?.randomUUID?.() ?? `flow-${Date.now()}`;
  return invokeCommand("duplicate_flow", { request: { flowId: id, duplicateId } });
}
