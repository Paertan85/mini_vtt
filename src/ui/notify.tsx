// App-wide toasts and confirmation dialogs, callable from anywhere:
//
//   notify('3 maps added');                notify('Could not …', 'error');
//   if (await confirmAction({ … })) …
//
// Each is a tiny external store rendered once by <NotificationHost />.

import { memo, useSyncExternalStore } from 'react';
import { Button } from './controls';
import { Dialog } from './Dialog';

// ─── Toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

let toasts: Toast[] = [];
let confirmRequest: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let nextToastId = 1;

/** Show a toast; longer messages can stay up longer than the default. */
export function notify(message: string, kind: Toast['kind'] = 'info', durationMs?: number) {
  const toast = { id: nextToastId++, message, kind };
  toasts = [...toasts.slice(-3), toast];
  emit();
  window.setTimeout(
    () => {
      toasts = toasts.filter((entry) => entry.id !== toast.id);
      emit();
    },
    durationMs ?? (kind === 'error' ? 6000 : 3000),
  );
}

// ─── Confirmations ────────────────────────────────────────────────────────────

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** Use the crimson style for the confirming button */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/** Ask the user to confirm an action; resolves to true when they do. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  confirmRequest?.resolve(false);
  return new Promise((resolve) => {
    confirmRequest = { ...options, resolve };
    emit();
  });
}

function settleConfirm(confirmed: boolean) {
  confirmRequest?.resolve(confirmed);
  confirmRequest = null;
  emit();
}

// ─── Host ─────────────────────────────────────────────────────────────────────

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Memoized: it has no props, so it renders only when a toast or confirmation changes
export const NotificationHost = memo(function NotificationHost() {
  const currentToasts = useSyncExternalStore(subscribe, () => toasts);
  const request = useSyncExternalStore(subscribe, () => confirmRequest);

  return (
    <>
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2"
        role="status"
      >
        {currentToasts.map((toast) => (
          <div
            key={toast.id}
            className={`max-w-sm rounded border px-3 py-2 text-[13px] ${
              toast.kind === 'error'
                ? 'border-crimson bg-crimson-deep text-ink'
                : 'border-line-strong bg-panel text-ink'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
      {request && (
        <Dialog
          title={request.title}
          onClose={() => settleConfirm(false)}
          footer={
            <>
              <Button onClick={() => settleConfirm(false)}>Cancel</Button>
              <Button
                tone={request.danger ? 'live' : 'active'}
                data-autofocus
                onClick={() => settleConfirm(true)}
              >
                {request.confirmLabel}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-muted">{request.message}</p>
        </Dialog>
      )}
    </>
  );
});
