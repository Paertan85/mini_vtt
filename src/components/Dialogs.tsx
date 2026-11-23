// The welcome screen and the keyboard shortcuts list. Settings has its own file.

import { Dialog } from '../ui/Dialog';
import { Button, Kbd } from '../ui/controls';
import { keyLabel } from '../lib/platform';
import { SHORTCUT_GROUPS, waysOf } from '../lib/shortcuts';

// Rows come from lib/shortcuts.ts, which also drives the key handler.

const MOUSE_ACTION = /drag|click|wheel|pinch/i;

/** One way to do something: keys as key caps, mouse actions as words. */
function Way({ way }: { way: string }) {
  const parts = way.split(' + ');
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {parts.map((part, index) => (
        <span key={part} className="flex items-center gap-1">
          {index > 0 && <span className="text-muted">+</span>}
          {MOUSE_ACTION.test(part) ? <span className="text-muted">{part}</span> : <Kbd>{keyLabel(part)}</Kbd>}
        </span>
      ))}
    </span>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      width="w-[24rem] min-[900px]:w-184 min-[1200px]:w-264"
    >
      <div className="gap-x-8 min-[900px]:columns-2 min-[1200px]:columns-3">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="mb-4 break-inside-avoid last:mb-0">
            <h3 className="border-b border-line pb-1 font-display text-[13px] font-semibold tracking-wide text-ink">
              {group.title}
            </h3>
            {group.note && <p className="mt-1 text-xs text-muted">{group.note}</p>}
            <dl className="mt-1.5 flex flex-col gap-0.5 text-[13px]">
              {group.shortcuts.map(([action, ways, note]) => (
                <div key={action} className="flex items-start justify-between gap-3">
                  <dt className="leading-6 text-ink">
                    {action}
                    {note && (
                      <span className="-mt-0.5 block text-xs leading-4 text-muted">{keyLabel(note)}</span>
                    )}
                  </dt>
                  {/* A fixed height and line height, so rows with key caps are as tall as the rest */}
                  <dd className="flex h-6 shrink-0 items-center justify-end gap-x-1.5 leading-4">
                    {ways.flatMap(waysOf).map((way, index) => (
                      <span key={way} className="flex items-center gap-1.5">
                        {index > 0 && <span className="text-muted">or</span>}
                        <Way way={way} />
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

interface WelcomeDialogProps {
  /** Whether it opens on start-up; the checkbox says the opposite */
  showOnStartup: boolean;
  onShowOnStartupChange: (show: boolean) => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onClose: () => void;
}

const welcomeHeading = 'font-display text-[13px] font-semibold tracking-wide text-ink';
const welcomeList = 'mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-relaxed text-muted';

/** Opens on start-up until turned off, and again from the menu (☰). */
export function WelcomeDialog({
  showOnStartup,
  onShowOnStartupChange,
  onOpenSettings,
  onOpenShortcuts,
  onClose,
}: WelcomeDialogProps) {
  return (
    <Dialog
      title="Welcome to Mini VTT"
      onClose={onClose}
      width="w-136"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={!showOnStartup}
              onChange={(event) => onShowOnStartupChange(!event.target.checked)}
              className="h-4 w-4 accent-gold"
            />
            Don’t show on start-up
          </label>
          <Button onClick={onOpenShortcuts}>Keyboard shortcuts</Button>
          <Button tone="active" onClick={onClose} data-autofocus>
            Get started
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink">
        Mini VTT shows your maps on a screen at the table: a TV lying flat, a monitor or a projector. This
        window is yours: pick maps, paint fog of war and choose what the players see. The player screen shows
        only that, with unexplored areas in black.
      </p>

      <h3 className={`mt-4 ${welcomeHeading}`}>Ready as soon as you add a map</h3>
      <ul className={welcomeList}>
        <li>
          Click <span className="text-ink">Add maps…</span> in the library, or drop images or WebM videos onto
          it. New maps start without fog; tick <span className="text-ink">Cover new maps in fog</span> in
          Settings (<Kbd>{keyLabel('Ctrl+,')}</Kbd>) to have them start fully fogged.
        </li>
        <li>
          Click <span className="text-ink">Open player screen</span>. With the table screen connected, it
          opens full screen there; on a single screen, drag the window where you want it and press{' '}
          <Kbd>{keyLabel('F11')}</Kbd> for full screen.
        </li>
        <li>Drag the frame to choose what the players see, and paint with the Fog tool to reveal the map.</li>
      </ul>

      <h3 className={`mt-4 ${welcomeHeading}`}>Some things need setting up first</h3>
      <ul className={welcomeList}>
        <li>
          <span className="text-ink">True scale</span> zooms a map so its squares match your miniatures. It
          needs the screen’s diagonal and your grid square size, set once in{' '}
          <button
            type="button"
            onClick={onOpenSettings}
            className="text-gold underline decoration-gold/40 underline-offset-2 hover:text-gold-bright"
          >
            Settings
          </button>
          .
        </li>
        <li>
          <span className="text-ink">Spell areas and the Measure tool</span> need each map’s grid: open Menu
          (☰) → Measure map grid… and click two corners of a square. Maps whose names give their size, such
          as <span className="text-ink">forest_32x32.jpg</span>, get it as they are added.
        </li>
      </ul>

      <p className="mt-4 text-xs leading-relaxed text-muted">Menu (☰) → Welcome… brings this back.</p>
    </Dialog>
  );
}
