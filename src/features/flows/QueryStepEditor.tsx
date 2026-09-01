import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatConnectorError } from "../../lib/oracleErrors";
import { discardEditedPreview, discardStepRestore, previewFlowStep, restoreFlowStep, runFlowStep, saveEditedPreview } from "./flows.api";
import { StepPreviewDialog } from "./StepPreviewDialog";
import type { QueryOperation, QueryStep, StepPreview } from "./flows.types";
import { targetOperationForSql, targetSqlGenerationFor, type TargetOperation } from "./sqlGeneration";
import { formatOracleSql } from "./sqlFormatting";

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

type ActionError = {
  action: "format" | "preview" | "run" | "restore" | "save";
  code: string;
  message: string;
};

function extractBinds(sql: string) {
  const seen = new Set<string>();
  const binds: string[] = [];
  let index = 0;
  const isStart = (value: string) => /^[\p{L}_]$/u.test(value);
  const isContinue = (value: string) => isStart(value) || /^[\p{M}\p{Nd}$#]$/u.test(value);

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

function connectorErrorMessage(reason: unknown): Pick<ActionError, "code" | "message"> {
  if (typeof reason === "object" && reason !== null && "code" in reason && "detail" in reason
    && typeof reason.code === "string" && typeof reason.detail === "string") {
    const formatted = formatConnectorError(reason.code, reason.detail);
    const prefix = `${reason.code} · `;
    return {
      code: reason.code,
      message: formatted.startsWith(prefix) ? formatted.slice(prefix.length) : formatted,
    };
  }
  return {
    code: "UNKNOWN",
    message: formatConnectorError("UNKNOWN", "The step operation could not be completed."),
  };
}

export function QueryStepEditor({ step, position, total, sourceConnectionId, targetConnectionId, onChange, onDelete, onMove }: QueryStepEditorProps) {
  const binds = extractBinds(step.upsertSql);
  const operation = step.operation ?? targetOperationForSql(step.upsertSql);
  const [preview, setPreview] = useState<StepPreview>();
  const [pendingAction, setPendingAction] = useState<"preview" | "run" | "restore">();
  const [affectedRows, setAffectedRows] = useState<number>();
  const [restoreSucceeded, setRestoreSucceeded] = useState(false);
  const [restoreUnavailableMessage, setRestoreUnavailableMessage] = useState("Run이 정상 완료된 후에 복원할 수 있습니다.");
  const [actionError, setActionError] = useState<ActionError>();
  const [savedPreviewId, setSavedPreviewId] = useState<string | undefined>(undefined);
  const savedPreviewRef = useRef<string | undefined>(undefined);
  const [targetSqlGenerationReason, setTargetSqlGenerationReason] = useState<string>();
  const preserveSavedPreviewForGeneratedSql = useRef(false);
  const editorSessionId = useRef(globalThis.crypto?.randomUUID?.() ?? `editor-${Date.now()}`).current;
  const [restoreId, setRestoreId] = useState<string>();
  const restoreIdRef = useRef<string | undefined>(undefined);
  const clearRestore = () => {
    const currentRestoreId = restoreIdRef.current;
    restoreIdRef.current = undefined;
    if (currentRestoreId !== undefined) void discardStepRestore(currentRestoreId);
    setRestoreId(undefined);
    setRestoreSucceeded(false);
    setRestoreUnavailableMessage("Run이 정상 완료된 후에 복원할 수 있습니다.");
  };
  const discardSavedPreview = () => {
    const previewId = savedPreviewRef.current;
    savedPreviewRef.current = undefined;
    setSavedPreviewId(undefined);
    if (previewId !== undefined) void discardEditedPreview(previewId);
  };
  useEffect(() => () => {
    const previewId = savedPreviewRef.current;
    savedPreviewRef.current = undefined;
    if (previewId !== undefined) void discardEditedPreview(previewId);
    const currentRestoreId = restoreIdRef.current;
    restoreIdRef.current = undefined;
    if (currentRestoreId !== undefined) void discardStepRestore(currentRestoreId);
  }, []);
  useEffect(() => {
    if (preserveSavedPreviewForGeneratedSql.current) {
      preserveSavedPreviewForGeneratedSql.current = false;
      return;
    }
    const previewId = savedPreviewRef.current;
    if (previewId !== undefined) {
      savedPreviewRef.current = undefined;
      setSavedPreviewId(undefined);
      void discardEditedPreview(previewId);
    }
  }, [sourceConnectionId, targetConnectionId, step.selectSql, step.upsertSql]);
  const regenerateTargetSql = (
    nextOperation: TargetOperation,
    selectSql: string,
    previewColumns?: readonly string[],
    preserveSavedPreview = false,
  ) => {
    const generated = targetSqlGenerationFor(nextOperation, selectSql, previewColumns);
    setTargetSqlGenerationReason(generated.reason);
    // Saving a preview reports why generation failed instead of clearing the
    // Target SQL the step already has.
    const upsertSql = preserveSavedPreview && generated.sql === "" ? step.upsertSql : generated.sql;
    if (preserveSavedPreview && step.upsertSql !== upsertSql) {
      preserveSavedPreviewForGeneratedSql.current = true;
    }
    onChange({ ...step, operation: nextOperation as QueryOperation, selectSql, upsertSql });
  };
  const canPreview = Boolean(sourceConnectionId && step.selectSql.trim() && !pendingAction);
  const canRun = Boolean(sourceConnectionId && targetConnectionId && step.selectSql.trim() && step.upsertSql.trim() && !pendingAction);
  const formatSql = (field: "selectSql" | "upsertSql") => {
    try {
      onChange({ ...step, operation, [field]: formatOracleSql(step[field]) });
      setActionError(undefined);
    } catch {
      setActionError({
        action: "format",
        code: "SQL_FORMAT_ERROR",
        message: "SQL could not be formatted. The query was not changed.",
      });
    }
  };
  const handleSqlKeyDown = (field: "selectSql" | "upsertSql") => (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey && event.key.toLowerCase() === "f")) return;
    event.preventDefault();
    formatSql(field);
  };
  const openPreview = async () => {
    if (!sourceConnectionId || !step.selectSql.trim() || pendingAction) return;
    discardSavedPreview();
    setPendingAction("preview");
    setAffectedRows(undefined);
    setActionError(undefined);
    try { setPreview(await previewFlowStep({ sourceConnectionId, selectSql: step.selectSql })); }
    catch (reason) { setActionError({ action: "preview", ...connectorErrorMessage(reason) }); }
    finally { setPendingAction(undefined); }
  };
  const closePreview = () => {
    const previewId = preview?.previewId;
    setPreview(undefined);
    if (previewId !== undefined && previewId !== savedPreviewRef.current) {
      void discardEditedPreview(previewId);
    }
  };
  const savePreview = async (edited: Pick<StepPreview, "columns" | "rows">) => {
    if (preview === undefined) return;
    try {
      await saveEditedPreview({ previewId: preview.previewId, ...edited });
      savedPreviewRef.current = preview.previewId;
      setSavedPreviewId(preview.previewId);
      if (operation === "insert" && /^\s*select\s+\*\s+from\s+/iu.test(step.selectSql)) {
        regenerateTargetSql(operation, step.selectSql, edited.columns, true);
      }
      setPreview(undefined);
    } catch (reason) {
      setActionError({ action: "save", ...connectorErrorMessage(reason) });
      throw reason;
    }
  };
  const runStep = async () => {
    if (!sourceConnectionId || !targetConnectionId || !step.selectSql.trim() || !step.upsertSql.trim() || pendingAction) return;
    setPendingAction("run");
    clearRestore();
    setAffectedRows(undefined);
    setActionError(undefined);
    const previewId = savedPreviewRef.current;
    try {
      const result = await runFlowStep({
        sourceConnectionId,
        targetConnectionId,
        selectSql: step.selectSql,
        upsertSql: step.upsertSql,
        ...(previewId === undefined ? {} : { previewId }), editorSessionId, stepId: step.id,
      });
      setAffectedRows(result.affectedRows);
      restoreIdRef.current = result.restoreId;
      setRestoreId(result.restoreId);
      setRestoreUnavailableMessage(result.restoreId === undefined
        ? "이번 Run의 Target SQL은 복원 가능한 단순 AND 동등 조건을 사용하지 않았습니다. OR, 함수, 조인, 서브쿼리, RETURNING 절은 복원할 수 없습니다."
        : "");
    }
    catch (reason) { setActionError({ action: "run", ...connectorErrorMessage(reason) }); }
    finally {
      if (previewId !== undefined) {
        savedPreviewRef.current = undefined;
        setSavedPreviewId(undefined);
      }
      setPendingAction(undefined);
    }
  };
  const restoreStep = async () => {
    if (!restoreId || pendingAction) {
      setActionError({
        action: "restore",
        code: "RESTORE_UNAVAILABLE",
        message: pendingAction
          ? "다른 작업이 완료된 후에 복원할 수 있습니다."
          : restoreUnavailableMessage,
      });
      return;
    }
    setPendingAction("restore"); setActionError(undefined); setRestoreSucceeded(false);
    try {
      await restoreFlowStep(restoreId);
      restoreIdRef.current = undefined;
      setRestoreId(undefined);
      setRestoreSucceeded(true);
      setRestoreUnavailableMessage("이미 정상 복원된 Run입니다. 다시 Run하면 새 복원 데이터를 만듭니다.");
    }
    catch (reason) { setActionError({ action: "restore", ...connectorErrorMessage(reason) }); }
    finally { setPendingAction(undefined); }
  };
  return <fieldset className="query-step" data-testid="query-step" data-step-id={step.id}>
    <legend>Step {position + 1}</legend>
    <div className="editor-actions"><button type="button" onClick={() => onMove(-1)} disabled={position === 0} aria-label={`Move step ${position + 1} up`}>Move up</button><button type="button" onClick={() => onMove(1)} disabled={position === total - 1} aria-label={`Move step ${position + 1} down`}>Move down</button><button type="button" onClick={onDelete} disabled={total === 1}>Delete step</button></div>
    <label>Step title<input aria-label={`Step title for step ${position + 1}`} value={step.title ?? `Step ${position + 1}`} onChange={(event) => onChange({ ...step, title: event.target.value })} /></label>
    <label>Operation<select aria-label={`Operation for step ${position + 1}`} value={operation} onChange={(event) => void regenerateTargetSql(event.target.value as TargetOperation, step.selectSql)}><option value="insert">Insert</option><option value="update">Update</option><option value="upsert">Upsert</option></select></label>
    <label>Source SQL<textarea className="sql-editor" aria-label={`Source SQL for step ${position + 1}`} value={step.selectSql} onChange={(event) => void regenerateTargetSql(operation, event.target.value)} onKeyDown={handleSqlKeyDown("selectSql")} /></label>
    <label>Target SQL<textarea className="sql-editor" aria-label={`Target SQL for step ${position + 1}`} value={step.upsertSql} onChange={(event) => onChange({ ...step, operation, upsertSql: event.target.value })} onKeyDown={handleSqlKeyDown("upsertSql")} /></label>
    <div className="editor-actions query-step__operation-actions"><button className="query-step__action--preview" type="button" onClick={() => void openPreview()} disabled={!canPreview}>{pendingAction === "preview" ? "미리보기 중..." : "미리보기"}</button><button className="query-step__action--run" type="button" onClick={() => void runStep()} disabled={!canRun}>{pendingAction === "run" ? "Running..." : "Run"}</button><button className="query-step__action--restore" type="button" onClick={() => void restoreStep()} aria-disabled={!restoreId || Boolean(pendingAction)}>{pendingAction === "restore" ? "복원 중..." : "복원"}</button></div>
    {operation === "insert" ? <p className="field-hint">Target SQL is generated from a simple single-table Source SQL query and can be edited.</p> : operation === "update" ? <p className="field-hint">Source SQL의 첫 번째 SELECT 컬럼으로 Target SQL의 WHERE 조건을 생성합니다. 실제 키 조건에 맞게 수정하세요.</p> : <p className="field-hint">Source SQL의 첫 번째 SELECT 컬럼으로 Target SQL의 ON 조건을 생성합니다. 실제 키 조건에 맞게 수정하세요.</p>}
    {targetSqlGenerationReason ? <p role="status" className="field-hint">{targetSqlGenerationReason}</p> : null}
    <p className="field-hint">Target binds: {binds.length ? binds.join(", ") : "None"}</p>
    {affectedRows !== undefined ? <p role="status">{affectedRows} rows affected.{restoreSucceeded ? <span> 정상 복원되었습니다.</span> : null}</p> : null}
    {savedPreviewId ? <p role="status">사용자가 변경한 데이터로 DML 처리 합니다</p> : null}
    {actionError ? <p role="alert"><span data-testid={`${actionError.action}-error-code`}>{actionError.code}</span>{" · "}<span data-testid={`${actionError.action}-error-message`}>{actionError.message}</span></p> : null}
    {preview ? <StepPreviewDialog preview={preview} onClose={closePreview} onSave={savePreview} /> : null}
  </fieldset>;
}
