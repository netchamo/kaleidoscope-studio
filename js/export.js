// Export: render every clip through the GL pipeline into H.264, mix audio offline, mux MP4.
import { Mux, isAnnexB, annexBToAvc, buildAvcC } from './media.js?v=4';
import { layout, videoFade, zoomAt } from './timeline.js?v=4';
import { decodeVideoAudio, decodeFile, renderMix, encodeAac } from './audio.js?v=4';

export async function pickCodec(w, h, bitrate, fps) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d4028', 'avc1.42e028', 'avc1.4d401f', 'avc1.42e01f']) {
    for (const cfg of [{ codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' }, { codec, width: w, height: h, bitrate, framerate: fps }]) {
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return r.config || cfg; } catch (e) {}
    }
  }
  return null;
}
export function outSize(vw, vh, short) {
  const s = Math.min(1, short / Math.min(vw, vh));
  return [Math.round(vw * s / 2) * 2, Math.round(vh * s / 2) * 2];
}
function seek(v, t) {
  return new Promise(r => { if (Math.abs(v.currentTime - t) < 0.01) return r(); let done = false;
    const f = () => { if (done) return; done = true; v.removeEventListener('seeked', f); r(); };
    v.addEventListener('seeked', f); v.currentTime = t; setTimeout(f, 3000); });
}

// media: { [clipId]: { video, file, hdr } }, musicFile: File|null
export async function exportProject({ project, media, musicFile, renderer, overlay, preset, kbps, onProgress, cancelled }) {
  const L = layout(project);
  if (!L.items.length) throw new Error('אין קליפים בפרויקט');
  const first = media[L.items[0].clip.id].video;
  const [w, h] = outSize(first.videoWidth, first.videoHeight, preset.short);
  const fps = preset.fps;
  const cfg = await pickCodec(w, h, kbps * 1000, fps);
  if (!cfg) throw new Error('המכשיר לא תומך בקידוד ברזולוציה הזו');

  // ---- audio first (fast, offline) ----
  onProgress(0, 'מכין את השמע…');
  let audioTrack = null, audioNote = '';
  try {
    const segs = [];
    for (const it of L.items) {
      const c = it.clip; if (!c.audio) continue;
      const m = media[c.id];
      const buf = await decodeVideoAudio(c.fileKey, m.file, c.out);
      if (buf) segs.push({ buf, at: it.start, offset: c.in, dur: it.len, gain: (c.vol ?? 100) / 100, fadeIn: c.aFadeIn, fadeOut: c.aFadeOut });
    }
    const mu = project.music;
    if (mu && musicFile) {
      const buf = await decodeFile(musicFile);
      const dur = Math.min(L.total - (mu.at || 0), (mu.out ?? buf.duration) - (mu.in || 0));
      if (dur > 0) segs.push({ buf, at: mu.at || 0, offset: mu.in || 0, dur, gain: (project.audio.musicVol ?? 100) / 100, fadeIn: mu.fadeIn || 0, fadeOut: mu.fadeOut || 0 });
    }
    if (segs.length) {
      const mixed = await renderMix(segs, L.total, project.audio);
      audioTrack = await encodeAac(mixed);
      if (!audioTrack) audioNote = 'המכשיר לא תומך בקידוד שמע';
    }
  } catch (e) { audioNote = 'השמע נכשל: ' + e.message; }

  // ---- video ----
  renderer.setSize(w, h);
  const samples = []; let avcC = null; const annex = {}; let vErr = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      let d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !avcC) { const x = meta.decoderConfig.description; avcC = new Uint8Array(x.buffer ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : x); }
      if (!avcC && isAnnexB(d)) d = annexBToAvc(d, annex);
      samples.push({ data: d, pts: chunk.timestamp, key: chunk.type === 'key' });
    }, error: e => { vErr = e; } });
  enc.configure(cfg);
  let count = 0, dropped = 0;
  const minGap = 1 / fps - 0.004;
  for (const it of L.items) {
    if (cancelled()) break;
    const c = it.clip, m = media[c.id], v = m.video;
    v.pause(); v.muted = true; v.playbackRate = 1;
    await seek(v, c.in);
    let last = -1, winT = null, n = 0;
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { if (!done) { done = true; v.pause(); resolve(); } };
      const handle = mt => {
        if (mt >= c.out - 0.001 || cancelled()) return finish();
        if (mt < c.in - 0.02 || mt - last < minGap) return;
        if (enc.encodeQueueSize > 6) { dropped++; return; }
        last = mt;
        const local = mt - c.in;
        renderer.draw(v, it.start + local, project.color, project.fx, m.hdr && project.color.hdr !== 'off', videoFade(c, local, it.len), zoomAt(c, local), overlay ? overlay(it.start + local) : null);
        const vf = new VideoFrame(renderer.canvas, { timestamp: Math.round((it.start + local) * 1e6), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: count % (fps * 2) === 0 }); vf.close(); count++; n++;
        if (n % 12 === 0) { if (winT !== null) { const ratio = 12 / ((mt - winT) * fps);
          if (ratio < .93) v.playbackRate = Math.max(.1, v.playbackRate * Math.max(.5, ratio)); else if (ratio > .99 && v.playbackRate < 1) v.playbackRate = Math.min(1, v.playbackRate * 1.1); } winT = mt; }
        onProgress(Math.min(.99, (it.start + local) / L.total), 'מקודד… ' + Math.round((it.start + local) / L.total * 100) + '%');
      };
      v.addEventListener('ended', finish, { once: true });
      if ('requestVideoFrameCallback' in v) { const cb = (now, md) => { if (done) return; handle(md.mediaTime); if (!done) v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
      else { let prev = -1; const loop = () => { if (done) return; const t = v.currentTime; if (t !== prev) { prev = t; handle(t); } requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
      v.play().catch(reject);
    });
    v.playbackRate = 1;
  }
  await enc.flush(); enc.close();
  if (cancelled()) throw new Error('הייצוא נעצר');
  if (vErr) throw new Error('שגיאה במקודד: ' + vErr.message);
  if (!samples.length) throw new Error('לא נוצרו פריימים');
  if (!avcC) { if (annex.sps && annex.pps) avcC = buildAvcC(annex.sps, annex.pps); else throw new Error('חסר מידע תצורה'); }
  const TS = 90000, toTs = us => Math.round(us * TS / 1e6);
  const pts = samples.map(s => toTs(s.pts)), sorted = [...pts].sort((a, b) => a - b);
  let shift = 0; for (let i = 0; i < samples.length; i++) shift = Math.max(shift, sorted[i] - pts[i]);
  const dts = sorted.map(x => x - shift), fd = Math.round(TS / fps);
  samples.forEach((s, i) => { s.dur = i < samples.length - 1 ? Math.max(1, dts[i + 1] - dts[i]) : fd; s.cto = pts[i] - dts[i]; });
  const tracks = [{ kind: 'video', id: 1, timescale: TS, width: w, height: h, avcC, samples, duration: samples.reduce((a, s) => a + s.dur, 0), shift }];
  if (audioTrack) tracks.push(audioTrack);
  onProgress(1, 'אורז…');
  const blob = Mux.build(tracks);
  return { blob, w, h, secs: L.total, frames: count, dropped, audio: !!audioTrack, audioNote };
}
