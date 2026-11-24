// Rendering engine: color grade + full-frame artistic layers, WebGL2.
import { LUTS } from './luts.js';

const VS = `#version 300 es
in vec2 p; out vec2 v; void main(){ v=p*.5+.5; gl_Position=vec4(p,0.,1.); }`;
const COMMON = `#version 300 es
precision highp float; precision highp sampler3D; in vec2 v; out vec4 o;
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=0.,a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p*=2.03; a*=.5; } return s; }
const vec3 LW=vec3(.2126,.7152,.0722);
vec3 lut3(sampler3D s, vec3 c){ return texture(s, clamp(c,0.,1.)*(16./17.)+.5/17.).rgb; }
`;
const FS_GRADE = COMMON + `
uniform sampler2D uVid; uniform sampler3D uFix, uStyle; uniform float uStyleN;
uniform float uHdr,uUseStyle,uPal,uExp,uCon,uSat,uHi,uSh,uWarm,uTint,uTone,uColor,uFog,uTime,uLight,uLightSize,uWb;
uniform vec2 uRes,uLightPos,uZoomC,uCrop; uniform float uZoom;
void main(){
  vec2 zv=uZoomC+(v-uZoomC)/max(uZoom,1.);
  zv=.5+(zv-.5)*uCrop;
  vec3 c=texture(uVid,zv).rgb;
  if(uHdr>.5) c=lut3(uFix,c);
  c*=exp2(uExp);
  float l=dot(c,LW);
  c+=uSh*.22*(1.-smoothstep(0.,.55,l));
  c+=uHi*.22*smoothstep(.45,1.,l);
  l=dot(c,LW);
  c=(c-l)+( (l-.45)*(1.+uCon*.6)+.45 );
  l=dot(c,LW); c=l+(c-l)*(1.+uSat);
  c*=vec3(1.+uWarm*.08,1.+uTint*.06,1.-uWarm*.1);
  if(uUseStyle>.5) c=mix(c,texture(uStyle,clamp(c,0.,1.)*((uStyleN-1.)/uStyleN)+.5/uStyleN).rgb,uPal);
  // pad: tone (depth/contrast, shadows to blue) and color (saturation)
  c=(c-.45)*(1.+uTone*.35)+.45-uTone*.025;
  float sh=1.-smoothstep(0.,.45,dot(c,LW)); c+=vec3(-.02,0.,.03)*uTone*sh;
  l=dot(c,LW); c=l+(c-l)*(1.+uColor*.7);
  // center light
  if(uLight!=0.){
    vec2 a=vec2(uRes.x/uRes.y,1.); float d=length((v-uLightPos)*a);
    float k=exp(-d*d/(uLightSize*uLightSize+1e-4));
    c*=1.+uLight*.55*k; c+=max(uLight,0.)*.03*k*vec3(1.,.9,.75);
  }
  if(uFog>0.){
    vec2 q=v*vec2(uRes.x/uRes.y,1.)*2.2;
    float n=fbm(q+vec2(uTime*.045,uTime*.02))*.7+fbm(q*.5-vec2(uTime*.02,0.))*.5;
    float d=uFog*(.18+.5*n*n);
    c=mix(c,vec3(.86,.80,.74)*(.55+.45*dot(c,LW)),d*.6)+vec3(.04,.035,.03)*uFog;
  }
  o=vec4(clamp(c,0.,1.),1.);
}`;
const FS_DOWN = COMMON + `
uniform sampler2D uTex; uniform vec2 uTexel;
void main(){ vec3 s=texture(uTex,v+uTexel*vec2(-1,-1)).rgb+texture(uTex,v+uTexel*vec2(1,-1)).rgb
  +texture(uTex,v+uTexel*vec2(-1,1)).rgb+texture(uTex,v+uTexel*vec2(1,1)).rgb; o=vec4(s*.25,1.); }`;
const FS_BLUR = COMMON + `
uniform sampler2D uTex; uniform vec2 uDir;
void main(){
  vec3 s=texture(uTex,v).rgb*.2270270270;
  s+=texture(uTex,v+uDir*1.3846153846).rgb*.3162162162; s+=texture(uTex,v-uDir*1.3846153846).rgb*.3162162162;
  s+=texture(uTex,v+uDir*3.2307692308).rgb*.0702702703; s+=texture(uTex,v-uDir*3.2307692308).rgb*.0702702703;
  o=vec4(s,1.);
}`;
const FS_FINAL = COMMON + `
uniform sampler2D uTex,uSoft,uOver; uniform float uUseOver;
uniform float uGlow,uHal,uDream,uGrain,uGrainSize,uSpark,uLeak,uFade,uTime,uVig,uVigSize,uVigSoft,uVigSwirl,uVigBlur,uVigMode,uVigRound;
uniform vec3 uVigColor; uniform vec2 uRes;
void main(){
  vec3 c=texture(uTex,v).rgb, s=texture(uSoft,v).rgb;
  float sl=dot(s,LW);
  if(uDream>0.){ c=mix(c,1.-(1.-c)*(1.-s),uDream*.55); c=mix(c,s,uDream*.18); }
  if(uGlow>0.){ vec3 g=max(s-.5,0.)/.5; c=1.-(1.-c)*(1.-clamp(g*uGlow*1.7*vec3(1.,.86,.66),0.,1.)); }
  if(uHal>0.){ float h=smoothstep(.45,.95,sl)*(1.-smoothstep(.6,1.,dot(c,LW))); c+=vec3(1.,.32,.12)*h*uHal*.45; }
  // vignette / edges
  if(uVig>0.||uVigBlur>0.){
    vec2 q=(v-.5)*2.; q.x*=mix(1.,uRes.x/uRes.y,uVigRound);
    float r=length(q);
    if(uVigSwirl>0.){ float a=atan(q.y,q.x); r+=uVigSwirl*.16*(fbm(vec2(a*1.6,r*2.)+uTime*.18)-.5); }
    float m=smoothstep(uVigSize,uVigSize+uVigSoft+.02,r);
    c=mix(c,s,m*uVigBlur);
    if(uVigMode<.5) c*=1.-m*uVig*.92;
    else if(uVigMode<1.5) c=mix(c,vec3(1.,.98,.95),m*uVig*.8);
    else c=mix(c,c*.35+uVigColor*.75,m*uVig*.85);
  }
  if(uLeak>0.){
    vec2 a=vec2(uRes.x/uRes.y,1.);
    vec2 lp=vec2(.92+.08*sin(uTime*.31),.82+.12*cos(uTime*.23));
    float d=length((v-lp)*a);
    vec3 lc=mix(vec3(1.,.42,.14),vec3(1.,.78,.42),.5+.5*sin(uTime*.47));
    float k=exp(-d*d*2.6)*(.75+.25*sin(uTime*.9+v.y*3.));
    c=1.-(1.-c)*(1.-lc*uLeak*k*.85);
  }
  float l=dot(c,LW);
  if(uGrain>0.){
    vec2 px=floor(v*uRes/max(uGrainSize,1.));
    float n=h21(px+fract(uTime*7.13)*917.)-.5;
    c+=n*uGrain*.13*(1.-abs(l-.5));
  }
  if(uSpark>0.){
    vec2 px=floor(v*uRes/1.3);
    float n=h21(px*1.7+fract(uTime*5.31)*613.);
    float k=smoothstep(.94,1.,n)*smoothstep(.35,.9,l);
    c+=vec3(1.,.85,.62)*k*uSpark*.45+(n-.5)*uSpark*.025;
  }
  c*=1.-uFade;
  if(uUseOver>.5){ vec4 ov=texture(uOver,v); c=mix(c,ov.rgb/max(ov.a,1e-4),ov.a); }
  o=vec4(clamp(c,0.,1.),1.);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.p = { grade: this.prog(FS_GRADE), down: this.prog(FS_DOWN), blur: this.prog(FS_BLUR), fin: this.prog(FS_FINAL) };
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vid = this.tex(); this.over = this.tex();
    this.luts = { hlgfix: this.lut3(LUTS.hlgfix), zahav: this.lut3(LUTS.zahav) };
    this.fbo = {}; this.lutN = {}; this.dims = [16, 9];
  }
  prog(fs) {
    const gl = this.gl;
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  tex(w, h) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }
  addLut(id, data, n = 17) { this.lutN[id] = n; if (this.luts[id]) this.gl.deleteTexture(this.luts[id]); this.luts[id] = this.lut3(data, n); }
  lut3(b64, n = 17) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_3D, t);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    let a = b64; if (typeof b64 === 'string') { const raw = atob(b64); a = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i); }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, a);
    return t;
  }
  setSize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h && this.fbo.main) return;
    const gl = this.gl; this.canvas.width = w; this.canvas.height = h;
    for (const k in this.fbo) { gl.deleteFramebuffer(this.fbo[k].f); gl.deleteTexture(this.fbo[k].t); }
    const mk = (w, h) => { const t = this.tex(w, h); const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return { f, t, w, h }; };
    const gw = Math.max(2, Math.round(w / 4)), gh = Math.max(2, Math.round(h / 4));
    this.fbo = { main: mk(w, h), a: mk(gw, gh), b: mk(gw, gh) };
  }
  // c: color settings, fx: effect settings (see state.js defaults); hdr: bool; fade 0..1
  draw(source, time, c, fx, hdr, fade = 0, zoom = null, overlay = null) {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height, F = this.fbo;
    if (source) {
      gl.bindTexture(gl.TEXTURE_2D, this.vid);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.dims = [source.videoWidth || source.width, source.videoHeight || source.height];
    }
    let g = this.p.grade; gl.useProgram(g.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, F.main.f); gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.vid); gl.uniform1i(g.u.uVid, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, this.luts.hlgfix); gl.uniform1i(g.u.uFix, 1);
    const styleTex = c.style && this.luts[c.style];
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, styleTex || this.luts.zahav); gl.uniform1i(g.u.uStyle, 2);
    const U = (n, x) => g.u[n] !== undefined && gl.uniform1f(g.u[n], x);
    U('uStyleN', (styleTex && this.lutN[c.style]) || 17);
    U('uHdr', hdr ? 1 : 0); U('uUseStyle', styleTex ? 1 : 0); U('uPal', c.pal / 100);
    U('uExp', c.exposure / 100); U('uCon', c.contrast / 100); U('uSat', c.saturation / 100);
    U('uHi', c.highlights / 100); U('uSh', c.shadows / 100); U('uWarm', c.warmth / 100); U('uTint', c.tint / 100);
    U('uTone', c.tone / 100); U('uColor', c.color / 100); U('uFog', fx.fog / 100); U('uTime', time);
    U('uLight', fx.light / 100); U('uLightSize', .15 + fx.lightSize / 100 * .6);
    gl.uniform2f(g.u.uLightPos, fx.lightX, fx.lightY);
    U('uZoom', zoom ? zoom.s : 1);
    { const [sw, sh] = this.dims; const sa = sw / sh, da = w / h;
      gl.uniform2f(g.u.uCrop, sa > da ? da / sa : 1, sa > da ? 1 : sa / da); } gl.uniform2f(g.u.uZoomC, zoom ? zoom.x : .5, zoom ? zoom.y : .5); gl.uniform2f(g.u.uRes, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // soft chain (used by glow, halation, dream, edge blur)
    g = this.p.down; gl.useProgram(g.p); gl.bindFramebuffer(gl.FRAMEBUFFER, F.a.f); gl.viewport(0, 0, F.a.w, F.a.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.main.t); gl.uniform1i(g.u.uTex, 0); gl.uniform2f(g.u.uTexel, 1 / w, 1 / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    g = this.p.blur; gl.useProgram(g.p);
    for (let i = 0; i < 3; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, F.b.f); gl.bindTexture(gl.TEXTURE_2D, F.a.t); gl.uniform1i(g.u.uTex, 0);
      gl.uniform2f(g.u.uDir, (1 + i * 1.5) / F.a.w, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, F.a.f); gl.bindTexture(gl.TEXTURE_2D, F.b.t);
      gl.uniform2f(g.u.uDir, 0, (1 + i * 1.5) / F.a.h); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    g = this.p.fin; gl.useProgram(g.p); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F.main.t); gl.uniform1i(g.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, F.a.t); gl.uniform1i(g.u.uSoft, 1);
    const V = (n, x) => g.u[n] !== undefined && gl.uniform1f(g.u[n], x);
    V('uGlow', fx.glow / 100); V('uHal', fx.halation / 100); V('uDream', fx.dream / 100);
    V('uGrain', fx.grain / 100); V('uGrainSize', 1 + fx.grainSize / 100 * 2.5); V('uSpark', fx.sparkle / 100); V('uLeak', fx.leak / 100);
    V('uFade', fade); V('uTime', time);
    V('uVig', fx.vig / 100); V('uVigSize', .25 + (1 - fx.vigSize / 100) * .9); V('uVigSoft', .15 + fx.vigSoft / 100 * 1.1);
    V('uVigSwirl', fx.vigSwirl / 100); V('uVigBlur', fx.vigBlur / 100); V('uVigMode', fx.vigMode); V('uVigRound', fx.vigRound / 100);
    const vc = fx.vigColor || [0.55, 0.32, 0.2]; gl.uniform3f(g.u.uVigColor, vc[0], vc[1], vc[2]);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.over); gl.uniform1i(g.u.uOver, 2);
    if (overlay) { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); }
    V('uUseOver', overlay ? 1 : 0);
    gl.uniform2f(g.u.uRes, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  }
}
