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

// Above this tile count we skip the exhaustive partition search (2^(N-1)
// arrangements) and fall back to greedy justified rows + scroll. Real calls
// almost never have this many cameras on at once.
const MAX_ENUM = 12;

// Exhaustively pick the best way to split `items` into contiguous rows so the
// whole grid fits the box AND the tiles are as large as possible. Input order
// is preserved (rows are contiguous), so the result stays consistent with the
// participant ordering. Each row is justified to fill the width, so row heights
// vary by content — two portraits make a tall row, one landscape a short one,
// which is what yields "2 tall tiles on top, 1 wide below" on a phone.
//
// Quality metric: maximize the SMALLEST tile area, so no feed ends up tiny.
// Returns null when nothing fits (every arrangement overflows or undershoots
// minH) — the caller then falls back to the scrolling greedy layout.
function bestFittingLayout(
  items: LayoutInput[],
  width: number,
  height: number,
  gap: number,
  minH: number,
): Layout | null {
  const n = items.length;
  const ars = items.map((it) => clampAr(it.ar));
  let best: Layout | null = null;
  let bestScore = -1;

  // Each of the n-1 gaps between items is either a row break or not.
  const combos = 1 << (n - 1);
  for (let mask = 0; mask < combos; mask++) {
    const rows: LayoutRow[] = [];
    let minArea = Infinity;
    let ok = true;
    let start = 0;
    for (let i = 0; i < n; i++) {
      const isBreak = i === n - 1 || (mask & (1 << i)) !== 0;
      if (!isBreak) continue;
      const count = i - start + 1;
      let arSum = 0;
      for (let j = start; j <= i; j++) arSum += ars[j];
      const h = (width - gap * (count - 1)) / arSum;
      if (h < minH) {
        ok = false;
        break;
      }
      const tiles: PlacedTile[] = [];
      for (let j = start; j <= i; j++) {
        const w = ars[j] * h;
        tiles.push({ id: items[j].id, w, h });
        const area = w * h;
        if (area < minArea) minArea = area;
      }
      rows.push({ h, tiles });
      start = i + 1;
    }
    if (!ok) continue;
    const total = totalHeight(rows, gap);
    if (total > height) continue;
    // Strict `>` so the first arrangement found wins ties → deterministic.
    if (minArea > bestScore) {
      bestScore = minArea;
      best = { rows, height: total };
    }
  }
  return best;
}

/**
 * Lay out `items` (each with an aspect ratio) inside a `width`×`height` box.
 *
 * For a handful of tiles, an exhaustive search picks the row split that fits and
 * makes the tiles as large as possible (adapts to portrait vs landscape boxes).
 * Above MAX_ENUM tiles — or when nothing fits — it falls back to greedy
 * justified rows at the largest row height that fits, scrolling if even the
 * smallest height overflows.
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

  if (items.length <= MAX_ENUM && height > 0) {
    const exact = bestFittingLayout(items, width, height, gap, minH);
    if (exact) return exact;
  }

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
