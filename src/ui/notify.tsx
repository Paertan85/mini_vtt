// App-wide toasts and confirmation dialogs, callable from anywhere:
//
//   notify('3 maps added');                notify('Could not …', 'error');
//   if (await confirmAction({ … })) …
//
// A toast that answers a click shows right beneath what was clicked; one
// with nothing to point at (a keyboard shortcut, something that happened on
// its own) shows in the bottom right corner.
//
// Each is a tiny external store rendered once by <NotificationHost />.

import { memo, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from './controls';
import { Dialog } from './Dialog';

// ─── Toasts ───────────────────────────────────────────────────────────────────

/** Where a control was on screen when it was pressed. */
export interface Anchor {
  top: number;
  bottom: number;
  left: number;
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  /** Shown beneath this, or in the corner when null */
  anchor: Anchor | null;
}

let toasts: Toast[] = [];
let confirmRequest: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let nextToastId = 1;

// ─── The control that was just pressed ────────────────────────────────────────
//
// Remembered briefly from a pointer press, or Enter or Space on a focused
// control. Any other key forgets it, so a shortcut's toast goes to the corner.

const CONTROL =
  'button, input, select, textarea, [role="button"], [role="menuitem"], [role="menuitemcheckbox"]';
const PRESS_MEMORY_MS = 1500;
let lastPress: { element: Element; at: number } | null = null;

window.addEventListener(
  'pointerdown',
  (event) => {
    const element = event.target instanceof Element ? event.target.closest(CONTROL) : null;
    lastPress = element ? { element, at: performance.now() } : null;
  },
  true,
);
window.addEventListener(
  'keydown',
  (event) => {
    const focused = document.activeElement;
    const presses = (event.key === 'Enter' || event.key === ' ') && focused?.matches(CONTROL);
    lastPress = presses && focused ? { element: focused, at: performance.now() } : null;
  },
  true,
);

/**
 * Where the control the user just pressed is, or null. An action that waits
 * for a dialog first takes this at its start and passes it to notify, as the
 * press is long past (and the control perhaps gone) by the time it reports.
 */
export function pressedControl(): Anchor | null {
  if (!lastPress || performance.now() - lastPress.at > PRESS_MEMORY_MS) return null;
  if (!lastPress.element.isConnected) return null;
  const rect = lastPress.element.getBoundingClientRect();
  return rect.width || rect.height ? { top: rect.top, bottom: rect.bottom, left: rect.left } : null;
}

interface NotifyOptions {
  /** How long it stays up; longer messages can stay longer than the default */
  durationMs?: number;
  /** Beneath what to show it: the control just pressed unless given; null for the corner */
  anchor?: Anchor | null;
}

/** Show a toast, beneath the control that was just pressed when there is one. */
export function notify(message: string, kind: Toast['kind'] = 'info', options: NotifyOptions = {}) {
  const { durationMs } = options;
  const anchor = options.anchor === undefined ? pressedControl() : options.anchor;
  const toast = { id: nextToastId++, message, kind, anchor };
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

function ToastCard({ toast }: { toast: Toast }) {
  return (
    <div
      className={`max-w-sm rounded border px-3 py-2 text-[13px] ${
        toast.kind === 'error'
          ? 'border-crimson bg-crimson-deep text-ink'
          : 'border-line-strong bg-panel text-ink'
      }`}
    >
      {toast.message}
    </div>
  );
}

/** Toasts from one press, stacked beneath it (above, when there is no room below), kept on screen. */
function AnchoredToasts({ anchor, items }: { anchor: Anchor; items: Toast[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const below = anchor.bottom + 6;
    const top = below + box.height > window.innerHeight - 8 ? anchor.top - box.height - 6 : below;
    setPosition({
      top: Math.max(8, top),
      left: Math.min(Math.max(8, anchor.left), window.innerWidth - box.width - 8),
    });
  }, [anchor, items.length]);
  return (
    <div
      ref={ref}
      role="status"
      className="pointer-events-none fixed z-60 flex flex-col items-start gap-2"
      style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
    >
      {items.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

// Memoized: it has no props, so it renders only when a toast or confirmation changes
export const NotificationHost = memo(function NotificationHost() {
  const currentToasts = useSyncExternalStore(subscribe, () => toasts);
  const request = useSyncExternalStore(subscribe, () => confirmRequest);

  // Toasts from the same press share its anchor and stack together
  const anchored = new Map<Anchor, Toast[]>();
  for (const toast of currentToasts) {
    if (toast.anchor) anchored.set(toast.anchor, [...(anchored.get(toast.anchor) ?? []), toast]);
  }

  return (
    <>
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-60 flex flex-col items-end gap-2"
        role="status"
      >
        {currentToasts
          .filter((toast) => !toast.anchor)
          .map((toast) => (
            <ToastCard key={toast.id} toast={toast} />
          ))}
      </div>
      {[...anchored].map(([anchor, items]) => (
        <AnchoredToasts key={items[0].id} anchor={anchor} items={items} />
      ))}
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
