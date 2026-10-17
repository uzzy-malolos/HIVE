export interface ToastItem {
  id: string;
  tone: "neutral" | "success" | "warning" | "error";
  text: string;
  /** Optional inline action, e.g. Undo after a delete. */
  action?: { label: string; run: () => void };
}

export interface ToastProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function Toast({ toasts, onDismiss }: ToastProps) {
  if (!toasts.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone} anim-in`}>
          <span>{toast.text}</span>
          {toast.action ? (
            <button type="button" className="toast-action" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            x
          </button>
        </div>
      ))}
    </div>
  );
}
