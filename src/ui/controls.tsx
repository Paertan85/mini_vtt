// Buttons and grouped controls. One height (32px), one radius, flat fills and
// 1px borders. Solid gold marks the current tool (and a dialog's main button),
// so the mode the DM is in stands out; a chosen option or a toggle that is on
// gets a gold outline and gold text instead. Crimson marks anything players
// can see change.
//
// In the toolbar, buttons are borderless (tone "plain") and choices sit in a
// dark track, as in Fluent's command bar: the bar is grouped by spacing, not by
// a box round every button, so the tool and the toggles that are on stand out.

import React, { useEffect, useRef } from 'react';

type Tone = 'default' | 'plain' | 'quiet' | 'active' | 'on' | 'live';

const TONES: Record<Tone, string> = {
  default: 'bg-raised border-line text-ink hover:border-line-strong hover:bg-raised-hover',
  plain: 'bg-transparent border-transparent text-ink hover:bg-raised-hover',
  quiet: 'bg-transparent border-transparent text-muted hover:text-ink hover:bg-raised',
  active: 'bg-gold border-gold text-ground hover:bg-gold-bright hover:border-gold-bright',
  // Above its neighbours in a group, so its gold outline isn't hidden under theirs
  on: 'relative z-10 bg-raised border-gold text-gold-bright hover:bg-raised-hover hover:border-gold-bright',
  live: 'bg-crimson border-crimson text-ink hover:bg-crimson-bright hover:border-crimson-bright',
};

const BASE =
  'inline-flex items-center justify-center gap-1.5 h-8 rounded-sm border text-[13px] font-medium ' +
  'whitespace-nowrap select-none transition-colors disabled:opacity-40 disabled:pointer-events-none';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  /** Square button for a single icon or symbol */
  square?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'default', square = false, className = '', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${BASE} ${square ? 'w-8 px-0' : 'px-3'} ${TONES[tone]} ${className}`}
      {...props}
    />
  );
});

/**
 * Buttons joined into one control, so related actions read as a unit.
 * Children are Buttons; their borders collapse into shared dividers. With
 * `track`, the group sits in a dark strip, for the toolbar's borderless buttons.
 */
export function ButtonGroup({
  children,
  label,
  track = false,
}: {
  children: React.ReactNode;
  label: string;
  track?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex *:rounded-none [&>*:first-child]:rounded-l [&>*:last-child]:rounded-r [&>*+*]:-ml-px ${
        track ? 'rounded bg-ground' : ''
      }`}
    >
      {children}
    </div>
  );
}

/** A thin vertical rule between toolbar groups. */
export const Divider = () => <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line" />;

/** A keyboard shortcut hint, e.g. <Kbd>F</Kbd>. */
export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="min-w-5 rounded-sm border border-line bg-ground px-1 py-px text-center font-sans text-[11px] text-muted">
    {children}
  </kbd>
);

/** Shared look for text and number inputs. */
export const inputClass =
  'h-8 rounded-sm border border-line bg-ground px-2 text-[13px] text-ink tabular-nums ' +
  'placeholder:text-muted focus:border-gold focus:outline-hidden ' +
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** While it moves, and once more with `done` when it is let go (or a key changed it) */
  onChange: (value: number, done: boolean) => void;
  className?: string;
}

/** A range input that reports every step, and says when it is let go so the value can be saved once. */
export function Slider({ label, value, min, max, step, onChange, className = 'w-28' }: SliderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
    <input
      ref={inputRef}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value), false)}
      aria-label={label}
      className={`${className} accent-gold`}
    />
  );
}
