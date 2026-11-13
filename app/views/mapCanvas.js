import { h } from '../dom.js';
import { projector } from '../format.js';

const PALETTE = ['#9b72f5', '#34d399', '#fbbf24', '#f472b6', '#67e8f9', '#fb923c'];

// Tile-free route sketch (no third-party map): route lines per participant + the meetup point.
// An adjacent text list of the same routes is always provided by the plan view (accessible alternative).
export function routeCanvas(journeys, meet, names, venue = null) {
  const lines = journeys.map(j => j.detail?.geometry).filter(g => g?.length >= 2);
  if (!lines.length) return null;
  const W = 640, H = 360, dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const canvas = h('canvas', { width: W * dpr, height: H * dpr, role: 'img', 'aria-label': `Sketch of ${lines.length} route(s) converging on the meetup point. Details are listed below.`, style: 'width:100%;max-width:640px;height:auto;aspect-ratio:16/9;background:#0b1220;border-radius:8px' });
  if (venue) canvas.setAttribute('aria-label', `${canvas.getAttribute('aria-label')} Selected place: ${venue.name}.`);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);
  const all = lines.flat(); all.push([meet.lat, meet.lon]); if (venue) all.push([venue.lat, venue.lon]);
  const P = projector(all, W, H);
  journeys.forEach((j, i) => {
    const g = j.detail?.geometry; if (!g?.length) return;
    ctx.strokeStyle = PALETTE[i % PALETTE.length]; ctx.lineWidth = 3; ctx.setLineDash(i % 2 ? [8, 5] : []); // dash pattern differs too (not colour only)
    ctx.beginPath(); g.forEach((pt, k) => { const [x, y] = P(pt); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    const [sx, sy] = P(g[0]); ctx.setLineDash([]); ctx.fillStyle = PALETTE[i % PALETTE.length]; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#e5e7eb'; ctx.font = '12px system-ui'; ctx.fillText(String(names[j.participantId] ?? `P${i + 1}`).slice(0, 14), sx + 9, sy - 8);
  });
  const [mx, my] = P([meet.lat, meet.lon]);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(mx, my, 9, 0, 7); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px system-ui'; ctx.fillText('Meetup', mx + 13, my + 4);
  if (venue) {                                    // the place the group is looking at: a diamond with its name (the list below remains the accessible alternative)
    const [vx, vy] = P([venue.lat, venue.lon]);
    ctx.fillStyle = '#fbbf24'; ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(vx, vy - 9); ctx.lineTo(vx + 9, vy); ctx.lineTo(vx, vy + 9); ctx.lineTo(vx - 9, vy); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.fillText(String(venue.name).slice(0, 22), vx + 12, vy + 4);
  }
  return canvas;
}
