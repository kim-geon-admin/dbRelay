import type { PreviewBytesDto, PreviewCellDto, PreviewFlowStepDto } from "../../lib/desktop";

type StepPreviewDialogProps = {
  preview: PreviewFlowStepDto;
  onClose: () => void;
};

function pad(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

function isTemporal(value: Exclude<PreviewCellDto, null>): value is {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  microsecond?: number; tzHourOffset?: number; tzMinuteOffset?: number;
} {
  return typeof value === "object" && !Array.isArray(value) && "year" in value && "month" in value
    && "day" in value && "hour" in value && "minute" in value && "second" in value;
}

function isBytes(value: Exclude<PreviewCellDto, null>): value is PreviewBytesDto {
  return typeof value === "object" && !Array.isArray(value) && "type" in value && value.type === "bytes"
    && "base64" in value && typeof value.base64 === "string";
}

function byteLength(base64: string) {
  const normalized = base64.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) return undefined;
  return (normalized.length / 4) * 3 - (normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0);
}

function previewCellText(value: PreviewCellDto | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (isBytes(value)) {
    const length = byteLength(value.base64);
    return length === undefined ? "bytes" : `${length} bytes`;
  }
  if (isTemporal(value)) {
    const date = `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)} ${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;
    if (value.microsecond === undefined) return date;
    const sign = (value.tzHourOffset ?? 0) < 0 || (value.tzHourOffset === 0 && (value.tzMinuteOffset ?? 0) < 0) ? "-" : "+";
    return `${date}.${pad(value.microsecond, 6)} ${sign}${pad(Math.abs(value.tzHourOffset ?? 0))}:${pad(Math.abs(value.tzMinuteOffset ?? 0))}`;
  }
  return JSON.stringify(value);
}

export function StepPreviewDialog({ preview, onClose }: StepPreviewDialogProps) {
  return <div className="step-preview-backdrop" role="presentation">
    <section className="step-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="step-preview-title">
      <div className="step-preview-dialog__header">
        <h2 id="step-preview-title">미리보기</h2>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
      {preview.rows.length === 0 ? <p className="step-preview-dialog__empty">미리볼 행이 없습니다.</p> : <div className="step-preview-dialog__table-wrap">
        <table>
          <thead><tr>{preview.columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
          <tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{preview.columns.map((column) => <td key={column}>{previewCellText(row[column])}</td>)}</tr>)}</tbody>
        </table>
      </div>}
    </section>
  </div>;
}
