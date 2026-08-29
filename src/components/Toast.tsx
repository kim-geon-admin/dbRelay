type ToastTone = "info" | "success" | "warning" | "error";

type ToastProps = {
  title: string;
  message?: string;
  tone?: ToastTone;
};

export function Toast({ title, message, tone = "info" }: ToastProps) {
  return (
    <div className={`toast toast--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div>
        <p className="toast__title">{title}</p>
        {message ? <p className="toast__message">{message}</p> : null}
      </div>
    </div>
  );
}
