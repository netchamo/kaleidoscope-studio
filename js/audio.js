// Audio: decoding, studio FX chain (EQ, compressor, reverb, delay, limiter), offline mix, AAC encode.
import { Mux, extractAac } from './media.js';

export const SR = 48000;

export const REVERBS = [
  { id: 'none', name: 'בלי' },
  { id: 'room', name: 'חדר קטן', rt: .55, pre: 4, er: .025, damp: .55, width: .6 },
  { id: 'studio', name: 'אולפן', rt: .9, pre: 8, er: .035, damp: .45, width: .8 },
  { id: 'event', name: 'אולם אירועים', rt: 1.7, pre: 18, er: .06, damp: .4, width: 1 },
  { id: 'concert', name: 'אולם קונצרטים', rt: 2.5, pre: 24, er: .08, damp: .3, width: 1 },
  { id: 'live', name: 'הופעה חיה', rt: 1.3, pre: 12, er: .05, damp: .25, width: 1, erGain: 1.6 },
  { id: 'amphi', name: 'אמפיתיאטרון', rt: 2.1, pre: 35, er: .14, damp: .35, width: 1, erGain: 1.3 },
  { id: 'air', name: 'מרחף', rt: 4.8, pre: 30, er: .02, damp: .15, width: 1, smooth: true },
];
export const DELAY_NOTES = [
  { id: '1/4', name: 'רבע', beats: 1 }, { id: '1/8d', name: 'שמינית מנוקדת', beats: .75 },
  { id: '1/8', name: 'שמינית', beats: .5 }, { id: '1/16', name: 'שש־עשרה', beats: .25 },
];

// ---------- decoding ----------
function decodeBuf(buf) {
  return new Promise((res, rej) => {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(2, SR, SR);
    const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej);
  });
}
const clipCache = new Map();
// Decode a video file's audio track up to `untilSec` by copying its AAC packets into a small m4a.
export async function decodeVideoAudio(key, file, untilSec) {
  const c = clipCache.get(key);
  if (c && c.until >= untilSec) return c.buf;
  const r = await extractAac(file, untilSec + 0.3);
  if (!r.track) return null;
  const blob = Mux.build([{ ...r.track, id: 1 }]);
  const buf = await decodeBuf(await blob.arrayBuffer());
  clipCache.set(key, { until: untilSec, buf });
  return buf;
}
export async function decodeFile(file) { return decodeBuf(await file.arrayBuffer()); }

// ---------- impulse responses ----------
const irCache = new Map();
export function makeIR(ctx, id) {
  const spec = REVERBS.find(r => r.id === id); if (!spec || id === 'none') return null;
  const key = id + ':' + ctx.sampleRate; if (irCache.has(key) && irCache.get(key).ctx === ctx) return irCache.get(key).buf;
  const sr = ctx.sampleRate, len = Math.floor(sr * (spec.rt * 1.25 + spec.pre / 1000 + .05));
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const pre = Math.floor(spec.pre / 1000 * sr);
    // early reflections
    const nEr = 18, erLen = spec.er * sr;
    for (let i = 0; i < nEr; i++) {
      const pos = pre + Math.floor(Math.pow(Math.abs(rnd()), 1.4) * erLen);
      if (pos < len) d[pos] += rnd() * (spec.erGain || 1) * .5 * (1 - i / nEr);
    }
    // late diffuse tail: decaying noise through a lowpass that darkens over time
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-6.9 * t / spec.rt) * Math.min(1, t / (spec.smooth ? .08 : .02));
      const cutoff = Math.max(.04, (1 - spec.damp) * Math.exp(-t * (1.5 + spec.damp * 3)) + .05);
      lp += cutoff * (rnd() - lp);
      d[i] += lp * env * .35;
    }
  }
  // stereo width: blend channels toward mid for narrow rooms
  const L = buf.getChannelData(0), R = buf.getChannelData(1), w = spec.width;
  for (let i = 0; i < len; i++) { const m = (L[i] + R[i]) / 2, s = (L[i] - R[i]) / 2 * w; L[i] = m + s; R[i] = m - s; }
  let e = 0; for (let i = 0; i < len; i++) e += L[i] * L[i] + R[i] * R[i];
  const g = 1 / Math.sqrt(e / 2 + 1e-9) * .9; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
  irCache.set(key, { ctx, buf });
  return buf;
}

// ---------- FX chain ----------
// settings: see state.js audio defaults
export function buildChain(ctx, s) {
  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = .7;
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 120;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.Q.value = .9;
  const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 8000;
  const comp = ctx.createDynamicsCompressor(); comp.knee.value = 8; comp.attack.value = .01; comp.release.value = .18;
  const makeup = ctx.createGain();
  const dry = ctx.createGain(), sum = ctx.createGain();
  // reverb
  const rvPre = ctx.createDelay(1), conv = ctx.createConvolver(), rvTone = ctx.createBiquadFilter(), rvWet = ctx.createGain();
  rvTone.type = 'lowpass';
  // delay (ping-pong capable)
  const dlIn = ctx.createGain(), dlL = ctx.createDelay(2), dlR = ctx.createDelay(2), fbL = ctx.createGain(), fbR = ctx.createGain();
  const dlTone = ctx.createBiquadFilter(); dlTone.type = 'lowpass';
  const dlWet = ctx.createGain(), merger = ctx.createChannelMerger(2), splitter = ctx.createChannelSplitter(2);
  const master = ctx.createGain(), limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = .002; limiter.release.value = .08;

  input.connect(hp); hp.connect(low); low.connect(mid); mid.connect(high); high.connect(comp); comp.connect(makeup);
  makeup.connect(dry); dry.connect(sum);
  makeup.connect(rvPre); rvPre.connect(conv); conv.connect(rvTone); rvTone.connect(rvWet); rvWet.connect(sum);
  makeup.connect(dlIn); dlIn.connect(dlTone);
  dlTone.connect(splitter);
  splitter.connect(dlL, 0); splitter.connect(dlR, 1);
  dlL.connect(fbL); dlR.connect(fbR);
  dlL.connect(merger, 0, 0); dlR.connect(merger, 0, 1);
  merger.connect(dlWet); dlWet.connect(sum);
  sum.connect(master); master.connect(limiter);

  let pingpong = null;
  const chain = {
    input, output: limiter,
    update(s) {
      hp.frequency.value = s.hp; low.gain.value = s.low; mid.frequency.value = s.midFreq; mid.gain.value = s.mid; high.gain.value = s.high;
      comp.threshold.value = s.compOn ? s.thresh : 0; comp.ratio.value = s.compOn ? s.ratio : 1; makeup.gain.value = Math.pow(10, (s.compOn ? s.makeup : 0) / 20);
      const ir = makeIR(ctx, s.reverb);
      if (ir && conv.buffer !== ir) conv.buffer = ir;
      rvWet.gain.value = ir ? s.reverbMix / 100 * 1.2 : 0; rvPre.delayTime.value = (s.reverbPre || 0) / 1000;
      rvTone.frequency.value = 2500 + s.reverbTone / 100 * 15000;
      dry.gain.value = 1 - (ir ? s.reverbMix / 100 * .35 : 0);
      const beat = 60 / Math.max(40, s.bpm);
      const note = DELAY_NOTES.find(n => n.id === s.delayNote) || DELAY_NOTES[1];
      const dt = Math.min(1.9, beat * note.beats);
      dlL.delayTime.value = dt; dlR.delayTime.value = s.pingpong ? dt : dt * 1.0;
      fbL.gain.value = fbR.gain.value = s.delayFb / 100 * .85;
      dlTone.frequency.value = 1200 + s.delayTone / 100 * 12000;
      dlWet.gain.value = s.delayMix / 100 * .9;
      // feedback routing: straight (L->L,R->R) or ping-pong (L->R,R->L)
      if (pingpong !== s.pingpong) {
        try { fbL.disconnect(); fbR.disconnect(); } catch (e) {}
        if (s.pingpong) { fbL.connect(dlR); fbR.connect(dlL); } else { fbL.connect(dlL); fbR.connect(dlR); }
        pingpong = s.pingpong;
      }
      master.gain.value = Math.pow(10, s.gain / 20);
    },
  };
  chain.update(s);
  return chain;
}

// ---------- offline mix for export ----------
// segments: [{buf, at, offset, dur, gain, fadeIn, fadeOut}]
export async function renderMix(segments, total, settings, onProgress) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(2, Math.max(1, Math.ceil(total * SR)), SR);
  const chain = buildChain(ctx, settings);
  chain.output.connect(ctx.destination);
  for (const s of segments) {
    if (!s.buf) continue;
    const src = ctx.createBufferSource(); src.buffer = s.buf;
    const g = ctx.createGain(); src.connect(g); g.connect(chain.input);
    const end = s.at + s.dur;
    g.gain.setValueAtTime(s.fadeIn > 0 ? 0 : s.gain, s.at);
    if (s.fadeIn > 0) g.gain.linearRampToValueAtTime(s.gain, s.at + s.fadeIn);
    if (s.fadeOut > 0) { g.gain.setValueAtTime(s.gain, Math.max(s.at, end - s.fadeOut)); g.gain.linearRampToValueAtTime(0, end); }
    src.start(s.at, Math.max(0, s.offset), s.dur);
  }
  if (onProgress) onProgress(0.5);
  return await ctx.startRendering();
}

export async function encodeAac(buf) {
  if (typeof AudioEncoder === 'undefined') return null;
  const cfg = { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 160000 };
  try { const r = await AudioEncoder.isConfigSupported(cfg); if (!r.supported) return null; } catch (e) { return null; }
  const samples = []; let asc = null, err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); samples.push({ data: d, dur: 1024, key: true, cto: 0 });
      if (!asc && meta && meta.decoderConfig && meta.decoderConfig.description) {
        const x = meta.decoderConfig.description; asc = new Uint8Array(x.buffer ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : x);
      }
    }, error: e => { err = e; } });
  enc.configure(cfg);
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = buf.length, step = 4096;
  for (let i = 0; i < n; i += step) {
    const k = Math.min(step, n - i), data = new Float32Array(k * 2); data.set(L.subarray(i, i + k), 0); data.set(R.subarray(i, i + k), k);
    const a = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data });
    enc.encode(a); a.close();
    if (enc.encodeQueueSize > 20) await new Promise(r => setTimeout(r, 0));
  }
  await enc.flush(); enc.close();
  if (err || !samples.length) return null;
  if (!asc) asc = new Uint8Array([0x11, 0x90]);
  return { kind: 'audio', id: 2, timescale: SR, sampleRate: SR, channels: 2, bitrate: 160000, asc, samples, duration: samples.length * 1024, shift: 0 };
}

export function meterLevels(an, arr) {
  an.getFloatTimeDomainData(arr); let pk = 0, sq = 0;
  for (let i = 0; i < arr.length; i++) { const x = Math.abs(arr[i]); if (x > pk) pk = x; sq += x * x; }
  return { peak: 20 * Math.log10(pk + 1e-9), rms: 10 * Math.log10(sq / arr.length + 1e-12) };
}
