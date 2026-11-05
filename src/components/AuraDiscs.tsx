// Soft aura discs (e.g. Spirit Guardians), drawn the same way in both windows.
//
// A static SVG in map coordinates, placed inside the rotated map container:
// a radial gradient gives the soft edge, so there is no filter and no work
// per frame. Nothing is mounted when the map has no circles. Poison gets the
// same dark hatch as painted poison, so it doesn't rely on hue alone.

import type { AuraDisc } from '../types/map';
import type { Size } from '../lib/geometry';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';

/** Fill strength of the disc body; the rim fades to nothing. */
const DISC_OPACITY = 0.4;
/** Where the rim starts fading, as a share of the radius: a thin soft edge, so
 * the disc stays solid over every square it covers. */
const RIM_START = 0.94;

export function AuraDiscs({ discs, media }: { discs: AuraDisc[]; media: Size | null }) {
  if (!media || discs.length === 0) return null;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${media.w} ${media.h}`}
      preserveAspectRatio="none"
    >
      <defs>
        {EFFECT_KINDS.map((kind) => (
          <radialGradient key={kind} id={`aura-${kind}`}>
            <stop offset="0" stopColor={EFFECT_STYLES[kind].color} stopOpacity={DISC_OPACITY} />
            <stop offset={RIM_START} stopColor={EFFECT_STYLES[kind].color} stopOpacity={DISC_OPACITY} />
            <stop offset="1" stopColor={EFFECT_STYLES[kind].color} stopOpacity={0} />
          </radialGradient>
        ))}
        {/* Fades the hatch with the same soft rim as the disc */}
        <radialGradient id="aura-fade">
          <stop offset={RIM_START} stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="aura-fade-mask" maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" fill="url(#aura-fade)" />
        </mask>
      </defs>
      {discs.map((disc, index) => {
        const hatch = EFFECT_STYLES[disc.kind].hatch;
        // Stripes scale with the disc, so they read the same at any size
        const stripe = Math.max(4, disc.radius / 8);
        return (
          <g key={index}>
            <circle cx={disc.x} cy={disc.y} r={disc.radius} fill={`url(#aura-${disc.kind})`} />
            {hatch && (
              <>
                <pattern
                  id={`aura-hatch-${index}`}
                  width={stripe * 2}
                  height={stripe * 2}
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width={stripe * 0.6} height={stripe * 2} fill={hatch} />
                </pattern>
                <circle
                  cx={disc.x}
                  cy={disc.y}
                  r={disc.radius}
                  fill={`url(#aura-hatch-${index})`}
                  mask="url(#aura-fade-mask)"
                  opacity={DISC_OPACITY}
                />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
