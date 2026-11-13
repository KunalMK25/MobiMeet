// Pure helpers for the Metro map (unit-tested in Node).
// path: ordered station keys of a journey; positions: station key → {x,y} on the abstract schematic grid.
export function routePoints(path, positions) {
  return (path ?? []).map(k => positions[k]).filter(Boolean);
}
// Scale schematic space (0..gridW × 0..gridH) into a canvas box, preserving aspect ratio, with padding.
export function fitTransform(gridW, gridH, w, h, pad = 12) {
  const s = Math.min((w - 2 * pad) / gridW, (h - 2 * pad) / gridH);
  const offX = (w - gridW * s) / 2, offY = (h - gridH * s) / 2;
  return ({ x, y }) => [offX + x * s, offY + y * s];
}
// Crop the grid to the bounding box of the points that matter (route + meetup) so small trips are not tiny.
export function boundsOf(points, pad = 60, gridW = 1000, gridH = 1000) {
  if (!points.length) return { x0: 0, y0: 0, w: gridW, h: gridH };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
  return { x0, y0, w: Math.min(gridW, Math.max(...xs) + pad) - x0, h: Math.min(gridH, Math.max(...ys) + pad) - y0 };
}
