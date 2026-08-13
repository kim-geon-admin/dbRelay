import type { Connection } from "../connections/connections.types";

export type TransactionPolicy = "all_or_nothing" | "commit_successes";

export function transactionPolicyLabel(policy: TransactionPolicy): string {
  return policy === "all_or_nothing" ? "전체 롤백" : "성공 단계 커밋";
}

export type QueryOperation = "insert" | "update";

export type QueryStep = { id: string; selectSql: string; upsertSql: string; operation?: QueryOperation };

export type Flow = {
  id: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  querySteps: QueryStep[];
  transactionPolicy: TransactionPolicy;
  version: number;
};

export type FlowEditorProps = {
  connections: Connection[];
  initialFlow?: Flow;
  onSave: (flow: Flow) => void | Promise<void>;
  onCancel?: () => void;
};
