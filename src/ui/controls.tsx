// Buttons and grouped controls. One height (32px), one radius, flat fills and
// 1px borders. Gold marks the active choice; crimson marks anything players
// can see change.

import React from 'react';

type Tone = 'default' | 'quiet' | 'active' | 'live';

const TONES: Record<Tone, string> = {
  default: 'bg-raised border-line text-ink hover:border-line-strong hover:bg-raised-hover',
  quiet: 'bg-transparent border-transparent text-muted hover:text-ink hover:bg-raised',
  active: 'bg-gold border-gold text-ground hover:bg-gold-bright hover:border-gold-bright',
  live: 'bg-crimson border-crimson text-ink hover:bg-crimson-bright hover:border-crimson-bright',
};

const BASE =
  'inline-flex items-center justify-center gap-1.5 h-8 rounded border text-[13px] font-medium ' +
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
 * Children are Buttons; their borders collapse into shared dividers.
 */
export function ButtonGroup({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex [&>*]:rounded-none [&>*:first-child]:rounded-l [&>*:last-child]:rounded-r [&>*+*]:-ml-px"
    >
      {children}
    </div>
  );
}

/** A thin vertical rule between toolbar groups. */
export const Divider = () => <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />;

/** A keyboard shortcut hint, e.g. <Kbd>F</Kbd>. */
export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="min-w-[1.25rem] rounded border border-line bg-ground px-1 py-px text-center font-sans text-[11px] text-muted">
    {children}
  </kbd>
);

/** Shared look for text and number inputs. */
export const inputClass =
  'h-8 rounded border border-line bg-ground px-2 text-[13px] text-ink tabular-nums ' +
  'placeholder:text-faint focus:border-gold focus:outline-none ' +
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';
