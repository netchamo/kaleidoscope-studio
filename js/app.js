// Kaleidoscope — app shell: home, editor, timeline, panels, playback.
import { Renderer } from './gl.js';
import { detectTransfer } from './media.js';
import { layout, at, videoFade, audioGain, zoomAt, fmt } from './timeline.js';
import { buildChain, REVERBS, DELAY_NOTES, meterLevels, detectBeats, decodeFile } from './audio.js';
import { FONTS, ANIMS, DECOS, COLORS, linkFonts, ensureFont, newText, drawTexts, loadStickers, saveSticker, removeSticker } from './text.js';
import { exportProject, outSize } from './export.js';
import { store, newProject, newClip, STYLES, LOOKS, PRESETS, FX_DEFAULT, COLOR_DEFAULT } from './state.js';

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) e.setAttribute(k, v); }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k)); return e; };
const LOG = [];
export function log(m) { LOG.push(new Date().toLocaleTimeString('he-IL') + '  ' + m); if (LOG.length > 300) LOG.shift(); }
addEventListener('error', e => log('שגיאה: ' + (e.message || e)));
addEventListener('unhandledrejection', e => log('שגיאה: ' + (e.reason && e.reason.message || e.reason)));
function busy(msg, sub) { const b = $('#busy'); if (!msg) { b.hidden = true; return; } b.hidden = false; $('#busyMsg').textContent = msg; $('#busySub').textContent = sub || ''; }
let toastT; function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

/* ================= state ================= */
let P = null;                 // current project
const media = {};             // clipId -> { video, file, hdr, url }
const files = {};             // fileKey -> File/Blob (in memory)
let musicFile = null, musicEl = null;
let sel = null;               // selected clip id
let T = 0, playing = false, curIdx = -1;
let renderer = null;
let saveT = null;
let hist = [], fut = [], lastSnap = null;
function snapshot() { if (!P) return; const s = JSON.stringify({ clips: P.clips, color: P.color, fx: P.fx, audio: P.audio, music: P.music, texts: P.texts, beats: P.beats });
  if (s === lastSnap) return; if (lastSnap) { hist.push(lastSnap); if (hist.length > 80) hist.shift(); fut = []; } lastSnap = s; updUndo(); }
function restore(s) { const o = JSON.parse(s); Object.assign(P, o); for (const c of P.clips) if (!media[c.id]) { const src = Object.values(media).find(m => m.fileKey === c.fileKey); if (src) media[c.id] = { ...src, video: makeVideo(files[c.fileKey]) }; }
  lastSnap = s; if (!P.clips.find(c => c.id === sel)) sel = P.clips[0]?.id; renderTimeline(); renderPanel(); seekTo(T); store.save(P); updUndo(); }
function undo() { if (!hist.length) return; fut.push(lastSnap); restore(hist.pop()); toast('בוטל'); }
function redo() { if (!fut.length) return; hist.push(lastSnap); restore(fut.pop()); }
function updUndo() { $('#undoBtn').disabled = !hist.length; $('#redoBtn').disabled = !fut.length; }
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { if (!P) return; snapshot(); store.save(P); }, 450); };
const changed = (redraw = true) => { save(); if (redraw) requestDraw(); };

/* ================= home ================= */
async function showHome() {
  stop(); $('#editor').hidden = true; $('#home').hidden = false;
  const list = await store.list(); const box = $('#projects'); box.innerHTML = '';
  for (const p of list) {
    const total = (p.clips || []).reduce((a, c) => a + (c.out - c.in), 0);
    const del = el('button', { class: 'del', 'aria-label': 'מחיקה' }, '✕');
    del.addEventListener('click', async e => { e.stopPropagation();
      if (!del.classList.contains('arm')) { del.classList.add('arm'); toast('לחיצה נוספת תמחק את הפרויקט'); setTimeout(() => del.classList.remove('arm'), 2500); return; }
      for (const c of p.clips) await store.delFile(c.fileKey); if (p.music) await store.delFile(p.music.fileKey);
      await store.remove(p.id); showHome(); });
    box.append(el('div', { class: 'pcard', onclick: () => openProject(p) },
      p.thumb ? el('img', { src: p.thumb, alt: '' }) : null,
      el('div', { class: 'meta' }, el('b', {}, p.name), el('span', {}, fmt(total) + ' · ' + new Date(p.updated).toLocaleDateString('he-IL'))), del));
  }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#installTip').hidden = standalone || !/iPhone|iPad/.test(navigator.userAgent);
}
$('#newFiles').addEventListener('change', async e => {
  const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return;
  P = newProject('פרויקט ' + new Date().toLocaleDateString('he-IL'));
  for (const k in media) delete media[k];
  hist = []; fut = []; lastSnap = null;
  const n = await addFiles(fs); if (!n) { toast('לא הצלחתי לפתוח את הסרטון. פרטים ביומן.'); return; }
  await store.save(P); enterEditor();
});

/* ================= media loading ================= */
function makeVideo(blob) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('muted', '');
  v.preload = 'auto'; $('#hiddenMedia').append(v);
  v.src = URL.createObjectURL(blob); v.load();
  return v;
}
const once = (o, ev, ms) => new Promise(r => { let done = false; const f = () => { if (!done) { done = true; o.removeEventListener(ev, f); r(true); } };
  o.addEventListener(ev, f); if (ms) setTimeout(() => { if (!done) { done = true; o.removeEventListener(ev, f); r(false); } }, ms); });
// iOS Safari does not decode a frame for an idle video; metadata first, then a short muted play to get pixels.
async function loaded(v) {
  if (v.readyState < 1 && !(await Promise.race([once(v, 'loadedmetadata', 20000), once(v, 'error').then(() => 'err')]) === true)) {
    if (v.error || v.readyState < 1) throw new Error('הסרטון לא נטען' + (v.error ? ' (קוד ' + v.error.code + ')' : ''));
  }
  if (v.readyState < 2) {
    const wasMuted = v.muted; v.muted = true;
    try { await v.play(); } catch (e) { log('ניגון ראשוני נחסם: ' + e.message); }
    await Promise.race([once(v, 'timeupdate', 2500), once(v, 'loadeddata', 2500)]);
    v.pause(); v.muted = wasMuted;
    if (v.readyState < 2) await once(v, 'canplay', 3000);
    try { v.currentTime = 0; await once(v, 'seeked', 2000); } catch (e) {}
  }
  log('נטען: ' + v.videoWidth + '×' + v.videoHeight + ' ' + (v.duration || 0).toFixed(1) + 'ש׳ מצב ' + v.readyState);
}
async function attachClip(c) {
  const blob = files[c.fileKey]; if (!blob) return;
  const v = makeVideo(blob); await loaded(v);
  const tr = await detectTransfer(blob);
  media[c.id] = { video: v, file: blob, hdr: tr === 18, fileKey: c.fileKey };
}
async function addFiles(fs) {
  let i = 0, ok = 0;
  for (const f of fs) {
    i++; busy('מייבא סרטון ' + i + ' מתוך ' + fs.length, f.name + ' · ' + (f.size / 1048576).toFixed(0) + ' מגה');
    log('ייבוא ' + f.name + ' ' + f.type + ' ' + (f.size / 1048576).toFixed(1) + 'MB');
    const key = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    files[key] = f;
    try {
      const v = makeVideo(f); await loaded(v);
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
      const c = newClip(key, f.name.replace(/\.[^.]+$/, ''), dur);
      const tr = await detectTransfer(f); log('סוג צבע: ' + tr);
      media[c.id] = { video: v, file: f, hdr: tr === 18, fileKey: key };
      P.clips.push(c); ok++;
      store.putFile(key, f).then(s => { if (!s) { log('שמירה במכשיר נכשלה'); toast('אין מספיק מקום לשמור את הסרטון במכשיר'); } });
      thumbFor(c).then(u => { if (u) { c.thumb = u; if (!P.thumb) P.thumb = u; } renderTimeline(); save(); });
    } catch (e) { log('נכשל: ' + e.message); toast(f.name + ': ' + e.message); }
  }
  busy(null);
  return ok;
}
async function thumbFor(c) {
  const src = media[c.id].video; const v = makeVideo(files[c.fileKey]);
  try { await loaded(v); v.currentTime = Math.min(c.in + .3, c.out); await once(v, 'seeked', 2500);
    const cv = document.createElement('canvas'); const h = 120, w = Math.round(h * (src.videoWidth / src.videoHeight || .5625)); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(v, 0, 0, w, h); return cv.toDataURL('image/jpeg', .7);
  } catch (e) { return null; } finally { URL.revokeObjectURL(v.src); v.remove(); }
}
async function openProject(p) {
  P = p; for (const k in media) delete media[k]; hist = []; fut = []; lastSnap = null;
  P.texts = P.texts || []; P.beats = P.beats || null;
  let i = 0;
  for (const c of P.clips) { busy('טוען פרויקט', ++i + ' מתוך ' + P.clips.length);
    if (!files[c.fileKey]) files[c.fileKey] = await store.getFile(c.fileKey); await attachClip(c).catch(e => log('טעינת קליף נכשלה: ' + e.message)); }
  busy(null);
  P.clips = P.clips.filter(c => media[c.id]);
  if (P.music) { const b = files[P.music.fileKey] || await store.getFile(P.music.fileKey); if (b) setMusic(b, P.music.name, true); else P.music = null; }
  enterEditor();
}

/* ================= editor ================= */
function enterEditor() {
  $('#home').hidden = true; $('#editor').hidden = false;
  $('#projName').value = P.name;
  if (!renderer) { try { renderer = new Renderer($('#view')); } catch (e) { toast('המכשיר לא תומך בעיבוד גרפי'); return; } }
  sel = P.clips[0]?.id || null; T = 0; curIdx = -1;
  P.texts = P.texts || []; linkFonts(); snapshot();
  sizePreview(); renderTimeline(); showTab(currentTab); seekTo(0); updUndo();
}
$('#projName').addEventListener('change', () => { P.name = $('#projName').value.trim() || P.name; save(); });
$('#backBtn').addEventListener('click', () => { store.save(P); showHome(); });
$('#toExport').addEventListener('click', () => showTab('export'));
$('#addFiles').addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; if (!fs.length) return;
  toast('מוסיף…'); await addFiles(fs); renderTimeline(); sizePreview(); renderPanel(); changed(); });
function sizePreview() {
  const c = P.clips[0]; if (!c || !renderer) return;
  const v = media[c.id].video; const [w, h] = outSize(v.videoWidth || 720, v.videoHeight || 1280, 640);
  renderer.setSize(w, h); const st = $('#stage'); st.style.aspectRatio = w + '/' + h;
}

/* ---------- drawing ---------- */
let drawQueued = false;
function requestDraw() { if (drawQueued || playing) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawNow(); }); }
function drawNow() {
  if (!P || !P.clips.length || !renderer) return;
  const a = at(P, T); if (!a) return; const m = media[a.clip.id]; if (!m || m.video.readyState < 2) return;
  const ov = textOverlay(T);
  if (comparing) renderer.draw(m.video, T, NEUTRAL_C, NEUTRAL_FX, m.hdr && P.color.hdr !== 'off', 0, null, null);
  else renderer.draw(m.video, T, P.color, P.fx, m.hdr && P.color.hdr !== 'off', videoFade(a.clip, a.local, a.len), zoomAt(a.clip, a.local), ov);
  updateClock();
}
const NEUTRAL_C = { ...COLOR_DEFAULT, style: null, pal: 0 }, NEUTRAL_FX = { ...FX_DEFAULT };
let comparing = false, overCv = null;
function textOverlay(t) {
  if (!P.texts || !P.texts.length) return null;
  if (!overCv) overCv = document.createElement('canvas');
  const c = renderer.canvas; if (overCv.width !== c.width || overCv.height !== c.height) { overCv.width = c.width; overCv.height = c.height; }
  return drawTexts(overCv, P.texts, t) ? overCv : null;
}
function updateClock() {
  const L = layout(P); $('#tNow').textContent = fmt(T); $('#tTotal').textContent = fmt(L.total);
  const x = 16 + T * pxs(); $('#playhead').style.left = x + 'px';
  if (playing) { const tl = $('#timeline'); const vx = x - tl.scrollLeft; if (vx > tl.clientWidth * .7 || vx < 0) tl.scrollLeft = x - tl.clientWidth * .3; }
}

/* ---------- playback ---------- */
let actx = null, chain = null, analyser = null, musicGain = null;
const srcNodes = new WeakMap();
function ensureAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    chain = buildChain(actx, P.audio); analyser = actx.createAnalyser(); analyser.fftSize = 2048;
    chain.output.connect(analyser); analyser.connect(actx.destination);
  } catch (e) { actx = null; }
}
function routeEl(elm) {
  if (!actx || srcNodes.has(elm)) return srcNodes.get(elm);
  try { const s = actx.createMediaElementSource(elm); const g = actx.createGain(); s.connect(g); g.connect(chain.input); srcNodes.set(elm, g); return g; } catch (e) { return null; }
}
function setPlayIcon() { $('#playBtn').textContent = playing ? '❚❚' : '▶'; }
async function play() {
  if (!P.clips.length) return;
  ensureAudio(); if (chain) chain.update(P.audio);
  const L = layout(P); if (T >= L.total - .05) T = 0;
  playing = true; setPlayIcon(); curIdx = -1;
  if (musicEl && musicGain === null && actx) { musicGain = routeEl(musicEl); }
  loop();
}
function stop() {
  playing = false; setPlayIcon();
  for (const k in media) media[k].video.pause();
  if (musicEl) musicEl.pause();
}
$('#playBtn').addEventListener('click', () => playing ? stop() : play());
$('#view').addEventListener('click', () => { if (!$('#pickLayer').hidden) return; playing ? stop() : play(); });

function loop() {
  if (!playing) return;
  const L = layout(P); const a = at(P, T); if (!a) { stop(); return; }
  const c = a.clip, m = media[c.id], v = m.video;
  if (a.index !== curIdx) {
    for (const k in media) if (k !== c.id) media[k].video.pause();
    curIdx = a.index; v.muted = false; routeEl(v);
    v.currentTime = c.in + a.local; v.play().catch(() => {});
  }
  if (!v.paused && v.readyState >= 2) T = a.start + Math.max(0, v.currentTime - c.in);
  const local = T - a.start;
  const g = srcNodes.get(v); if (g) g.gain.value = audioGain(c, local, a.len); else v.volume = Math.min(1, audioGain(c, local, a.len));
  if (musicEl) syncMusic();
  if (v.currentTime >= c.out - 0.03 || v.ended) {
    if (a.index >= L.items.length - 1) { T = L.total; stop(); drawNow(); return; }
    T = L.items[a.index + 1].start + 0.001; v.pause();
  }
  drawNow(); meterTick();
  if ('requestVideoFrameCallback' in v && !v.paused) v.requestVideoFrameCallback(() => loop()); else requestAnimationFrame(loop);
}
function syncMusic() {
  const mu = P.music; if (!mu) return;
  const local = T - (mu.at || 0), len = (mu.out ?? musicEl.duration) - (mu.in || 0);
  const want = (mu.in || 0) + local;
  if (!playing || local < 0 || local > len) { if (!musicEl.paused) musicEl.pause(); return; }
  if (Math.abs(musicEl.currentTime - want) > .2) musicEl.currentTime = want;
  if (musicEl.paused) musicEl.play().catch(() => {});
  let gv = (P.audio.musicVol ?? 100) / 100;
  if (mu.fadeIn > 0 && local < mu.fadeIn) gv *= local / mu.fadeIn;
  if (mu.fadeOut > 0 && local > len - mu.fadeOut) gv *= Math.max(0, (len - local) / mu.fadeOut);
  if (musicGain) musicGain.gain.value = gv; else musicEl.volume = Math.min(1, gv);
}
function seekTo(t) {
  const L = layout(P); T = Math.max(0, Math.min(t, L.total)); const a = at(P, T); if (!a) return;
  const v = media[a.clip.id].video; curIdx = -1;
  const want = a.clip.in + a.local;
  if (Math.abs(v.currentTime - want) > .01) { v.addEventListener('seeked', () => drawNow(), { once: true }); v.currentTime = want; } else drawNow();
  updateClock();
}

/* ---------- timeline ---------- */
let zoomPx = 60, zoomMul = 1; // px per second
const pxs = () => zoomPx;
function renderTimeline() {
  const L = layout(P); const box = $('#tlClips'); box.innerHTML = '';
  zoomPx = Math.max(12, Math.min(400, (innerWidth - 60) / Math.max(4, L.total) * 1.6 * zoomMul));
  for (const it of L.items) {
    const c = it.clip, w = Math.max(24, it.len * zoomPx - 3);
    const d = el('div', { class: 'clip' + (c.id === sel ? ' sel' : '') });
    d.style.width = w + 'px'; if (c.thumb) d.style.backgroundImage = `url(${c.thumb})`;
    d.append(el('div', { class: 'lbl' }, fmt(it.len)));
    if (!c.audio) d.append(el('div', { class: 'mute' }, '🔇'));
    if (c.fadeIn > 0) { const f = el('div', { class: 'fade' }); f.style.left = 0; f.style.width = c.fadeIn * zoomPx + 'px'; d.append(f); }
    if (c.fadeOut > 0) { const f = el('div', { class: 'fade out' }); f.style.right = 0; f.style.width = c.fadeOut * zoomPx + 'px'; d.append(f); }
    for (const z of c.zooms || []) { const zb = el('div', { class: 'zm' }); zb.style.left = z.t0 * zoomPx + 'px'; zb.style.width = (z.t1 - z.t0) * zoomPx + 'px'; d.append(zb); }
    const hl = el('div', { class: 'h l' }), hr = el('div', { class: 'h r' });
    d.append(hl, hr); trimHandle(hl, c, 'in'); trimHandle(hr, c, 'out');
    d.addEventListener('click', e => { if (sel !== c.id) { sel = c.id; renderTimeline(); renderPanel(); }
      const r = d.getBoundingClientRect(); seekTo(it.start + (e.clientX - r.left) / zoomPx); });
    box.append(d);
  }
  const mbox = $('#tlMusic'); mbox.innerHTML = '';
  if (P.music) { const mu = P.music; const len = Math.min(L.total - (mu.at || 0), (mu.out ?? 9999) - (mu.in || 0));
    const sp = el('div'); sp.style.width = (mu.at || 0) * zoomPx + 'px'; sp.style.flex = 'none';
    const b = el('div', { class: 'music' }, '♪ ' + mu.name); b.style.width = Math.max(30, len * zoomPx) + 'px'; mbox.append(sp, b); }
  const bb = $('#tlBeats'); bb.innerHTML = '';
  if (P.beats && P.beats.length) for (const b of P.beats) { if (b > L.total) break; const k = el('i'); k.style.left = (16 + b * zoomPx) + 'px'; bb.append(k); }
  const tb = $('#tlTexts'); tb.innerHTML = '';
  for (const tx of P.texts || []) { const k = el('div', { class: 'tchip' + (tx.id === selText ? ' sel' : '') }, tx.text.split('\n')[0].slice(0, 18));
    k.style.left = (16 + tx.t0 * zoomPx) + 'px'; k.style.width = Math.max(20, (tx.t1 - tx.t0) * zoomPx) + 'px';
    k.addEventListener('click', e => { e.stopPropagation(); selText = tx.id; showTab('text'); seekTo(tx.t0 + .4); }); tb.append(k); }
  $('#tlInner').style.width = (L.total * zoomPx + innerWidth) + 'px';
  updateClock();
}
function trimHandle(h, c, which) {
  let x0 = 0, v0 = 0;
  h.addEventListener('pointerdown', e => { e.stopPropagation(); h.setPointerCapture(e.pointerId); x0 = e.clientX; v0 = c[which]; stop(); });
  h.addEventListener('pointermove', e => { if (!h.hasPointerCapture(e.pointerId)) return;
    const dv = (e.clientX - x0) / zoomPx; const dur = media[c.id].video.duration || c.dur;
    if (which === 'in') c.in = Math.max(0, Math.min(c.out - .2, v0 + dv)); else c.out = Math.min(dur, Math.max(c.in + .2, v0 + dv));
    const a = layout(P).items.find(i => i.clip === c); seekTo(a.start + (which === 'in' ? 0 : a.len - .03));
    requestAnimationFrame(() => { renderTimeline(); }); });
  h.addEventListener('pointerup', () => { changed(false); renderPanel(); });
  h.addEventListener('click', e => e.stopPropagation());
}
$('#timeline').addEventListener('click', e => { if (e.target.id === 'timeline' || e.target.id === 'tlInner' || e.target.id === 'tlMusic') { const r = $('#tlInner').getBoundingClientRect(); seekTo((e.clientX - r.left - 16) / zoomPx); } });

/* ================= panels ================= */
let currentTab = 'clip';
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
function showTab(t) {
  currentTab = t; document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.panel').forEach(p => p.hidden = p.dataset.panel !== t); setPick(null); renderPanel();
}
function renderPanel() { const p = document.querySelector(`.panel[data-panel="${currentTab}"]`); p.innerHTML = ''; ({ clip: panelClip, color: panelColor, fx: panelFx, text: panelText, audio: panelAudio, export: panelExport })[currentTab](p); }

function slider(label, obj, key, min, max, step = 1, opt = {}) {
  const out = el('output', {}, fmtv(obj[key], opt));
  const inp = el('input', { type: 'range', min, max, step, value: obj[key] });
  inp.addEventListener('input', () => { obj[key] = +inp.value; out.textContent = fmtv(obj[key], opt); opt.onInput ? opt.onInput(obj[key]) : changed(); });
  inp.addEventListener('change', () => { opt.onChange && opt.onChange(obj[key]); save(); });
  inp.addEventListener('dblclick', () => { if (opt.def !== undefined) { obj[key] = opt.def; inp.value = opt.def; out.textContent = fmtv(opt.def, opt); changed(); } });
  return el('div', { class: 'sl' }, el('label', {}, label), inp, out);
}
const fmtv = (v, o) => o.fmt ? o.fmt(v) : (Math.round(v * 10) / 10) + (o.unit || '');
function chips(items, cur, onPick, scroll = false) {
  const box = el('div', { class: scroll ? 'chips-scroll' : 'row' });
  for (const it of items) { const b = el('button', { class: 'chip' + (it.id === cur ? ' on' : '') }, it.name);
    b.addEventListener('click', () => { box.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); b.classList.add('on'); onPick(it); }); box.append(b); }
  return box;
}
function toggle(label, on, onT) { const s = el('div', { class: 'sw' + (on ? ' on' : '') });
  const r = el('div', { class: 'toggle' }, el('span', {}, label), s); r.addEventListener('click', () => { s.classList.toggle('on'); onT(s.classList.contains('on')); }); return r; }
const sec = (title, ...kids) => el('div', { class: 'sec' }, el('h3', {}, title), ...kids);
const selClip = () => P.clips.find(c => c.id === sel);

/* ---------- clip panel ---------- */
function panelClip(p) {
  const c = selClip();
  if (!c) { p.append(el('div', { class: 'hint' }, 'בוחרים קליף בציר הזמן כדי לערוך אותו.')); return; }
  const dur = media[c.id].video.duration || c.dur;
  const idx = P.clips.indexOf(c);
  p.append(sec('קליף ' + (idx + 1) + ' מתוך ' + P.clips.length,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => splitAtPlayhead() }, 'פיצול בסמן'),
      el('button', { class: 'btn', onclick: () => moveClip(-1) }, 'הזזה אחורה'),
      el('button', { class: 'btn', onclick: () => moveClip(1) }, 'הזזה קדימה'),
      el('button', { class: 'btn', onclick: () => dupClip() }, 'שכפול'),
      el('button', { class: 'btn warn', onclick: () => delClip() }, 'מחיקה'))));
  p.append(sec('חיתוך',
    slider('התחלה', c, 'in', 0, dur, .05, { fmt: v => v.toFixed(2) + 'ש׳', onInput: v => { c.in = Math.min(v, c.out - .2); seekClip(c, 0); renderTimeline(); } }),
    slider('סוף', c, 'out', 0, dur, .05, { fmt: v => v.toFixed(2) + 'ש׳', onInput: v => { c.out = Math.max(v, c.in + .2); seekClip(c, c.out - c.in - .03); renderTimeline(); } })));
  const len = c.out - c.in;
  const fadeOpt = k => ({ fmt: v => v.toFixed(1) + 'ש׳', onInput: v => { if (c.linkFades) { if (k === 'fadeIn') c.aFadeIn = v; if (k === 'fadeOut') c.aFadeOut = v; } renderTimeline(); changed(); }, onChange: () => renderPanel() });
  p.append(sec('כניסה ויציאה הדרגתיות',
    toggle('תמונה ושמע יחד', c.linkFades, on => { c.linkFades = on; if (on) { c.aFadeIn = c.fadeIn; c.aFadeOut = c.fadeOut; } renderPanel(); save(); }),
    slider(c.linkFades ? 'כניסה' : 'כניסת תמונה', c, 'fadeIn', 0, Math.min(5, len / 2), .1, fadeOpt('fadeIn')),
    slider(c.linkFades ? 'יציאה' : 'יציאת תמונה', c, 'fadeOut', 0, Math.min(5, len / 2), .1, fadeOpt('fadeOut')),
    c.linkFades ? null : slider('כניסת שמע', c, 'aFadeIn', 0, Math.min(5, len / 2), .1, { fmt: v => v.toFixed(1) + 'ש׳' }),
    c.linkFades ? null : slider('יציאת שמע', c, 'aFadeOut', 0, Math.min(5, len / 2), .1, { fmt: v => v.toFixed(1) + 'ש׳' })));
  p.append(sec('שמע הקליף',
    toggle('להשמיע את הקליף', c.audio, on => { c.audio = on; renderTimeline(); save(); }),
    slider('עוצמה', c, 'vol', 0, 200, 1, { unit: '%' }),
    el('button', { class: 'btn', onclick: () => { P.clips.forEach(x => x.audio = x === c); renderTimeline(); renderPanel(); save(); toast('רק השמע של הקליף הזה פעיל'); } }, 'רק השמע של הקליף הזה')));
  // manual zoom
  const zs = el('div');
  (c.zooms || []).forEach((z, i) => {
    zs.append(el('div', { class: 'glass', style: 'padding:8px 10px;margin:8px 0' },
      el('div', { class: 'row' }, el('b', { style: 'font-size:13px' }, 'זום ' + (i + 1) + ' · ' + z.t0.toFixed(1) + '–' + z.t1.toFixed(1) + 'ש׳'),
        el('button', { class: 'chip', onclick: () => { setPick({ hint: 'גוררים כדי לבחור את מרכז הזום', get: () => [z.x, 1 - z.y], set: (x, y) => { z.x = x; z.y = 1 - y; } }); seekClip(c, (z.t0 + z.t1) / 2); } }, 'מרכז'),
        el('button', { class: 'chip', onclick: () => { c.zooms.splice(i, 1); renderPanel(); renderTimeline(); changed(); } }, 'הסרה')),
      slider('עוצמה', z, 's', 1.1, 3, .05, { fmt: v => '×' + v.toFixed(2) }),
      slider('משך', z, 't1', z.t0 + .5, len, .1, { fmt: v => (v - z.t0).toFixed(1) + 'ש׳', onInput: () => { renderTimeline(); changed(); } }),
      slider('מעבר', z, 'ramp', .05, 1.2, .05, { fmt: v => v.toFixed(2) + 'ש׳' })));
  });
  p.append(sec('זום ידני', el('div', { class: 'hint' }, 'מתקרבים לרגע למשהו אחר ואז חוזרים לתמונה המלאה.'), zs,
    el('button', { class: 'btn primary', onclick: () => { const a = at(P, T); if (!a || a.clip !== c) { seekClip(c, 0); }
      const t0 = Math.max(0, Math.min(len - .6, T - layout(P).items.find(i => i.clip === c).start));
      (c.zooms = c.zooms || []).push({ t0, t1: Math.min(len, t0 + 2), s: 1.6, x: .5, y: .5, ramp: .4 }); renderPanel(); renderTimeline(); changed(); } }, '+ זום מהסמן')));
}
function seekClip(c, local) { const it = layout(P).items.find(i => i.clip === c); if (it) seekTo(it.start + local); }
function splitAtPlayhead() {
  const a = at(P, T); if (!a || a.local < .15 || a.local > a.len - .15) { toast('מזיזים את הסמן לאמצע קליף'); return; }
  const c = a.clip, cut = c.in + a.local; const n = JSON.parse(JSON.stringify(c)); n.id = 'c' + Math.random().toString(36).slice(2, 9);
  c.out = cut; n.in = cut; c.fadeOut = c.aFadeOut = 0; n.fadeIn = n.aFadeIn = 0;
  n.zooms = (c.zooms || []).filter(z => z.t0 >= a.local).map(z => ({ ...z, t0: z.t0 - a.local, t1: z.t1 - a.local }));
  c.zooms = (c.zooms || []).filter(z => z.t0 < a.local);
  P.clips.splice(P.clips.indexOf(c) + 1, 0, n);
  media[n.id] = { ...media[c.id], video: makeVideo(files[c.fileKey]) };
  loaded(media[n.id].video).then(() => drawNow());
  sel = n.id; renderTimeline(); renderPanel(); changed();
}
function moveClip(d) { const i = P.clips.findIndex(c => c.id === sel), j = i + d; if (j < 0 || j >= P.clips.length) return;
  [P.clips[i], P.clips[j]] = [P.clips[j], P.clips[i]]; renderTimeline(); renderPanel(); changed(); }
function dupClip() { const c = selClip(); const n = JSON.parse(JSON.stringify(c)); n.id = 'c' + Math.random().toString(36).slice(2, 9);
  P.clips.splice(P.clips.indexOf(c) + 1, 0, n); media[n.id] = { ...media[c.id], video: makeVideo(files[c.fileKey]) }; sel = n.id; renderTimeline(); renderPanel(); changed(); }
function delClip() { if (P.clips.length < 2) { toast('צריך להשאיר לפחות קליף אחד'); return; } const i = P.clips.findIndex(c => c.id === sel);
  P.clips.splice(i, 1); sel = P.clips[Math.min(i, P.clips.length - 1)].id; seekTo(Math.min(T, layout(P).total)); renderTimeline(); renderPanel(); changed(); }

/* ---------- pick on preview (zoom center / light point) ---------- */
let pick = null;
function setPick(pk) {
  pick = pk; const layer = $('#pickLayer'); layer.hidden = !pk; if (!pk) return;
  $('#pickHint').textContent = pk.hint; placeDot();
}
function placeDot() { if (!pick) return; const [x, y] = pick.get(); const d = $('#pickDot'); d.style.left = x * 100 + '%'; d.style.top = y * 100 + '%'; }
(() => { const layer = $('#pickLayer');
  const mv = e => { const r = $('#view').getBoundingClientRect(); const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    pick.set(x, y); placeDot(); requestDraw(); };
  layer.addEventListener('pointerdown', e => { layer.setPointerCapture(e.pointerId); mv(e); });
  layer.addEventListener('pointermove', e => { if (layer.hasPointerCapture(e.pointerId)) mv(e); });
  layer.addEventListener('pointerup', () => save());
  layer.addEventListener('dblclick', () => setPick(null));
})();

/* ---------- color panel ---------- */
function panelColor(p) {
  const C = P.color;
  p.append(sec('סגנון', chips(STYLES, C.style, s => { C.style = s.id; changed(); }, true),
    slider('לוח צבעים', C, 'pal', 0, 100, 1, { def: 100 })));
  // pad
  const pad = el('div', { class: 'pad' }, el('div', { class: 'grid' })), dot = el('div', { class: 'dot' }); pad.append(dot);
  const vt = el('b', {}, C.tone), vc = el('b', {}, C.color);
  const place = () => { dot.style.left = ((C.color + 100) / 200 * 100) + '%'; dot.style.top = ((100 - C.tone) / 200 * 100) + '%'; vt.textContent = Math.round(C.tone); vc.textContent = Math.round(C.color); };
  const mv = e => { const r = pad.getBoundingClientRect(); C.color = Math.round((Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 2 - 1) * 100);
    C.tone = Math.round((1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 2) * 100); place(); changed(); };
  pad.addEventListener('pointerdown', e => { pad.setPointerCapture(e.pointerId); mv(e); });
  pad.addEventListener('pointermove', e => { if (pad.hasPointerCapture(e.pointerId)) mv(e); });
  pad.addEventListener('dblclick', () => { C.tone = C.color = 0; place(); changed(); });
  place();
  p.append(sec('גוון וצבע', el('div', { class: 'padwrap' }, pad, el('div', { class: 'padvals' }, 'גוון ', vt, el('br'), 'צבע ', vc, el('br'),
    el('span', { class: 'hint' }, 'למעלה: עומק וצללים כחולים. לצדדים: רוויה. לחיצה כפולה מאפסת.')))));
  p.append(sec('תיקון ידני',
    slider('חשיפה', C, 'exposure', -150, 150, 1, { def: 0 }), slider('ניגודיות', C, 'contrast', -100, 100, 1, { def: 0 }),
    slider('רוויה', C, 'saturation', -100, 100, 1, { def: 0 }), slider('אורות', C, 'highlights', -100, 100, 1, { def: 0 }),
    slider('צללים', C, 'shadows', -100, 100, 1, { def: 0 }), slider('חום', C, 'warmth', -100, 100, 1, { def: 0 }),
    slider('גוון ירוק־סגול', C, 'tint', -100, 100, 1, { def: 0 })));
  p.append(sec('צילום אייפון', chips([{ id: 'auto', name: 'המרה מכוילת' }, { id: 'off', name: 'בלי המרה' }], C.hdr, s => { C.hdr = s.id; changed(); }),
    el('div', { class: 'hint' }, 'ההמרה כוילה מול קאפקאט ופועלת אוטומטית בצילומים בטווח דינמי גבוה.')));
}

/* ---------- effects panel ---------- */
function panelFx(p) {
  const F = P.fx;
  p.append(sec('מראה מוכן', chips(LOOKS.map((l, i) => ({ ...l, id: i })), -1, l => { Object.assign(F, { ...FX_DEFAULT, vigColor: F.vigColor, lightX: F.lightX, lightY: F.lightY }, l.fx); renderPanel(); changed(); }, true)));
  p.append(sec('אור וזוהר', slider('זוהר באורות', F, 'glow', 0, 100, 1, { def: 0 }), slider('הילה חמה', F, 'halation', 0, 100, 1, { def: 0 }),
    slider('חלומיות', F, 'dream', 0, 100, 1, { def: 0 }), slider('הבזק אור', F, 'leak', 0, 100, 1, { def: 0 })));
  p.append(sec('באוויר', slider('ערפל', F, 'fog', 0, 100, 1, { def: 0 }), slider('גרעיניות', F, 'grain', 0, 100, 1, { def: 0 }),
    slider('גודל גרעין', F, 'grainSize', 0, 100, 1, { def: 30 }), slider('גרעיניות זוהרת', F, 'sparkle', 0, 100, 1, { def: 0 })));
  const modes = [{ id: 0, name: 'כהים' }, { id: 1, name: 'בהירים' }, { id: 2, name: 'צבעוניים' }];
  const sw = el('div', { class: 'swatches' });
  for (const col of [[0.55, 0.32, 0.2], [0.18, 0.26, 0.42], [0.5, 0.22, 0.3], [0.62, 0.5, 0.28], [0.22, 0.36, 0.3]]) {
    const s = el('button', { class: 'swatch' + (String(col) === String(F.vigColor) ? ' on' : '') }); s.style.background = `rgb(${col.map(x => x * 255).join(',')})`;
    s.addEventListener('click', () => { F.vigColor = col; F.vigMode = 2; renderPanel(); changed(); }); sw.append(s); }
  p.append(sec('שוליים', chips(modes, F.vigMode, m => { F.vigMode = m.id; changed(); }), F.vigMode === 2 ? sw : null,
    slider('עוצמה', F, 'vig', 0, 100, 1, { def: 0 }), slider('גודל', F, 'vigSize', 0, 100, 1, { def: 45 }),
    slider('רכות', F, 'vigSoft', 0, 100, 1, { def: 50 }), slider('ערבול', F, 'vigSwirl', 0, 100, 1, { def: 0 }),
    slider('טשטוש קצוות', F, 'vigBlur', 0, 100, 1, { def: 0 }), slider('צורה', F, 'vigRound', 0, 100, 1, { def: 0, fmt: v => v < 50 ? 'אליפסה' : 'עיגול' })));
  p.append(sec('אור באמצע', slider('עוצמה', F, 'light', -100, 100, 1, { def: 0 }), slider('גודל', F, 'lightSize', 0, 100, 1, { def: 40 }),
    el('button', { class: 'btn', onclick: () => setPick({ hint: 'גוררים כדי למקם את האור', get: () => [F.lightX, 1 - F.lightY], set: (x, y) => { F.lightX = x; F.lightY = 1 - y; } }) }, 'מיקום האור על התמונה')));
}


/* ---------- text panel ---------- */
let selText = null;
function panelText(p) {
  P.texts = P.texts || [];
  const L = layout(P);
  const add = el('button', { class: 'btn primary', onclick: () => { const tx = newText(Math.min(T, Math.max(0, L.total - 1))); tx.t1 = Math.min(L.total, tx.t0 + 3); P.texts.push(tx); selText = tx.id; renderTimeline(); renderPanel(); changed(); } }, '+ טקסט מהסמן');
  const stickers = loadStickers();
  const stRow = el('div', { class: 'chips-scroll' });
  stickers.forEach(s => { const b = el('button', { class: 'chip sticker' }, s.text.split('\n')[0].slice(0, 14) || '·'); b.style.fontFamily = `"${s.font}"`;
    b.addEventListener('click', () => { const tx = { ...newText(T), ...s, id: 't' + Math.random().toString(36).slice(2, 8), t0: T, t1: Math.min(L.total, T + (s.dur || 3)) }; delete tx.sid; delete tx.dur;
      P.texts.push(tx); selText = tx.id; renderTimeline(); renderPanel(); changed(); });
    let pressT; b.addEventListener('pointerdown', () => { pressT = setTimeout(() => { removeSticker(s.sid); toast('המדבקה נמחקה'); renderPanel(); }, 900); });
    b.addEventListener('pointerup', () => clearTimeout(pressT)); stRow.append(b); });
  p.append(sec('טקסט ועיטורים', el('div', { class: 'row' }, add), stickers.length ? el('div', { class: 'hint', style: 'margin-top:8px' }, 'המדבקות שלך. לחיצה ארוכה מוחקת.') : null, stickers.length ? stRow : null));
  const tx = P.texts.find(x => x.id === selText) || P.texts[P.texts.length - 1];
  if (!tx) { p.append(el('div', { class: 'hint' }, 'מוסיפים טקסט, בוחרים גופן, צבע ותנועה, ושומרים כמדבקה לשימוש חוזר.')); return; }
  selText = tx.id;
  if (P.texts.length > 1) p.append(sec('הטקסטים בפרויקט', chips(P.texts.map(x => ({ id: x.id, name: x.text.split('\n')[0].slice(0, 12) || '·' })), tx.id, x => { selText = x.id; renderPanel(); renderTimeline(); seekTo(P.texts.find(y => y.id === x.id).t0 + .4); }, true)));
  const ta = el('textarea', { class: 'tinput', rows: 2, dir: 'rtl' }); ta.value = tx.text;
  ta.addEventListener('input', () => { tx.text = ta.value; renderTimeline(); changed(); });
  p.append(sec('נוסח', ta));
  const fontRow = el('div', { class: 'chips-scroll' });
  for (const f of FONTS) { const b = el('button', { class: 'chip font' + (f.id === tx.font ? ' on' : '') }, f.name); b.style.fontFamily = `"${f.id}"`; b.style.fontWeight = f.weight;
    b.addEventListener('click', async () => { tx.font = f.id; fontRow.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); b.classList.add('on'); await ensureFont(f.id); changed(); }); fontRow.append(b); }
  ensureFont(tx.font).then(() => requestDraw());
  const sw = el('div', { class: 'swatches' });
  for (const c of COLORS) { const s = el('button', { class: 'swatch' + (c === tx.color ? ' on' : '') }); s.style.background = c;
    s.addEventListener('click', () => { tx.color = c; sw.querySelectorAll('.swatch').forEach(x => x.classList.remove('on')); s.classList.add('on'); changed(); }); sw.append(s); }
  p.append(sec('גופן', fontRow), sec('צבע', sw));
  p.append(sec('תנועה', chips(ANIMS, tx.anim, a => { tx.anim = a.id; changed(); }, true)));
  p.append(sec('עיטור', chips(DECOS, tx.deco, d => { tx.deco = d.id; changed(); }, true)));
  p.append(sec('עיצוב', slider('גודל', tx, 'size', 20, 160, 1), slider('זוהר', tx, 'glow', 0, 100, 1), slider('צל', tx, 'shadow', 0, 100, 1), slider('ריווח', tx, 'spacing', -10, 60, 1),
    el('button', { class: 'btn', onclick: () => setPick({ hint: 'גוררים כדי למקם את הטקסט', get: () => [tx.x, tx.y], set: (x, y) => { tx.x = x; tx.y = y; } }) }, 'מיקום על התמונה')));
  const tl = sl => slider(sl[0], tx, sl[1], 0, Math.max(.5, L.total), .05, { fmt: v => v.toFixed(1) + 'ש׳', onInput: () => { if (tx.t1 < tx.t0 + .3) tx.t1 = tx.t0 + .3; renderTimeline(); seekTo(sl[1] === 't0' ? tx.t0 + .3 : tx.t1 - .1); changed(); } });
  p.append(sec('זמן', tl(['מופיע', 't0']), tl(['נעלם', 't1'])));
  p.append(el('div', { class: 'row' },
    el('button', { class: 'btn', onclick: () => { saveSticker(tx); toast('נשמר כמדבקה'); renderPanel(); } }, 'שמירה כמדבקה'),
    el('button', { class: 'btn', onclick: () => { const n = { ...JSON.parse(JSON.stringify(tx)), id: 't' + Math.random().toString(36).slice(2, 8) }; P.texts.push(n); selText = n.id; renderTimeline(); renderPanel(); changed(); } }, 'שכפול'),
    el('button', { class: 'btn warn', onclick: () => { P.texts = P.texts.filter(x => x !== tx); selText = null; renderTimeline(); renderPanel(); changed(); } }, 'מחיקה')));
}

/* ---------- audio panel ---------- */
let meterEls = null; const meterBuf = new Float32Array(2048);
function meterTick() {
  if (!analyser || !meterEls || currentTab !== 'audio') return;
  const { peak, rms } = meterLevels(analyser, meterBuf);
  const pc = x => Math.max(0, Math.min(100, (x + 60) / 60 * 100));
  meterEls.p.style.width = pc(peak) + '%'; meterEls.r.style.width = pc(rms) + '%';
  meterEls.pv.textContent = peak > -99 ? peak.toFixed(1) : '−∞'; meterEls.rv.textContent = rms > -99 ? rms.toFixed(1) : '−∞';
}
function panelAudio(p) {
  const A = P.audio; const upd = () => { if (chain) chain.update(A); save(); };
  const o = { onInput: upd };
  const pi = el('i'), ri = el('i'), pv = el('span', {}, '−∞'), rv = el('span', {}, '−∞');
  meterEls = { p: pi, r: ri, pv, rv };
  p.append(sec('מדים', el('div', { class: 'mrow' }, el('span', {}, 'שיא'), el('div', { class: 'meter' }, pi), pv),
    el('div', { class: 'mrow' }, el('span', {}, 'ממוצע'), el('div', { class: 'meter' }, ri), rv),
    el('div', { class: 'hint' }, 'המדים זזים בזמן ניגון. אם השיא מגיע לאדום, כדאי להוריד עוצמה.')));
  // music
  const mi = el('input', { type: 'file', accept: 'audio/*,video/*,.mp3,.m4a,.wav,.aac,.flac,.ogg', hidden: '' });
  mi.addEventListener('change', async () => { const f = mi.files[0]; if (!f) return; await setMusic(f, f.name.replace(/\.[^.]+$/, '')); renderPanel(); renderTimeline(); });
  const mu = P.music;
  p.append(sec('מוזיקה', el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => mi.click() }, mu ? 'החלפת שיר' : '+ ייבוא שיר'),
      mu ? el('button', { class: 'btn warn', onclick: () => { P.music = null; if (musicEl) { musicEl.pause(); musicEl = null; musicGain = null; } renderPanel(); renderTimeline(); save(); } }, 'הסרה') : null,
      mu ? el('button', { class: 'btn', onclick: () => { P.clips.forEach(c => c.audio = false); renderTimeline(); save(); toast('השמע של כל הקליפים הושתק'); } }, 'השתקת הקליפים') : null), mi,
    mu ? slider('עוצמה', A, 'musicVol', 0, 200, 1, { unit: '%', onInput: () => save() }) : null,
    mu ? slider('התחלה בשיר', mu, 'in', 0, Math.max(1, (musicEl && musicEl.duration) || 600), .1, { fmt: v => fmt(v), onInput: () => { save(); } }) : null,
    mu ? slider('כניסה הדרגתית', mu, 'fadeIn', 0, 8, .1, { fmt: v => v.toFixed(1) + 'ש׳', onInput: () => save() }) : null,
    mu ? slider('יציאה הדרגתית', mu, 'fadeOut', 0, 8, .1, { fmt: v => v.toFixed(1) + 'ש׳', onInput: () => save() }) : null));
  // beats
  const beatInfo = el('div', { class: 'hint' }, P.beats ? ('זוהו ' + P.beats.length + ' פעמות בקצב ' + A.bpm) : 'מזהים את הקצב מהשיר, או מקישים אותו ידנית למטה בדיליי.');
  const detect = el('button', { class: 'btn', onclick: async () => {
    if (!P.music || !musicFile) { toast('קודם מייבאים שיר'); return; }
    busy('מזהה את הקצב…'); try { const buf = await decodeFile(musicFile); const r = detectBeats(buf);
      A.bpm = Math.round(r.bpm); const mu = P.music; P.beats = r.beats.map(b => b - (mu.in || 0) + (mu.at || 0)).filter(b => b >= 0);
      log('קצב ' + r.bpm); toast('קצב ' + r.bpm); } catch (e) { toast('זיהוי הקצב נכשל'); log(e.message); }
    busy(null); if (chain) chain.update(A); renderTimeline(); renderPanel(); changed(false); } }, 'זיהוי קצב מהשיר');
  const manual = el('button', { class: 'btn', onclick: () => { const per = 60 / A.bpm; const L = layout(P); const start = P.beats && P.beats[0] != null ? P.beats[0] % per : 0;
    P.beats = []; for (let b = start; b <= L.total + per; b += per) P.beats.push(b); renderTimeline(); renderPanel(); changed(false); } }, 'רשת לפי הקצב הידני');
  const nudge = d => { if (!P.beats) return; P.beats = P.beats.map(b => b + d).filter(b => b >= 0); renderTimeline(); changed(false); };
  const fitRow = el('div', { class: 'row' }, el('span', { class: 'hint' }, 'חיתוך כל קליף אחרי'),
    ...[1, 2, 4, 8].map(n => el('button', { class: 'chip', onclick: () => fitToBeats(n) }, n + ' פעמות')));
  p.append(sec('קצב', el('div', { class: 'row' }, detect, manual), beatInfo,
    P.beats ? el('div', { class: 'row', style: 'margin-top:6px' }, el('span', { class: 'hint' }, 'הזזת הרשת'), el('button', { class: 'chip', onclick: () => nudge(-.02) }, '−'), el('button', { class: 'chip', onclick: () => nudge(.02) }, '+'),
      el('button', { class: 'chip', onclick: () => { P.beats = null; renderTimeline(); renderPanel(); changed(false); } }, 'הסרה')) : null,
    P.beats ? fitRow : null));
  // reverb
  p.append(sec('ריוורב', chips(REVERBS, A.reverb, r => { A.reverb = r.id; upd(); }, true),
    slider('כמות', A, 'reverbMix', 0, 100, 1, o), slider('השהיה', A, 'reverbPre', 0, 120, 1, { ...o, unit: 'מ״ש' }), slider('בהירות', A, 'reverbTone', 0, 100, 1, o)));
  // delay
  let taps = [];
  const bpmOut = el('b', {}, A.bpm);
  p.append(sec('דיליי', chips(DELAY_NOTES, A.delayNote, n => { A.delayNote = n.id; upd(); }, true),
    el('div', { class: 'row', style: 'margin-top:8px' }, el('span', { class: 'hint' }, 'קצב'), bpmOut,
      el('button', { class: 'btn', onclick: () => { const now = performance.now(); taps = taps.filter(t => now - t < 3000); taps.push(now);
        if (taps.length > 1) { const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); A.bpm = Math.round(60000 / d); bpmOut.textContent = A.bpm; upd(); } } }, 'הקשה לקצב'),
      el('button', { class: 'chip', onclick: () => { A.bpm = Math.max(40, A.bpm - 1); bpmOut.textContent = A.bpm; upd(); } }, '−'),
      el('button', { class: 'chip', onclick: () => { A.bpm = Math.min(220, A.bpm + 1); bpmOut.textContent = A.bpm; upd(); } }, '+')),
    slider('כמות', A, 'delayMix', 0, 100, 1, o), slider('חזרות', A, 'delayFb', 0, 100, 1, o), slider('בהירות', A, 'delayTone', 0, 100, 1, o),
    toggle('קפיצה בין ימין לשמאל', A.pingpong, on => { A.pingpong = on; upd(); })));
  // EQ + dynamics
  p.append(sec('אקולייזר', slider('חיתוך נמוכים', A, 'hp', 20, 300, 1, { ...o, unit: 'הרץ' }), slider('בס', A, 'low', -12, 12, .5, { ...o, unit: 'דציבל' }),
    slider('אמצע', A, 'mid', -12, 12, .5, { ...o, unit: 'דציבל' }), slider('תדר אמצע', A, 'midFreq', 200, 6000, 10, { ...o, unit: 'הרץ' }),
    slider('גבוהים', A, 'high', -12, 12, .5, { ...o, unit: 'דציבל' })));
  p.append(sec('קומפרסור ועוצמה', toggle('קומפרסור', A.compOn, on => { A.compOn = on; upd(); }),
    slider('סף', A, 'thresh', -40, 0, 1, { ...o, unit: 'דציבל' }), slider('יחס', A, 'ratio', 1, 12, .5, { ...o, fmt: v => v + ':1' }),
    slider('פיצוי', A, 'makeup', 0, 12, .5, { ...o, unit: 'דציבל' }), slider('עוצמה כללית', A, 'gain', -12, 12, .5, { ...o, unit: 'דציבל' })));
}

function fitToBeats(n) {
  if (!P.beats || P.beats.length < 2) return;
  const per = (P.beats[P.beats.length - 1] - P.beats[0]) / (P.beats.length - 1);
  let t = 0, bi = 0, changedCount = 0;
  for (let i = 0; i < P.clips.length; i++) {
    const c = P.clips[i], dur = (media[c.id] && media[c.id].video.duration) || c.dur;
    // first cut lands on the n-th beat after the clip starts (first clip also absorbs the lead-in before beat 0)
    while (bi < P.beats.length && P.beats[bi] <= t + .05) bi++;
    let target = P.beats[Math.min(P.beats.length - 1, bi + n - 1)];
    if (target == null || target <= t) target = t + n * per;
    let len = target - t;
    if (c.in + len > dur) { const fit = Math.floor((dur - c.in - (P.beats[bi] - t)) / per); len = fit > 0 ? (P.beats[bi] - t) + fit * per : dur - c.in; }
    c.out = Math.min(dur, c.in + Math.max(.2, len)); t += c.out - c.in; changedCount++;
  }
  renderTimeline(); renderPanel(); changed(); toast('הקליפים נחתכו לפי הקצב');
}
async function setMusic(blob, name, restoring = false) {
  if (!restoring) { const key = 'm' + Date.now().toString(36); files[key] = blob; store.putFile(key, blob); P.music = { fileKey: key, name, in: 0, at: 0, fadeIn: 0, fadeOut: 1.5 }; save(); }
  musicFile = blob; if (musicEl) musicEl.pause();
  musicEl = document.createElement('audio'); musicEl.preload = 'auto'; musicEl.src = URL.createObjectURL(blob); $('#hiddenMedia').append(musicEl);
  musicGain = null; if (actx) musicGain = routeEl(musicEl);
  await new Promise(r => { musicEl.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
  if (P.music && P.music.out == null) P.music.out = musicEl.duration;
}

/* ---------- export panel ---------- */
let exporting = false, cancelExport = false, lastExport = null;
function panelExport(p) {
  const pr = PRESETS.find(x => x.id === P.preset) || PRESETS[0];
  const hint = el('div', { class: 'hint' }, pr.hint);
  const rateSl = slider('קצב נתונים', P, 'kbps', 300, 30000, 100, { fmt: v => (v / 1000).toFixed(1) + ' מגה', onInput: () => save() });
  p.append(sec('איכות', chips(PRESETS, P.preset, x => { P.preset = x.id; P.kbps = x.kbps; renderPanel(); save(); }, true), hint, rateSl));
  const prog = el('progress', { max: 1, value: 0 }), ptxt = el('div', { class: 'stat' });
  const pw = el('div', { hidden: '' }, prog, ptxt);
  const res = el('div', { class: 'result' });
  const go = el('button', { class: 'btn primary', style: 'width:100%;padding:14px;font-size:16px' }, exporting ? 'מייצא…' : 'ייצוא הסרטון');
  go.disabled = exporting;
  const cancel = el('button', { class: 'btn', hidden: exporting ? null : '' }, 'עצירה');
  cancel.addEventListener('click', () => { cancelExport = true; });
  go.addEventListener('click', async () => {
    if (exporting || !P.clips.length) return; stop(); exporting = true; cancelExport = false; go.disabled = true; go.textContent = 'מייצא…'; cancel.hidden = false; pw.hidden = false; res.innerHTML = '';
    const t0 = performance.now();
    try {
      const r = await exportProject({ project: P, media, musicFile, renderer, overlay: textOverlay, preset: pr, kbps: P.kbps, onProgress: (v, t) => { prog.value = v; ptxt.textContent = t; }, cancelled: () => cancelExport });
      lastExport = r; showResult(res, r, (performance.now() - t0) / 1000);
    } catch (e) { ptxt.textContent = e.message; toast(e.message); }
    finally { exporting = false; go.disabled = false; go.textContent = 'ייצוא הסרטון'; cancel.hidden = true; for (const k in media) { media[k].video.muted = false; media[k].video.playbackRate = 1; } sizePreview(); seekTo(T); }
  });
  p.append(sec('ייצוא', go, cancel, pw, res));
  if (lastExport) showResult(res, lastExport);
}
function showResult(box, r, took) {
  const kbps = r.blob.size * 8 / r.secs / 1000;
  const name = (P.name || 'סרטון').replace(/[\\/:*?"<>|]/g, '') + '.mp4';
  const file = new File([r.blob], name, { type: 'video/mp4' });
  const url = URL.createObjectURL(r.blob);
  box.innerHTML = '';
  box.append(el('div', { class: 'stat' }, el('b', {}, r.w + ' על ' + r.h), ' · ', el('b', {}, (r.blob.size / 1048576).toFixed(2) + ' מגה'), ' · ', r.secs.toFixed(1) + ' שניות', el('br'),
    'קצב בפועל ', el('b', {}, (kbps / 1000).toFixed(2)), ' מגה־ביט · פריימים שנפלו ', el('b', {}, r.dropped), took ? ' · ' + took.toFixed(0) + ' שניות ייצוא' : '',
    r.audio ? '' : el('span', { style: 'color:#ffb1a3' }, ' · בלי קול' + (r.audioNote ? ' (' + r.audioNote + ')' : ''))));
  const v = el('video', { controls: '', playsinline: '', src: url }); box.append(v);
  const row = el('div', { class: 'row', style: 'margin-top:10px' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) row.append(el('button', { class: 'btn primary', onclick: () => navigator.share({ files: [file] }).catch(() => {}) }, 'שיתוף לוואטסאפ'));
  row.append(el('a', { class: 'btn', href: url, download: name }, 'שמירה'));
  box.append(row);
}

/* ---------- toolbar extras ---------- */
$('#undoBtn').addEventListener('click', undo); $('#redoBtn').addEventListener('click', redo);
$('#zoomIn').addEventListener('click', () => { zoomMul = Math.min(8, zoomMul * 1.5); renderTimeline(); });
$('#zoomOut').addEventListener('click', () => { zoomMul = Math.max(.25, zoomMul / 1.5); renderTimeline(); });
(() => { const b = $('#cmpBtn'); const on = e => { e.preventDefault(); comparing = true; b.classList.add('on'); drawNow(); }; const off = () => { comparing = false; b.classList.remove('on'); drawNow(); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off); })();
$('#logBtn').addEventListener('click', () => {
  const caps = ['VideoEncoder', 'AudioEncoder', 'VideoFrame', 'AudioDecoder'].map(k => k + ': ' + (typeof window[k] !== 'undefined' ? 'כן' : 'לא')).join(' · ');
  $('#logText').textContent = navigator.userAgent + '\n' + caps + '\n\n' + (LOG.join('\n') || 'היומן ריק');
  $('#logSheet').hidden = false; });
$('#logClose').addEventListener('click', () => $('#logSheet').hidden = true);
$('#logCopy').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText($('#logText').textContent).then(() => toast('הועתק')); });
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } if (e.key === ' ' && P && !$('#editor').hidden && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') { e.preventDefault(); playing ? stop() : play(); } });

/* ================= boot ================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
addEventListener('resize', () => P && !$('#editor').hidden && renderTimeline());
document.addEventListener('visibilitychange', () => { if (document.hidden && P) store.save(P); });
showHome();
window.__app = { get P() { return P; }, media, exportProject, play, stop, seekTo };
