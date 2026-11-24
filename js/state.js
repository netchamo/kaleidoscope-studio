// Project model, defaults and IndexedDB persistence.
export const COLOR_DEFAULT = { style: 'zahav', pal: 100, exposure: 0, contrast: 0, saturation: 0, highlights: 0, shadows: 0,
  warmth: 0, tint: 0, tone: 0, color: 0, hdr: 'auto' };
export const FX_DEFAULT = { glow: 0, halation: 0, dream: 0, fog: 0, grain: 0, grainSize: 30, sparkle: 0, leak: 0,
  vig: 0, vigMode: 0, vigSize: 45, vigSoft: 50, vigSwirl: 0, vigBlur: 0, vigRound: 0, vigColor: [0.55, 0.32, 0.2],
  light: 0, lightSize: 40, lightX: 0.5, lightY: 0.55 };
export const AUDIO_DEFAULT = { hp: 30, low: 0, mid: 0, midFreq: 1500, high: 0, compOn: false, thresh: -18, ratio: 3, makeup: 3,
  reverb: 'none', reverbMix: 25, reverbPre: 10, reverbTone: 60, delayMix: 0, delayNote: '1/8d', delayFb: 35, delayTone: 50,
  pingpong: true, bpm: 100, gain: 0, musicVol: 100 };

export const STYLES = [
  { id: null, name: 'מקורי' },
  { id: 'zahav', name: 'זהב ספיר' },
];
export const LOOKS = [ // one-tap effect recipes on top of the style
  { name: 'נקי', fx: {} },
  { name: 'חלום', fx: { dream: 35, glow: 25, vig: 25, vigSoft: 80, vigBlur: 30 } },
  { name: 'ערפל אירוע', fx: { fog: 35, glow: 30, halation: 20 } },
  { name: 'סרט ישן', fx: { grain: 45, grainSize: 55, halation: 30, vig: 40, vigSoft: 70 } },
  { name: 'נצנוץ', fx: { sparkle: 45, glow: 35 } },
  { name: 'אור חם', fx: { leak: 45, glow: 20 } },
  { name: 'שוליים מתערבלים', fx: { vig: 55, vigSwirl: 70, vigBlur: 40, vigSoft: 60 } },
  { name: 'זרקור', fx: { light: 45, lightSize: 35, vig: 45 } },
];

export const PRESETS = [
  { id: 'hd', name: 'וואטסאפ · 720', short: 720, kbps: 2000, fps: 30, hint: 'מותאם לשליחה באיכות הגבוהה של וואטסאפ' },
  { id: 'sd', name: 'צפייה חלקה · 480', short: 480, kbps: 900, fps: 30, hint: 'קובץ קטן שנטען מהר גם באינטרנט חלש' },
  { id: 'fhd', name: '1080', short: 1080, kbps: 6000, fps: 30, hint: 'לשמירה ולשימושים אחרים' },
  { id: 'uhd', name: '4K', short: 2160, kbps: 20000, fps: 30, hint: 'איכות מקסימלית, כבד ואיטי' },
];

export function newProject(name) {
  return { id: 'p' + Date.now().toString(36), name, created: Date.now(), updated: Date.now(), clips: [], music: null,
    color: { ...COLOR_DEFAULT }, fx: { ...FX_DEFAULT }, audio: { ...AUDIO_DEFAULT }, preset: 'hd', kbps: 2000, thumb: null };
}
export function newClip(fileKey, name, dur) {
  return { id: 'c' + Math.random().toString(36).slice(2, 9), fileKey, name, dur, in: 0, out: dur,
    fadeIn: 0, fadeOut: 0, aFadeIn: 0, aFadeOut: 0, audio: true, vol: 100, linkFades: true, zooms: [] };
}

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('kaleidoscope', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('projects', { keyPath: 'id' }); d.createObjectStore('files'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const out = fn(s);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); });
}
export const store = {
  async list() { try { const r = await tx('projects', 'readonly', s => s.getAll()); return (r || []).sort((a, b) => b.updated - a.updated); } catch (e) { return []; } },
  async save(p) { p.updated = Date.now(); try { await tx('projects', 'readwrite', s => s.put(JSON.parse(JSON.stringify(p)))); } catch (e) {} },
  async remove(id) { try { await tx('projects', 'readwrite', s => s.delete(id)); } catch (e) {} },
  async putFile(key, blob) { try { await tx('files', 'readwrite', s => s.put(blob, key)); return true; } catch (e) { return false; } },
  async getFile(key) { try { return await tx('files', 'readonly', s => s.get(key)); } catch (e) { return null; } },
  async delFile(key) { try { await tx('files', 'readwrite', s => s.delete(key)); } catch (e) {} },
};
