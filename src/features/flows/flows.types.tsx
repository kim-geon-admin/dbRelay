import type { Connection } from "../connections/connections.types";
import type { PreviewFlowStepDto } from "../../lib/desktop";
import type { ImportFlowResultDto } from "../../lib/desktop";

export type TransactionPolicy = "all_or_nothing" | "commit_successes";

export function transactionPolicyLabel(policy: TransactionPolicy): string {
  return policy === "all_or_nothing" ? "전체 롤백" : "성공한 부분까지 커밋";
}

export type QueryOperation = "insert" | "update" | "upsert";

export type QueryStep = { id: string; title?: string; selectSql: string; upsertSql: string; operation?: QueryOperation };

export type PreviewFlowStepInput = { sourceConnectionId: string; selectSql: string };
export type RunFlowStepInput = PreviewFlowStepInput & {
  targetConnectionId: string;
  upsertSql: string;
  previewId?: string;
  editorSessionId?: string;
  stepId?: string;
};
export type StepPreview = PreviewFlowStepDto;

export type Flow = {
  id: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  querySteps: QueryStep[];
  transactionPolicy: TransactionPolicy;
  version: number;
};

export type ImportFlowResult = ImportFlowResultDto;

export type FlowEditorProps = {
  connections: Connection[];
  initialFlow?: Flow;
  onSave: (flow: Flow) => void | Promise<void>;
  onCancel?: () => void;
};
