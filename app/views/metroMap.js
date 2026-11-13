import { h } from '../dom.js';
import { SCHEMATIC, LINE_GEOMETRY_CACHE } from '../../src/rendering/schematic.js';
import { routePoints, fitTransform, boundsOf } from '../metroGeometry.js';

const PALETTE = ['#9b72f5', '#34d399', '#fbbf24', '#f472b6', '#67e8f9', '#fb923c'];

// Schematic Metro map (same evenly-spaced layout as the classic planner): all lines faint, each participant's route
// highlighted (colour AND dash pattern differ), the meetup station marked. A text list of the same routes is always
// shown next to it, so the map is never the only way to read a route.
export function metroCanvas(journeys, meetKey, names) {
  const routes = journeys.map(j => ({ j, pts: routePoints(j.detail?.path, SCHEMATIC) })).filter(r => r.pts.length >= 1);
  if (!routes.length || !SCHEMATIC[meetKey]) return null;
  const W = 640, H = 420, dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const canvas = h('canvas', { width: W * dpr, height: H * dpr, role: 'img', 'aria-label': `Metro map: ${routes.length} route(s) to ${meetKey}. The same routes are listed in the table.`, style: 'width:100%;max-width:640px;height:auto;aspect-ratio:32/21;background:#0b1220;border-radius:8px' });
  const ctx = canvas.getContext?.('2d'); if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  const b = boundsOf([...routes.flatMap(r => r.pts), SCHEMATIC[meetKey]]);
  const fit = fitTransform(b.w, b.h, W, H), P = (p) => fit({ x: p.x - b.x0, y: p.y - b.y0 });

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const line of LINE_GEOMETRY_CACHE) {                                   // network backdrop
    ctx.strokeStyle = line.color + '55'; ctx.lineWidth = 3; ctx.beginPath();
    line.points.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  }
  routes.forEach(({ j, pts }, i) => {
    const color = PALETTE[i % PALETTE.length];
    ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.setLineDash(i % 2 ? [10, 6] : []);
    ctx.beginPath(); pts.forEach((p, k) => { const [x, y] = P(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
    const [sx, sy] = P(pts[0]); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7); ctx.fill();
    ctx.fillStyle = '#e5e7eb'; ctx.font = '12px system-ui'; ctx.fillText(String(names[j.participantId] ?? `P${i + 1}`).slice(0, 14), sx + 10, sy - 9);
  });
  const [mx, my] = P(SCHEMATIC[meetKey]);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(mx, my, 10, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px system-ui'; ctx.fillText(meetKey, mx + 14, my + 4);
  return canvas;
}
