// A small note anchored beneath the button that opened it, for a message
// with an action, such as what True scale still needs. Not modal: it closes
// on an outside click, Escape, or when the window loses focus.

import React, { useRef } from 'react';
import { useAnchoredPopup } from './popup';

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The button it belongs to; it is placed right beneath it */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Names the popover for screen readers */
  label: string;
  children: React.ReactNode;
}

export function Popover({ open, onClose, anchorRef, label, children }: PopoverProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPopup(open, onClose, anchorRef, popupRef);
  if (!open) return null;
  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={label}
      className="fixed z-50 w-72 rounded-sm border border-line-strong bg-panel p-3 text-[13px] leading-relaxed text-ink"
      style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
    >
      {children}
    </div>
  );
}
