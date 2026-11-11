// A small dropdown menu. It is positioned with `fixed`, so it is never clipped
// by a scrolling panel, and closes on outside click, Escape or after a choice
// (see useAnchoredPopup).

import React, { useCallback, useRef, useState } from 'react';
import { useAnchoredPopup } from './popup';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Shows a check mark, for on/off settings */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** Shortcut hint shown on the right */
  hint?: string;
  /** Draw a separator above this item */
  separated?: boolean;
}

interface MenuProps {
  items: MenuItem[];
  align?: 'left' | 'right';
  /** Renders the trigger; spread the props onto a button */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
  }) => React.ReactNode;
}

export function Menu({ items, align = 'left', trigger }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const position = useAnchoredPopup(open, close, triggerRef, menuRef, align);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((value) => !value),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-48 rounded-sm border border-line-strong bg-panel py-1"
          style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const buttons = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
            );
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.separated && <div className="my-1 h-px bg-line" role="separator" />}
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] outline-hidden disabled:opacity-40 ${
                  item.danger ? 'text-crimson-text' : 'text-ink'
                } hover:bg-raised focus:bg-raised`}
              >
                <span className="w-3 text-gold" aria-hidden="true">
                  {item.checked ? '✓' : ''}
                </span>
                <span className="flex-1">{item.label}</span>
                {item.hint && <span className="text-xs text-muted">{item.hint}</span>}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}
