export type StatusBadgeStatus =
  | "draft"
  | "running"
  | "awaiting-recovery"
  | "succeeded"
  | "failed"
  | "rolled-back"
  | "stopped";

const statusLabels: Record<StatusBadgeStatus, { label: string; tone: "success" | "warning" | "error" | "neutral" }> = {
  draft: { label: "초안", tone: "neutral" },
  running: { label: "실행 중", tone: "warning" },
  "awaiting-recovery": { label: "복구 대기", tone: "warning" },
  succeeded: { label: "성공", tone: "success" },
  failed: { label: "실패", tone: "error" },
  "rolled-back": { label: "롤백됨", tone: "error" },
  stopped: { label: "사용자 중지", tone: "neutral" },
};

export function StatusBadge({ status }: { status: StatusBadgeStatus }) {
  const { label, tone } = statusLabels[status];

  return <span className={`status-badge status-badge--${tone}`}>{label}</span>;
}
