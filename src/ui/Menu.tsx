// A small dropdown menu. It is positioned with `fixed`, so it is never clipped
// by a scrolling panel, and closes on outside click, Escape or after a choice
// (see useAnchoredPopup). A slider row stays open while it is used.

import React, { useCallback, useEffect, useRef, useState } from 'react';
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

/** A slider row, such as an opacity. Arrow up and down move between rows; left and right change it. */
export interface MenuSlider {
  kind: 'slider';
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as shown beside the slider */
  format: (value: number) => string;
  /** While it moves, and once more with `done` when it is let go (or a key changed it) */
  onChange: (value: number, done: boolean) => void;
  title?: string;
  separated?: boolean;
}

export type MenuEntry = MenuItem | MenuSlider;

interface MenuProps {
  items: MenuEntry[];
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
              menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ??
                [],
            );
            const index = buttons.indexOf(document.activeElement as HTMLElement);
            const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map((item) => (
            <React.Fragment key={item.label}>
              {item.separated && <div className="my-1 h-px bg-line" role="separator" />}
              {'kind' in item ? (
                <SliderRow slider={item} />
              ) : (
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
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function SliderRow({ slider }: { slider: MenuSlider }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(slider.onChange);
  onChangeRef.current = slider.onChange;

  // The native change event fires once, when the slider is let go or a key
  // has moved it; React's onChange fires on every step of a drag
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => onChangeRef.current(Number(input.value), true);
    input.addEventListener('change', commit);
    return () => input.removeEventListener('change', commit);
  }, []);

  return (
    <label className="flex h-8 items-center gap-2 px-3 text-[13px] text-ink" title={slider.title}>
      <span className="w-3" aria-hidden="true" />
      <span className="flex-1 whitespace-nowrap">{slider.label}</span>
      <input
        ref={inputRef}
        type="range"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.value}
        onChange={(event) => slider.onChange(Number(event.target.value), false)}
        aria-label={slider.label}
        className="w-24 accent-gold"
      />
      <span className="w-9 text-right text-xs tabular-nums text-muted">{slider.format(slider.value)}</span>
    </label>
  );
}
