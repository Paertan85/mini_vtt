// Modal dialog shell: dimmed backdrop, Escape and backdrop click close it, and
// focus moves into the dialog when it opens.

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from './controls';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}

export function Dialog({ title, onClose, children, footer, width = 'w-104' }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`dialog-${Math.random().toString(36).slice(2)}`).current;
  // Parents pass a new function on every render. Reading it through a ref lets
  // the effect below run once, when the dialog opens: run again, it would move
  // the focus back to the default button (onto Remove, after the user had
  // tabbed to Cancel)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>('input') ??
      panel?.querySelector<HTMLElement>('button');
    focusable?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${width} max-w-[calc(100vw-2rem)] rounded-sm border border-line-strong bg-panel`}
      >
        <div className="flex items-center justify-between border-b border-line py-2 pl-4 pr-2">
          <h2 id={titleId} className="font-display text-[15px] font-semibold tracking-wide text-ink">
            {title}
          </h2>
          <Button tone="quiet" square onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}
