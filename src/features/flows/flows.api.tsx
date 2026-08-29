import { invokeCommand } from "../../lib/desktop";
import type { Flow, ImportFlowResult, PreviewFlowStepInput, RunFlowStepInput, StepPreview } from "./flows.types";

export function listFlows(): Promise<Flow[]> { return invokeCommand("list_flows"); }

export function saveFlow(input: Flow): Promise<Flow> {
  return invokeCommand("save_flow", { request: input });
}

export function duplicateFlow(id: string): Promise<Flow> {
  const duplicateId = globalThis.crypto?.randomUUID?.() ?? `flow-${Date.now()}`;
  return invokeCommand("duplicate_flow", { request: { flowId: id, duplicateId } });
}

export function exportFlow(id: string): Promise<{ exported: boolean }> {
  return invokeCommand("export_flow", { request: { flowId: id } });
}

export function deleteFlow(id: string): Promise<void> {
  return invokeCommand("delete_flow", { request: { flowId: id } });
}

export function importFlow(): Promise<ImportFlowResult> {
  return invokeCommand("import_flow");
}

export function previewFlowStep(input: PreviewFlowStepInput): Promise<StepPreview> {
  return invokeCommand("preview_flow_step", { request: input });
}

export function saveEditedPreview(input: Pick<StepPreview, "previewId" | "columns" | "rows">): Promise<void> {
  return invokeCommand("save_edited_preview", { request: input });
}

export function discardEditedPreview(previewId: string): Promise<void> {
  return invokeCommand("discard_edited_preview", { request: { previewId } });
}

export function runFlowStep(input: RunFlowStepInput): Promise<{ affectedRows: number; restoreId?: string }> {
  return invokeCommand("run_flow_step", { request: input });
}
export function restoreFlowStep(restoreId: string): Promise<{ affectedRows: number }> { return invokeCommand("restore_flow_step", { request: { restoreId } }); }
export function discardStepRestore(restoreId: string): Promise<void> { return invokeCommand("discard_step_restore", { request: { restoreId } }); }
