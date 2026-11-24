// Color profiles: custom LUT styles (learned from a CapCut export or imported .cube) and saved adjustment profiles.
const SK = 'kaleidoscope.styles', PK = 'kaleidoscope.profiles';
const get = k => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } };
const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

export const customStyles = () => get(SK);
export function addStyle(name, bytes, n) {
  let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  const st = { id: 'u' + Date.now().toString(36), name, n, data: btoa(s) };
  const all = get(SK); all.push(st); if (!put(SK, all)) return null; return st;
}
export function removeStyle(id) { put(SK, get(SK).filter(s => s.id !== id)); }
export function renameStyle(id, name) { const a = get(SK); const s = a.find(x => x.id === id); if (s) { s.name = name; put(SK, a); } }

export const profiles = () => get(PK);
export function addProfile(name, color, fx) { const a = get(PK); const p = { id: 'r' + Date.now().toString(36), name, color: { ...color }, fx: fx ? JSON.parse(JSON.stringify(fx)) : null }; a.unshift(p); put(PK, a); return p; }
export function removeProfile(id) { put(PK, get(PK).filter(p => p.id !== id)); }

// ---- .cube import (any size, resampled to <= 33) ----
export function parseCube(text) {
  let n = 0; const vals = []; let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l[0] === '#') continue;
    if (/^LUT_3D_SIZE/i.test(l)) { n = parseInt(l.split(/\s+/)[1]); continue; }
    if (/^DOMAIN_MIN/i.test(l)) { dmin = l.split(/\s+/).slice(1).map(Number); continue; }
    if (/^DOMAIN_MAX/i.test(l)) { dmax = l.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/i.test(l)) continue;
    const p = l.split(/\s+/).map(Number); if (p.length >= 3 && p.every(x => !isNaN(x))) vals.push(p[0], p[1], p[2]);
  }
  if (!n || vals.length < n * n * n * 3) throw new Error('קובץ הצבע לא תקין');
  const N = Math.min(n, 33), out = new Uint8Array(N * N * N * 4);
  const sample = (r, g, b, ch) => { const i = ((b * n + g) * n + r) * 3 + ch; return vals[i]; };
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const sr = Math.round(r * (n - 1) / (N - 1)), sg = Math.round(g * (n - 1) / (N - 1)), sb = Math.round(b * (n - 1) / (N - 1));
    const o = ((b * N + g) * N + r) * 4;
    for (let ch = 0; ch < 3; ch++) { const v = (sample(sr, sg, sb, ch) - dmin[ch]) / ((dmax[ch] - dmin[ch]) || 1); out[o + ch] = Math.max(0, Math.min(255, Math.round(v * 255))); }
    out[o + 3] = 255;
  }
  return { bytes: out, n: N };
}

// ---- learn a style from a CapCut export of the calibration master ----
const W = 1080, H = 1920, C = 32, COLS = 33, ROWS = 60, X0 = 12, N = 17, PER = COLS * (ROWS - 2);
function cellsOf(px, row) {
  const out = new Float32Array(COLS * 3), y0 = row * C + 8;
  for (let c = 0; c < COLS; c++) {
    const x0 = X0 + c * C + 8; let r = 0, g = 0, b = 0, k = 0;
    for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 16; x++) { const i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; k++; }
    out[c * 3] = r / k; out[c * 3 + 1] = g / k; out[c * 3 + 2] = b / k;
  }
  return out;
}
function pageOf(px) {
  const top = cellsOf(px, 0), lum = i => (top[i * 3] + top[i * 3 + 1] + top[i * 3 + 2]) / 3;
  let hi = 0, lo = 0; for (let c = 0; c < COLS; c++) (c % 2 ? (lo += lum(c)) : (hi += lum(c)));
  hi /= 17; lo /= 16; if (hi - lo < 25) return null; const thr = (hi + lo) / 2;
  for (let c = 0; c < COLS; c++) if ((lum(c) > thr) !== (c % 2 === 0)) return null;
  const bot = cellsOf(px, ROWS - 1), bl = i => (bot[i * 3] + bot[i * 3 + 1] + bot[i * 3 + 2]) / 3;
  for (let c = 8; c < COLS; c++) if ((bl(c) > thr) !== (c % 2 === 1)) return null;
  let p = 0; for (let i = 0; i < 8; i++) if (bl(i) > thr) p |= 1 << i; return p;
}
// grab(t) must resolve to a drawable frame source at time t (video seeked there)
export async function learnFromExport(video, grab, onStatus) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const acc = {}; const dur = video.duration;
  for (let t = .4; t < dur - .1; t += .45) {
    onStatus && onStatus(Math.min(.95, t / dur));
    await grab(t); ctx.drawImage(video, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data; const p = pageOf(px); if (p == null || p > 2) continue;
    const rows = []; for (let r = 1; r < ROWS - 1; r++) rows.push(cellsOf(px, r));
    (acc[p] = acc[p] || []).push(rows);
  }
  for (const p of [0, 1, 2]) if (!acc[p]) throw new Error('לא זוהה סרטון כיול בקובץ (חסר חלק ' + (p + 1) + ')');
  const out = new Uint8Array(N * N * N * 4); let idx = 0;
  for (const p of [0, 1, 2]) {
    const frames = acc[p];
    for (let r = 0; r < ROWS - 2 && idx < N * N * N; r++) for (let c = 0; c < COLS && idx < N * N * N; c++, idx++) {
      for (let ch = 0; ch < 3; ch++) { const v = frames.map(f => f[r][c * 3 + ch]).sort((a, b) => a - b); out[idx * 4 + ch] = Math.round(v[v.length >> 1]); }
      out[idx * 4 + 3] = 255;
    }
  }
  // sanity: identity distance tells whether a filter was applied at all
  let diff = 0; for (let i = 0; i < N * N * N; i++) { const r = i % N, g = ((i / N) | 0) % N, b = (i / N / N) | 0; const lv = k => Math.round(k * 255 / 16);
    diff += Math.abs(out[i * 4] - lv(r)) + Math.abs(out[i * 4 + 1] - lv(g)) + Math.abs(out[i * 4 + 2] - lv(b)); }
  return { bytes: out, n: N, strength: diff / (N * N * N * 3), pages: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.length])) };
}
