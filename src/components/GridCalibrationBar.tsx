// The bar shown above the map while the DM measures the map's grid.
//
// Step 1: click one corner of a grid square. Step 2: click the opposite corner
// of the same square, or of a block of squares for better accuracy. The grid is
// then previewed over the map while the square count and feet are adjusted.

import type { MapGrid, Point } from '../types/map';
import { Button, inputClass } from '../ui/controls';

export interface Calibration {
  /** Corners clicked so far (map natural pixels) */
  points: Point[];
  /** Squares between the two corners, as typed */
  squares: string;
  /** Feet per square, as typed */
  feet: string;
}

interface GridCalibrationBarProps {
  calibration: Calibration;
  preview: MapGrid | null;
  hasGrid: boolean;
  onChange: (calibration: Calibration) => void;
  onSave: () => void;
  onRemove: () => void;
  onCancel: () => void;
}

export function GridCalibrationBar({
  calibration,
  preview,
  hasGrid,
  onChange,
  onSave,
  onRemove,
  onCancel,
}: GridCalibrationBarProps) {
  const step = calibration.points.length;
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && preview) onSave();
    if (event.key === 'Escape') onCancel();
  };

  return (
    <div
      role="region"
      aria-label="Measure the map grid"
      className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-gold/60 bg-panel px-3 py-1.5 text-[13px]"
    >
      <span className="h-2 w-2 rounded-full bg-gold" aria-hidden="true" />
      {step < 2 ? (
        <span className="flex-1 text-ink">
          {step === 0
            ? 'Click one corner of a grid square on the map.'
            : 'Now click the opposite corner of the same square, or of a block of squares for more accuracy.'}
        </span>
      ) : (
        <>
          <label className="flex items-center gap-2 text-muted">
            Squares between the clicks
            <input
              type="number"
              min={1}
              step={1}
              value={calibration.squares}
              onChange={(event) => onChange({ ...calibration, squares: event.target.value })}
              onKeyDown={onKeyDown}
              className={`${inputClass} w-16`}
              aria-label="Squares between the clicks"
            />
          </label>
          <label className="flex items-center gap-2 text-muted">
            Feet per square
            <input
              type="number"
              min={1}
              step={1}
              value={calibration.feet}
              onChange={(event) => onChange({ ...calibration, feet: event.target.value })}
              onKeyDown={onKeyDown}
              className={`${inputClass} w-16`}
              aria-label="Feet per square"
            />
          </label>
          <span className="flex-1 text-muted">
            {preview
              ? `${preview.cell.toFixed(1)} px per square. Check the gold grid; click again to start over.`
              : 'Enter positive numbers.'}
          </span>
        </>
      )}
      {hasGrid && (
        <Button tone="quiet" className="h-7" onClick={onRemove}>
          Remove grid
        </Button>
      )}
      <Button tone="quiet" className="h-7" onClick={onCancel}>
        Cancel
      </Button>
      <Button tone="active" className="h-7" onClick={onSave} disabled={!preview}>
        Save grid
      </Button>
    </div>
  );
}
