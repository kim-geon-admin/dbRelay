import type { Connection } from "../connections/connections.types";

export type TransactionPolicy = "all_or_nothing" | "commit_successes";

export type QueryStep = { id: string; selectSql: string; upsertSql: string };

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
};

