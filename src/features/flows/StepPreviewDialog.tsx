import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type {
  PreviewBigIntDto,
  PreviewBytesDto,
  PreviewCellDto,
  PreviewFlowStepDto,
  PreviewOracleDateDto,
  PreviewOracleTimestampDto,
} from "../../lib/desktop";

type StepPreviewDialogProps = {
  preview: PreviewFlowStepDto;
  onClose: () => void;
  onSave?: (edited: Pick<PreviewFlowStepDto, "columns" | "rows">) => Promise<void> | void;
};

function isBytes(value: Exclude<PreviewCellDto, null>): value is PreviewBytesDto {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value && value.type === "bytes"
    && "base64" in value && typeof value.base64 === "string";
}

function isBigInt(value: Exclude<PreviewCellDto, null>): value is PreviewBigIntDto {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value && value.type === "bigint"
    && "decimal" in value && typeof value.decimal === "string";
}

function isOracleDate(value: Exclude<PreviewCellDto, null>): value is PreviewOracleDateDto {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && ["year", "month", "day", "hour", "minute", "second"].every((key) =>
      typeof (value as Record<string, unknown>)[key] === "number");
}

function isOracleTimestamp(value: Exclude<PreviewCellDto, null>): value is PreviewOracleTimestampDto {
  return isOracleDate(value)
    && "microsecond" in value && typeof value.microsecond === "number"
    && "tzHourOffset" in value && typeof value.tzHourOffset === "number"
    && "tzMinuteOffset" in value && typeof value.tzMinuteOffset === "number";
}

function twoDigits(value: number): string { return String(value).padStart(2, "0"); }

function formatOracleDate(value: PreviewOracleDateDto): string {
  return `${String(value.year).padStart(4, "0")}-${twoDigits(value.month)}-${twoDigits(value.day)} ${twoDigits(value.hour)}:${twoDigits(value.minute)}:${twoDigits(value.second)}`;
}

function temporalValueFromDraft(original: PreviewCellDto | undefined, draft: string): PreviewCellDto {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{6}))?$/u.exec(draft);
  if (match === null || original === undefined || original === null) return draft;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (!isValidTemporalParts(year, month, day, hour, minute, second)) return draft;
  if (isOracleTimestamp(original) && match[7] !== undefined) {
    return { year, month, day, hour, minute, second, microsecond: Number(match[7]),
      tzHourOffset: original.tzHourOffset, tzMinuteOffset: original.tzMinuteOffset };
  }
  if (isOracleDate(original) && match[7] === undefined) return { year, month, day, hour, minute, second };
  return draft;
}

function isValidTemporalParts(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  const candidate = new Date(year, month - 1, day, hour, minute, second);
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day
    && candidate.getHours() === hour && candidate.getMinutes() === minute && candidate.getSeconds() === second;
}

function saveErrorMessage(reason: unknown): string {
  return typeof reason === "object" && reason !== null
    && "code" in reason && typeof reason.code === "string"
    && "detail" in reason && typeof reason.detail === "string"
    ? `${reason.code} · ${reason.detail}`
    : "Unable to save edited preview data.";
}

function editableText(value: PreviewCellDto): string {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (isOracleTimestamp(value)) return `${formatOracleDate(value)}.${String(value.microsecond).padStart(6, "0")}`;
  if (isOracleDate(value)) return formatOracleDate(value);
  if (isBigInt(value)) return value.decimal;
  if (isBytes(value)) return value.base64;
  return JSON.stringify(value);
}

export function StepPreviewDialog({ preview, onClose, onSave }: StepPreviewDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [rows, setRows] = useState(() => preview.rows.map((row) => ({ ...row })));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [generateRowsOpen, setGenerateRowsOpen] = useState(false);
  const [generateRowsDraft, setGenerateRowsDraft] = useState("");
  const [generateRowsError, setGenerateRowsError] = useState<string>();
  const [generatedRowStart, setGeneratedRowStart] = useState<number>();
  const [autoFillColumn, setAutoFillColumn] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(
    preview.rows.flatMap((row, rowIndex) => preview.columns.flatMap((column) => {
      const value = row[column];
      return value === undefined ? [] : [[`${rowIndex}:${column}`, editableText(value)] as const];
    })),
  ));

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("button:last-of-type:not([disabled])")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ) ?? []);
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = current < 0
      ? (event.shiftKey ? focusable[focusable.length - 1] : focusable[0])
      : focusable[(current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
    event.preventDefault();
    next?.focus();
  };

  const save = async () => {
    if (onSave === undefined || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave({ columns: [...preview.columns], rows });
    } catch (reason) {
      setSaveError(saveErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const changeCell = (rowIndex: number, column: string, value: PreviewCellDto) => {
    setRows((current) => current.map((row, index) => index === rowIndex
      ? { ...row, [column]: value }
      : row));
  };

  const generateRows = () => {
    const count = Number(generateRowsDraft);
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
      setGenerateRowsError("1에서 10000 사이의 정수를 입력하세요.");
      return;
    }
    const firstRow = rows[0];
    if (firstRow === undefined) return;
    const additions = Array.from({ length: count }, () => ({ ...firstRow }));
    const startIndex = rows.length;
    setGeneratedRowStart((current) => current ?? startIndex);
    setRows((current) => [...current, ...additions]);
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(additions.flatMap((row, offset) => preview.columns.map((column) => [
        `${startIndex + offset}:${column}`,
        editableText(row[column]),
      ]))),
    }));
    setGenerateRowsOpen(false);
    setGenerateRowsDraft("");
    setGenerateRowsError(undefined);
  };

  const canAutoFill = (column: string) => {
    const firstValue = rows[0]?.[column];
    return rows.length > 1 && (typeof firstValue === "string" || (typeof firstValue === "number" && Number.isFinite(firstValue)));
  };

  const autoFill = () => {
    const column = autoFillColumn;
    const firstValue = column === undefined ? undefined : rows[0]?.[column];
    if (column === undefined || !(typeof firstValue === "string" || (typeof firstValue === "number" && Number.isFinite(firstValue)))) {
      setAutoFillColumn(undefined);
      return;
    }
    const firstChangedRow = typeof firstValue === "number" ? 1 : 0;
    const values = rows.map((row, rowIndex) => typeof firstValue === "number"
      ? firstValue + rowIndex
      : `${row[column]}${rowIndex + 1}`);
    setRows((current) => current.map((row, rowIndex) => rowIndex < firstChangedRow ? row : { ...row, [column]: values[rowIndex] }));
    setDrafts((current) => ({
      ...current,
      ...Object.fromEntries(values.slice(firstChangedRow).map((value, rowIndex) => [`${rowIndex + firstChangedRow}:${column}`, String(value)])),
    }));
    setAutoFillColumn(undefined);
  };

  const updateDraft = (rowIndex: number, column: string, draft: string) => {
    const key = `${rowIndex}:${column}`;
    setDrafts((current) => ({ ...current, [key]: draft }));
    changeCell(rowIndex, column, draft === "" ? null : temporalValueFromDraft(rows[rowIndex]?.[column], draft));
  };

  return <div className="step-preview-backdrop" role="presentation">
    <section ref={dialogRef} className="step-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="step-preview-title" onKeyDown={handleKeyDown}>
      <div className="step-preview-dialog__header">
        {onSave ? <button type="button" onClick={() => void save()} disabled={saving}>{saving ? "Saving..." : "저장"}</button> : null}
        <h2 id="step-preview-title">미리보기</h2>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
      {preview.rows.length === 0 ? <p className="step-preview-dialog__empty">미리볼 행이 없습니다.</p> : <div className="step-preview-dialog__table-wrap" data-testid="step-preview-table-scroll">
        <table onDoubleClick={(event) => { const target = event.target; if (target instanceof HTMLTableCellElement && target.textContent?.trim() === "#") setGenerateRowsOpen(true); }}>
          <thead><tr><th scope="col" className="step-preview-dialog__line-number">#</th>{preview.columns.map((column) => <th scope="col" key={column} className={canAutoFill(column) ? "step-preview-dialog__column-header" : undefined} title={canAutoFill(column) ? "더블 클릭하여 자동 채우기" : undefined} onDoubleClick={() => canAutoFill(column) && setAutoFillColumn(column)}>{column}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}><th scope="row" className="step-preview-dialog__line-number">{rowIndex + 1}</th>{preview.columns.map((column) => {
            const value = row[column];
            const key = `${rowIndex}:${column}`;
            const baseline = preview.rows[rowIndex]?.[column] ?? (rowIndex >= preview.rows.length ? preview.rows[0]?.[column] : undefined);
            const changed = (generatedRowStart !== undefined && rowIndex >= generatedRowStart)
              || JSON.stringify(value) !== JSON.stringify(baseline);
            return <td key={column} data-testid={`preview-cell-${rowIndex}-${column}`} className={changed ? "step-preview-dialog__cell--changed" : undefined}>
              <input aria-label={`${column} row ${rowIndex + 1}`} value={drafts[key] ?? (value === undefined ? "" : editableText(value))} onChange={(event) => updateDraft(rowIndex, column, event.target.value)} />
            </td>;
          })}</tr>)}</tbody>
        </table>
      </div>}
      {saveError ? <p role="alert">{saveError}</p> : null}
      {autoFillColumn !== undefined ? <ConfirmDialog title="컬럼 자동 채우기" description="첫 번째 행 값을 기준으로 아래 행의 값을 자동으로 채우시겠습니까?" confirmLabel="자동 채우기" onCancel={() => setAutoFillColumn(undefined)} onConfirm={autoFill} /> : null}
      {generateRowsOpen ? <div className="confirmation-backdrop" role="presentation"><section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="generate-rows-title" aria-describedby="generate-rows-description" onKeyDown={handleKeyDown}>
        <h2 id="generate-rows-title">데이터 행 생성</h2>
        <p id="generate-rows-description">첫번째 ROW데이터로 몇개의 데이터를 생성하시겠습니까?</p>
        <label htmlFor="generate-rows-count">생성할 개수</label>
        <input id="generate-rows-count" type="number" min="1" max="10000" step="1" value={generateRowsDraft} onChange={(event) => { setGenerateRowsDraft(event.target.value); setGenerateRowsError(undefined); }} autoFocus />
        {generateRowsError ? <p role="alert">{generateRowsError}</p> : null}
        <div className="editor-actions confirmation-dialog__actions"><button type="button" onClick={() => { setGenerateRowsOpen(false); setGenerateRowsDraft(""); setGenerateRowsError(undefined); }}>취소</button><button type="button" className="confirmation-dialog__confirm" onClick={generateRows}>확인</button></div>
      </section></div> : null}
    </section>
  </div>;
}
