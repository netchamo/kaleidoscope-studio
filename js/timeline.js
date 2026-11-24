// Timeline helpers: clip placement, fades and zoom curves.
export function layout(p) {
  let t = 0; const out = [];
  for (const c of p.clips) { const len = Math.max(0.05, c.out - c.in); out.push({ clip: c, start: t, len }); t += len; }
  return { items: out, total: t };
}
export function at(p, t) {
  const L = layout(p);
  for (let i = 0; i < L.items.length; i++) { const it = L.items[i]; if (t < it.start + it.len || i === L.items.length - 1) return { ...it, index: i, local: Math.min(it.len, Math.max(0, t - it.start)) }; }
  return null;
}
export function videoFade(c, local, len) {
  let f = 0;
  if (c.fadeIn > 0 && local < c.fadeIn) f = Math.max(f, 1 - local / c.fadeIn);
  if (c.fadeOut > 0 && local > len - c.fadeOut) f = Math.max(f, 1 - (len - local) / c.fadeOut);
  return Math.min(1, Math.max(0, f));
}
export function audioGain(c, local, len) {
  let g = (c.vol ?? 100) / 100;
  if (c.aFadeIn > 0 && local < c.aFadeIn) g *= local / c.aFadeIn;
  if (c.aFadeOut > 0 && local > len - c.aFadeOut) g *= Math.max(0, (len - local) / c.aFadeOut);
  return c.audio ? Math.max(0, g) : 0;
}
const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
// zooms: [{t0,t1,s,x,y,ramp}] in timeline-local clip seconds
export function zoomAt(c, local) {
  for (const z of c.zooms || []) {
    if (local < z.t0 || local > z.t1) continue;
    const r = z.ramp ?? .4;
    const k = Math.min(ease((local - z.t0) / r), ease((z.t1 - local) / r));
    const s = 1 + (z.s - 1) * k;
    const lim = 1 / (2 * s);
    return { s, x: Math.min(1 - lim, Math.max(lim, .5 + (z.x - .5) * k)), y: Math.min(1 - lim, Math.max(lim, .5 + (z.y - .5) * k)) };
  }
  return null;
}
export function fmt(t) { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
