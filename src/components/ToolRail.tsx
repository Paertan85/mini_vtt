// The tools, in a rail down the left edge of the map, where image editors
// (Photoshop, GIMP, Krita) and other VTTs (Foundry, Roll20) keep them. Each has
// an icon with its name beneath, since icons alone are hard to tell apart
// (NN/g, "Icon usability"); the key is in its tooltip. The current tool is
// tinted in the accent, with a bar at its left edge, as in VS Code's activity
// bar. The tool's options are in the toolbar above the map.

import { memo } from 'react';
import { CloudFog, Flame, MapPin, Ruler, Scan, WandSparkles, type LucideIcon } from 'lucide-react';
import type { Tool } from './MapStage';
import type { DmTools } from '../hooks/useDmController';

interface ToolDef {
  tool: Tool;
  label: string;
  icon: LucideIcon;
  title: string;
  /** Hidden with the Settings → Show the Effects and Spells tools box */
  effect?: boolean;
}

const TOOLS: ToolDef[] = [
  {
    tool: 'view',
    label: 'View',
    icon: Scan,
    title:
      'View (V): drag the frame to move the player view, and scroll over it to zoom. Hold Alt to move it while painting.',
  },
  {
    tool: 'fog',
    label: 'Fog',
    icon: CloudFog,
    title: 'Fog (F): paint fog of war. Left button reveals, right button covers.',
  },
  {
    tool: 'effect',
    label: 'Effects',
    icon: Flame,
    effect: true,
    title: 'Effects (E): paint fire, poison or magic. Left button paints, right button erases.',
  },
  {
    tool: 'shapes',
    label: 'Spells',
    icon: WandSparkles,
    effect: true,
    title: 'Spells (S): place spell areas sized in feet: circles, cubes, cones, lines and emanations.',
  },
  {
    tool: 'measure',
    label: 'Measure',
    icon: Ruler,
    title:
      'Measure (M): drag to see the distance in feet, or click point by point for a path round corners. Double-click or Enter finishes it.',
  },
  {
    tool: 'markers',
    label: 'Markers',
    icon: MapPin,
    title:
      'Markers (K): put down round markers only you see, such as where enemies will appear or something invisible stands.',
  },
];

interface ToolRailProps {
  tool: Tool;
  setTool: DmTools['setTool'];
  hasMap: boolean;
  /** Settings → Show the Effects and Spells tools */
  showEffectTools: boolean;
}

// Memoized: the DM window re-renders on every frame of a drag, and the rail
// changes only with the tool
export const ToolRail = memo(function ToolRail({
  tool: currentTool,
  setTool,
  hasMap,
  showEffectTools,
}: ToolRailProps) {
  return (
    <div
      role="group"
      aria-label="Tool"
      className="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel py-2"
    >
      {TOOLS.filter((def) => showEffectTools || !def.effect).map(({ tool, label, icon: Icon, title }) => {
        const current = currentTool === tool;
        return (
          <button
            key={tool}
            type="button"
            aria-pressed={current}
            onClick={() => setTool(tool)}
            // The View tool works without a map: it is where the app starts
            disabled={tool !== 'view' && !hasMap}
            title={title}
            className={`relative flex h-13 w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-sm text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${
              current
                ? 'bg-accent/15 text-accent-bright before:absolute before:inset-y-2 before:-left-1 before:w-0.5 before:rounded-full before:bg-accent'
                : 'text-ink hover:bg-raised-hover'
            }`}
          >
            <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
            {label}
          </button>
        );
      })}
    </div>
  );
});
