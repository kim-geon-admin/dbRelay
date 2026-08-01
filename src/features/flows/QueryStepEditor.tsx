import type { QueryStep } from "./flows.types";

type QueryStepEditorProps = {
  step: QueryStep;
  position: number;
  total: number;
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

export function QueryStepEditor({ step, position, total, onChange, onDelete, onMove }: QueryStepEditorProps) {
  const binds = extractBinds(step.upsertSql);
  return <fieldset className="query-step" data-testid="query-step" data-step-id={step.id}>
    <legend>Step {position + 1}</legend>
    <div className="editor-actions"><button type="button" onClick={() => onMove(-1)} disabled={position === 0} aria-label={`Move step ${position + 1} up`}>Move up</button><button type="button" onClick={() => onMove(1)} disabled={position === total - 1} aria-label={`Move step ${position + 1} down`}>Move down</button><button type="button" onClick={onDelete} disabled={total === 1}>Delete step</button></div>
    <label>Source SQL<textarea className="sql-editor" aria-label={`Source SQL for step ${position + 1}`} value={step.selectSql} onChange={(event) => onChange({ ...step, selectSql: event.target.value })} /></label>
    <label>Target SQL<textarea className="sql-editor" aria-label={`Target SQL for step ${position + 1}`} value={step.upsertSql} onChange={(event) => onChange({ ...step, upsertSql: event.target.value })} /></label>
    <p className="field-hint">Target binds: {binds.length ? binds.join(", ") : "None"}</p>
  </fieldset>;
}
