// Keys: their names as the person's keyboard shows them, and who gets a key
// press (a text field or a shortcut). On a Mac, Cmd stands in for
// Ctrl and Option for Alt (the app accepts both), and full screen is the
// system's Ctrl+Cmd+F rather than F11.

export const IS_MAC = /Mac/i.test(navigator.platform);

/** Ctrl held, or Cmd on a Mac: the key that snaps to the grid, and zooms with the wheel. */
export const ctrlHeld = (event: { ctrlKey: boolean; metaKey: boolean }) => event.ctrlKey || event.metaKey;

/** True when a key press should go to a text field rather than a shortcut. */
export const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** A shortcut written for Windows, as a Mac user would press it. */
export function keyLabel(text: string): string {
  if (!IS_MAC) return text;
  return text
    .replace(/\bCtrl\+Shift\+I\b/g, 'Option+Cmd+I')
    .replace(/\bCtrl\b/g, 'Cmd')
    .replace(/\bAlt\b/g, 'Option')
    .replace(/\bF11\b/g, 'Ctrl+Cmd+F');
}
