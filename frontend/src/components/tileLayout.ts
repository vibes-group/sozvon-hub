// Justified-rows layout for the call tile grid.
//
// Each tile keeps its video's true aspect ratio (no cropping), rows are
// stretched to fill the container width, and the row height is chosen so the
// whole grid fits the available height when it reasonably can — the
// Google-Photos / Google-Meet "justified" look without a full packing solver.

// What can be promoted to the speaker-view stage: a participant's camera or a
// screen share (`id` is the publisher peer id in both cases).
export type StageKind = 'camera' | 'screen';
export type StageTarget = { kind: StageKind; id: string };

export type LayoutInput = { id: string; ar: number };
export type PlacedTile = { id: string; w: number; h: number };
export type LayoutRow = { h: number; tiles: PlacedTile[] };
export type Layout = { rows: LayoutRow[]; height: number };

// Clamp extreme ratios so one ultrawide/ultratall feed can't dictate the whole
// grid; the tile then cover-crops slightly to fill its box.
const MIN_AR = 0.5; // taller than 1:2 → clamp (rare portrait crops)
const MAX_AR = 2.4; // wider than 12:5 → clamp

function clampAr(ar: number): number {
  if (!Number.isFinite(ar) || ar <= 0) return 16 / 9;
  return Math.min(MAX_AR, Math.max(MIN_AR, ar));
}

// Greedy row packing at a fixed target row height: keep appending tiles to a
// row until adding one more would overflow the width, then justify that row to
// fill the width exactly. The trailing row is justified too but capped at the
// target height so a lonely last tile doesn't balloon.
function buildRows(items: LayoutInput[], width: number, gap: number, targetH: number): LayoutRow[] {
  const rows: LayoutRow[] = [];
  let row: { id: string; ar: number }[] = [];
  let arSum = 0;

  const flush = (cap: boolean) => {
    if (!row.length) return;
    const avail = width - gap * (row.length - 1);
    let h = avail / arSum;
    if (cap) h = Math.min(h, targetH);
    rows.push({ h, tiles: row.map((r) => ({ id: r.id, w: r.ar * h, h })) });
    row = [];
    arSum = 0;
  };

  for (const it of items) {
    const ar = clampAr(it.ar);
    row.push({ id: it.id, ar });
    arSum += ar;
    const rowW = arSum * targetH + gap * (row.length - 1);
    if (rowW >= width) flush(false);
  }
  flush(true);
  return rows;
}

function totalHeight(rows: LayoutRow[], gap: number): number {
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + r.h, 0) + gap * (rows.length - 1);
}

/**
 * Lay out `items` (each with an aspect ratio) inside a `width`×`height` box.
 * Picks the largest row height (within [minH, maxH]) that still fits vertically;
 * if even the smallest height overflows (too many tiles), returns the
 * smallest-height layout and the caller scrolls.
 */
export function justifiedLayout(
  items: LayoutInput[],
  width: number,
  height: number,
  gap: number,
  opts?: { minH?: number; maxH?: number },
): Layout {
  if (!items.length || width <= 0) return { rows: [], height: 0 };
  const minH = opts?.minH ?? 90;
  const maxH = Math.max(minH, opts?.maxH ?? height);

  let lo = minH;
  let hi = maxH;
  let best: LayoutRow[] | null = null;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const rows = buildRows(items, width, gap, mid);
    if (totalHeight(rows, gap) <= height) {
      best = rows;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const rows = best ?? buildRows(items, width, gap, minH);
  return { rows, height: totalHeight(rows, gap) };
}
