import { useState } from "react";
import { formatConnectorError } from "../../lib/oracleErrors";
import { previewFlowStep, runFlowStep } from "./flows.api";
import { StepPreviewDialog } from "./StepPreviewDialog";
import type { QueryOperation, QueryStep, StepPreview } from "./flows.types";
import { generateTargetSql, targetOperationForSql, type TargetOperation } from "./sqlGeneration";

type QueryStepEditorProps = {
  step: QueryStep;
  position: number;
  total: number;
  sourceConnectionId?: string;
  targetConnectionId?: string;
  onChange: (step: QueryStep) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
};

function extractBinds(sql: string) {
  const seen = new Set<string>();
  const binds: string[] = [];
  let index = 0;
  const isStart = (value: string) => /[A-Za-z_]/.test(value);
  const isContinue = (value: string) => /[A-Za-z0-9_$#]/.test(value);

  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] !== quote) { index += 1; continue; }
        index += sql[index + 1] === quote ? 2 : 1;
        break;
      }
    } else if (character === "-" && sql[index + 1] === "-") {
      index = sql.indexOf("\n", index + 2);
      if (index === -1) break;
    } else if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (character === ":" && isStart(sql[index + 1] ?? "")) {
      let end = index + 2;
      while (isContinue(sql[end] ?? "")) end += 1;
      const bind = sql.slice(index + 1, end);
      const key = bind.toUpperCase();
      if (!seen.has(key)) { seen.add(key); binds.push(bind); }
      index = end;
    } else {
      index += 1;
    }
  }
  return binds;
}

function connectorErrorMessage(reason: unknown) {
  if (typeof reason === "object" && reason !== null && "code" in reason && "detail" in reason
    && typeof reason.code === "string" && typeof reason.detail === "string") {
    return formatConnectorError(reason.code, reason.detail);
  }
  return formatConnectorError("UNKNOWN", "The step operation could not be completed.");
}

export function QueryStepEditor({ step, position, total, sourceConnectionId, targetConnectionId, onChange, onDelete, onMove }: QueryStepEditorProps) {
  const binds = extractBinds(step.upsertSql);
  const operation = step.operation ?? targetOperationForSql(step.upsertSql);
  const [preview, setPreview] = useState<StepPreview>();
  const [pendingAction, setPendingAction] = useState<"preview" | "run">();
  const [affectedRows, setAffectedRows] = useState<number>();
  const [actionError, setActionError] = useState<string>();
  const regenerateTargetSql = (nextOperation: TargetOperation, selectSql: string) => onChange({ ...step, operation: nextOperation as QueryOperation, selectSql, upsertSql: generateTargetSql(nextOperation, selectSql) });
  const canPreview = Boolean(sourceConnectionId && step.selectSql.trim() && !pendingAction);
  const canRun = Boolean(sourceConnectionId && targetConnectionId && sourceConnectionId !== targetConnectionId && step.selectSql.trim() && step.upsertSql.trim() && !pendingAction);
  const openPreview = async () => {
    if (!sourceConnectionId || !step.selectSql.trim() || pendingAction) return;
    setPendingAction("preview");
    setAffectedRows(undefined);
    setActionError(undefined);
    try { setPreview(await previewFlowStep({ sourceConnectionId, selectSql: step.selectSql })); }
    catch (reason) { setActionError(connectorErrorMessage(reason)); }
    finally { setPendingAction(undefined); }
  };
  const runStep = async () => {
    if (!sourceConnectionId || !targetConnectionId || sourceConnectionId === targetConnectionId || !step.selectSql.trim() || !step.upsertSql.trim() || pendingAction) return;
    setPendingAction("run");
    setAffectedRows(undefined);
    setActionError(undefined);
    try { setAffectedRows((await runFlowStep({ sourceConnectionId, targetConnectionId, selectSql: step.selectSql, upsertSql: step.upsertSql })).affectedRows); }
    catch (reason) { setActionError(connectorErrorMessage(reason)); }
    finally { setPendingAction(undefined); }
  };
  return <fieldset className="query-step" data-testid="query-step" data-step-id={step.id}>
    <legend>Step {position + 1}</legend>
    <div className="editor-actions"><button type="button" onClick={() => onMove(-1)} disabled={position === 0} aria-label={`Move step ${position + 1} up`}>Move up</button><button type="button" onClick={() => onMove(1)} disabled={position === total - 1} aria-label={`Move step ${position + 1} down`}>Move down</button><button type="button" onClick={onDelete} disabled={total === 1}>Delete step</button></div>
    <label>Operation<select aria-label={`Operation for step ${position + 1}`} value={operation} onChange={(event) => regenerateTargetSql(event.target.value as TargetOperation, step.selectSql)}><option value="insert">Insert</option><option value="update">Update</option></select></label>
    <label>Source SQL<textarea className="sql-editor" aria-label={`Source SQL for step ${position + 1}`} value={step.selectSql} onChange={(event) => regenerateTargetSql(operation, event.target.value)} /></label>
    <label>Target SQL<textarea className="sql-editor" aria-label={`Target SQL for step ${position + 1}`} value={step.upsertSql} onChange={(event) => onChange({ ...step, operation, upsertSql: event.target.value })} /></label>
    <div className="editor-actions query-step__operation-actions"><button type="button" onClick={() => void openPreview()} disabled={!canPreview}>{pendingAction === "preview" ? "미리보기 중..." : "미리보기"}</button><button type="button" onClick={() => void runStep()} disabled={!canRun}>{pendingAction === "run" ? "Running..." : "Run"}</button></div>
    {operation === "insert" ? <p className="field-hint">Target SQL is generated from a simple single-table Source SQL query and can be edited.</p> : <p className="field-hint">생성된 WHERE 절을 검토하고, 필요한 경우 대상 테이블의 기본 키로 대체하십시오</p>}
    <p className="field-hint">Target binds: {binds.length ? binds.join(", ") : "None"}</p>
    {affectedRows !== undefined ? <p role="status">{affectedRows} rows affected.</p> : null}
    {actionError ? <p role="alert">{actionError}</p> : null}
    {preview ? <StepPreviewDialog preview={preview} onClose={() => setPreview(undefined)} /> : null}
  </fieldset>;
}
