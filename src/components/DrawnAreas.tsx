// Area templates (circles, squares, cones, lines), drawn the same way in both
// windows.
//
// A static SVG in map coordinates, placed inside the rotated map container.
// A circle uses a radial gradient for a thin soft rim; the other shapes are
// plain polygons with a slightly stronger edge. There is no filter and no work
// per frame, and nothing is mounted when the map has no templates. Poison gets
// the same dark hatch as painted poison, so it doesn't rely on hue alone.
//
// With an area grid, the squares each area covers are outlined too
// (coveredSquares). They are worked out per area, only when that area
// changes: dragging one area doesn't count the others' squares again.

import { memo } from 'react';
import type { AreaGrid, DrawnArea } from '../types/map';
import type { Size } from '../lib/geometry';
import { EFFECT_KINDS, EFFECT_STYLES } from '../lib/effects';
import { areaOutline, coveredSquares, squaresPaths } from '../lib/areas';

/** Fill strength of a template's body. */
const DISC_OPACITY = 0.4;
/** Fill strength of the squares an area covers, over its body */
const SQUARE_OPACITY = 0.2;
/** Where a circle's rim starts fading, as a share of the radius: a thin soft
 * edge, so the disc stays solid over every square it covers. */
const RIM_START = 0.94;

// Memoized: both windows re-render while the player frame moves, and the
// templates only change when they are edited
export const DrawnAreas = memo(function DrawnAreas({
  discs,
  media,
  squares,
}: {
  discs: DrawnArea[];
  media: Size | null;
  /** The grid to outline each area's squares on; null: no squares */
  squares: AreaGrid | null;
}) {
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
        {/* Fades a circle's hatch with the same soft rim as the disc */}
        <radialGradient id="aura-fade">
          <stop offset={RIM_START} stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="aura-fade-mask" maskContentUnits="objectBoundingBox">
          <rect width="1" height="1" fill="url(#aura-fade)" />
        </mask>
      </defs>
      {discs.map((disc, index) => {
        const style = EFFECT_STYLES[disc.kind];
        // Stripes scale with the template, so they read the same at any size
        const stripe = Math.max(4, disc.radius / 8);
        const outline = areaOutline(disc);
        const points = outline?.map((point) => `${point.x},${point.y}`).join(' ');
        const hatchFill = `url(#aura-hatch-${index})`;
        return (
          <g key={index}>
            {style.hatch && (
              <pattern
                id={`aura-hatch-${index}`}
                width={stripe * 2}
                height={stripe * 2}
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width={stripe * 0.6} height={stripe * 2} fill={style.hatch} />
              </pattern>
            )}
            {points ? (
              <>
                <polygon
                  points={points}
                  fill={style.color}
                  fillOpacity={DISC_OPACITY}
                  stroke={style.color}
                  strokeOpacity={0.8}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
                {style.hatch && <polygon points={points} fill={hatchFill} opacity={DISC_OPACITY} />}
              </>
            ) : (
              <>
                <circle cx={disc.x} cy={disc.y} r={disc.radius} fill={`url(#aura-${disc.kind})`} />
                {style.hatch && (
                  <circle
                    cx={disc.x}
                    cy={disc.y}
                    r={disc.radius}
                    fill={hatchFill}
                    mask="url(#aura-fade-mask)"
                    opacity={DISC_OPACITY}
                  />
                )}
              </>
            )}
            {squares && <AreaSquares disc={disc} grid={squares} />}
          </g>
        );
      })}
    </svg>
  );
});

const sameGrid = (a: AreaGrid, b: AreaGrid) =>
  a.cell === b.cell && a.offsetX === b.offsetX && a.offsetY === b.offsetY && a.rule === b.rule;

const sameDisc = (a: DrawnArea, b: DrawnArea) =>
  a.x === b.x &&
  a.y === b.y &&
  a.radius === b.radius &&
  a.kind === b.kind &&
  a.shape === b.shape &&
  a.angle === b.angle &&
  a.width === b.width;

/** The squares one area covers: a light fill, and a crisp outline round them in the area's colour. */
const AreaSquares = memo(
  function AreaSquares({ disc, grid }: { disc: DrawnArea; grid: AreaGrid }) {
    const squares = coveredSquares(disc, grid);
    if (!squares || squares.length === 0) return null;
    const { fill, edge } = squaresPaths(squares, grid);
    const color = EFFECT_STYLES[disc.kind].color;
    return (
      <>
        <path d={fill} fill={color} fillOpacity={SQUARE_OPACITY} shapeRendering="crispEdges" />
        <path
          data-area-squares
          d={edge}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="square"
          vectorEffect="non-scaling-stroke"
        />
      </>
    );
  },
  // Compared by value: the player screen gets a new copy of both with every
  // state message (a zoom step, say), and must not count the squares again
  (previous, next) => sameGrid(previous.grid, next.grid) && sameDisc(previous.disc, next.disc),
);
