// Text and ornament layer: drawn on a 2D canvas, composited by the renderer above the grade.
export const FONTS = [
  { id: 'Heebo', name: 'היבו', weight: 700 },
  { id: 'Rubik', name: 'רוביק', weight: 600 },
  { id: 'Assistant', name: 'אסיסטנט', weight: 300 },
  { id: 'Frank Ruhl Libre', name: 'פרנק רוהל', weight: 500 },
  { id: 'David Libre', name: 'דוד', weight: 500 },
  { id: 'Bellefair', name: 'בלפייר', weight: 400 },
  { id: 'Suez One', name: 'סואץ', weight: 400 },
  { id: 'Secular One', name: 'סקולר', weight: 400 },
  { id: 'Amatic SC', name: 'אמטיק', weight: 700 },
  { id: 'Karantina', name: 'קרנטינה', weight: 400 },
  { id: 'Varela Round', name: 'ורלה', weight: 400 },
  { id: 'Noto Rashi Hebrew', name: 'רש״י', weight: 500 },
];
export const ANIMS = [
  { id: 'fade', name: 'דהייה' }, { id: 'rise', name: 'עלייה' }, { id: 'blur', name: 'מיקוד' },
  { id: 'scale', name: 'נשימה' }, { id: 'type', name: 'הקלדה' }, { id: 'spread', name: 'מרווח' }, { id: 'none', name: 'בלי' },
];
export const DECOS = [
  { id: 'none', name: 'בלי' }, { id: 'lines', name: 'קווים' }, { id: 'frame', name: 'מסגרת' },
  { id: 'pomegranate', name: 'רימון' }, { id: 'branch', name: 'ענף' }, { id: 'stars', name: 'נצנוצים' }, { id: 'dots', name: 'נקודות' },
];
export const COLORS = ['#fff8ef', '#f2c48d', '#e9b46a', '#e79a86', '#c9b8e8', '#a9cbe0', '#1d1512'];

let fontsLinked = false;
export function linkFonts() {
  if (fontsLinked) return; fontsLinked = true;
  const fam = FONTS.map(f => 'family=' + f.id.replace(/ /g, '+') + ':wght@300;400;500;600;700').join('&');
  const l = document.createElement('link'); l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?' + fam + '&display=swap'; document.head.append(l);
}
export async function ensureFont(f, size = 40) {
  const F = FONTS.find(x => x.id === f) || FONTS[0];
  try { await document.fonts.load(`${F.weight} ${size}px "${F.id}"`, 'אבג'); } catch (e) {}
}

export function newText(t0) {
  return { id: 't' + Math.random().toString(36).slice(2, 8), text: 'כותרת', font: 'Frank Ruhl Libre', size: 60, color: '#fff8ef',
    x: .5, y: .78, t0, t1: t0 + 3, anim: 'fade', deco: 'none', glow: 30, shadow: 40, spacing: 0, align: 'center' };
}
const clamp01 = x => Math.max(0, Math.min(1, x));
const ease = x => { x = clamp01(x); return x * x * (3 - 2 * x); };

// ---- ornaments (vector, drawn in text color) ----
function pomegranate(ctx, x, y, s) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.lineWidth = 1.6 / s * s * .06;
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-.35, -.92); ctx.lineTo(-.25, -1.3); ctx.lineTo(-.08, -1.05); ctx.lineTo(0, -1.38); ctx.lineTo(.08, -1.05); ctx.lineTo(.25, -1.3); ctx.lineTo(.35, -.92); ctx.stroke();
  for (const [a, b] of [[-.35, .1], [0, .25], [.35, .1], [-.18, -.25], [.18, -.25]]) { ctx.beginPath(); ctx.arc(a, b, .09, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
function branch(ctx, x, y, s, dir) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s * dir, s); ctx.lineWidth = .06;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(1.6, -.35, 3.2, 0); ctx.stroke();
  for (let i = 0; i < 5; i++) { const px = .5 + i * .6, py = -.12 * Math.sin(i / 4 * Math.PI);
    for (const sgn of [-1, 1]) { ctx.save(); ctx.translate(px, py); ctx.rotate(sgn * .7 - .2); ctx.beginPath(); ctx.ellipse(.22, 0, .25, .09, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); } }
  ctx.restore();
}
function star(ctx, x, y, r) { ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, rr = i % 2 ? r * .28 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); ctx.fill(); }

export function drawTexts(cv, texts, t) {
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  let any = false;
  for (const tx of texts || []) {
    if (t < tx.t0 || t > tx.t1 || !tx.text) continue;
    any = true;
    const F = FONTS.find(f => f.id === tx.font) || FONTS[0];
    const dIn = Math.min(.6, (tx.t1 - tx.t0) / 3), dOut = dIn;
    const pin = ease((t - tx.t0) / dIn), pout = ease((tx.t1 - t) / dOut), p = Math.min(pin, pout);
    const px = tx.size / 1000 * H;
    let alpha = p, dy = 0, sc = 1, blur = 0, spacing = tx.spacing, chars = Infinity;
    switch (tx.anim) {
      case 'none': alpha = 1; break;
      case 'rise': dy = (1 - p) * px * .6; break;
      case 'blur': blur = (1 - p) * px * .25; break;
      case 'scale': sc = .92 + .08 * p + .015 * Math.sin((t - tx.t0) * 2.2); break;
      case 'type': alpha = pout; chars = Math.floor(tx.text.length * clamp01((t - tx.t0) / Math.max(.3, (tx.t1 - tx.t0) * .45))); break;
      case 'spread': spacing = tx.spacing + (1 - p) * 30; break;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(tx.x * W, tx.y * H + dy); ctx.scale(sc, sc);
    ctx.font = `${F.weight} ${px}px "${F.id}", sans-serif`;
    ctx.direction = 'rtl'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    try { ctx.letterSpacing = (spacing / 100 * px) + 'px'; } catch (e) {}
    if (blur > .5) ctx.filter = `blur(${blur}px)`;
    ctx.fillStyle = tx.color; ctx.strokeStyle = tx.color;
    const lines = tx.text.slice(0, chars === Infinity ? undefined : chars).split('\n');
    const lh = px * 1.18, top = -(lines.length - 1) * lh / 2;
    let maxW = 0; for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
    // soft shadow for legibility, then glow
    if (tx.shadow > 0) { ctx.shadowColor = `rgba(0,0,0,${tx.shadow / 100 * .7})`; ctx.shadowBlur = px * .35; ctx.shadowOffsetY = px * .04;
      lines.forEach((l, i) => ctx.fillText(l, 0, top + i * lh)); }
    if (tx.glow > 0) { ctx.shadowColor = tx.color; ctx.shadowBlur = px * .6 * tx.glow / 100; ctx.shadowOffsetY = 0;
      ctx.globalAlpha = alpha * (.4 + .6 * tx.glow / 100); lines.forEach((l, i) => ctx.fillText(l, 0, top + i * lh)); ctx.globalAlpha = alpha; }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    lines.forEach((l, i) => ctx.fillText(l, 0, top + i * lh));
    // decoration
    const bw = maxW / 2 + px * .45, bh = (lines.length * lh) / 2 + px * .3;
    ctx.lineWidth = Math.max(1, px * .035); ctx.globalAlpha = alpha * .9;
    const reveal = tx.anim === 'none' ? 1 : p;
    switch (tx.deco) {
      case 'lines': { const L = bw * reveal; ctx.beginPath(); ctx.moveTo(-L, -bh); ctx.lineTo(L, -bh); ctx.moveTo(-L, bh); ctx.lineTo(L, bh); ctx.stroke(); break; }
      case 'frame': { const r = px * .25; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-bw, -bh, bw * 2, bh * 2, r) : ctx.rect(-bw, -bh, bw * 2, bh * 2); ctx.stroke();
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-bw - px * .12, -bh - px * .12, bw * 2 + px * .24, bh * 2 + px * .24, r * 1.3) : 0; ctx.globalAlpha = alpha * .4; ctx.stroke(); break; }
      case 'pomegranate': pomegranate(ctx, 0, -bh - px * .55, px * .32); break;
      case 'branch': branch(ctx, -bw - px * .15, 0, px * .22, -1); branch(ctx, bw + px * .15, 0, px * .22, 1); break;
      case 'stars': { const tt = t * 2; for (let i = 0; i < 7; i++) { const a = i * 2.39996, r = bw * (.75 + .35 * Math.sin(i * 1.7));
        ctx.globalAlpha = alpha * (.35 + .65 * Math.abs(Math.sin(tt + i))); star(ctx, Math.cos(a) * r, Math.sin(a) * bh * 1.25, px * (.08 + .05 * (i % 3))); } break; }
      case 'dots': { const n = 9; for (let i = 0; i < n; i++) { const x = -bw + i * (bw * 2) / (n - 1); ctx.globalAlpha = alpha * (i / (n - 1) <= reveal ? .8 : 0);
        ctx.beginPath(); ctx.arc(x, bh + px * .1, px * .045, 0, Math.PI * 2); ctx.fill(); } break; }
    }
    ctx.restore();
  }
  return any;
}

// saved "stickers" (text presets) live in localStorage
const SK = 'kaleidoscope.stickers';
export function loadStickers() { try { return JSON.parse(localStorage.getItem(SK) || '[]'); } catch (e) { return []; } }
export function saveSticker(tx) { const s = loadStickers(); const { id, t0, t1, ...rest } = tx; s.unshift({ ...rest, dur: t1 - t0, sid: Date.now() }); try { localStorage.setItem(SK, JSON.stringify(s.slice(0, 40))); } catch (e) {} return s; }
export function removeSticker(sid) { const s = loadStickers().filter(x => x.sid !== sid); try { localStorage.setItem(SK, JSON.stringify(s)); } catch (e) {} return s; }
