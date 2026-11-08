// Shared by the dropdown menu and the popover: places a popup below the
// button that opened it (above, when there is no room below), keeps it on
// screen, focuses its first button, and closes it on an outside click,
// Escape, or when the window loses focus. Listeners exist only while open.

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export function useAnchoredPopup(
  open: boolean,
  close: () => void,
  anchorRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
  align: 'left' | 'right' = 'left',
): { top: number; left: number } | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !popupRef.current) return;
    const anchor = anchorRef.current.getBoundingClientRect();
    const popup = popupRef.current.getBoundingClientRect();
    const left = align === 'right' ? anchor.right - popup.width : anchor.left;
    const below = anchor.bottom + 4;
    const top = below + popup.height > window.innerHeight - 8 ? anchor.top - popup.height - 4 : below;
    setPosition({
      top: Math.max(8, top),
      left: Math.min(Math.max(8, left), window.innerWidth - popup.width - 8),
    });
  }, [open, align, anchorRef, popupRef]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popupRef.current?.contains(target) && !anchorRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        anchorRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', close);
    };
  }, [open, close, anchorRef, popupRef]);

  useEffect(() => {
    if (open) popupRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    else setPosition(null);
  }, [open, popupRef]);

  return position;
}
