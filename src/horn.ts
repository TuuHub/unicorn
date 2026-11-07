// The horn from unicorn.tuuhub.com's hero, for the hosted sign-in's night panel.
//
// FRAG is the landing page's fragment shader verbatim (unicorn-site
// src/components/hero/horn-frag.ts): a raymarched spiral horn shaded as a thin film, so its
// colour slides as it turns. The driver is a dependency-free copy of the hero's (horn-canvas.tsx
// and lib/gl.ts): the pointer leans it, a drag spins it with momentum, a click sends a wave of
// colour up it. It pauses offscreen, drops resolution when frames run long, and stands still
// under reduced motion. Inline script only, so the pages' CSP needs nothing new.
//
// Until the first frame lands, and wherever WebGL2 is missing, HORN_FALLBACK stands in: the
// horn mark drawn large in a spectrum stroke.

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uSpin;     // rotation about the horn's own axis
uniform vec2 uTilt;      // pointer tilt, radians: x leans the tip, y pitches it
uniform float uLine;     // 0 colour, 1 hairline
uniform float uPulse;    // seconds since the last click
uniform vec2 uCenter;    // where the horn sits, in screen units (height = 1)
uniform float uZoom;
uniform vec3 uPaper;     // the background colour

out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.28318531;
const float RAD = 0.36;    // base radius; the horn runs y -1 .. 1
const float TWIST = 44.0;  // radians of groove phase from base to tip, about seven turns

mat3 R;       // local from world
float spin;

mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }

vec3 spectrum(float x) {
  return 0.5 + 0.5 * cos(TAU * (x + vec3(0.0, 0.33, 0.67)));
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

/** Height along the horn, 0 at the base and 1 at the tip. */
float along(vec3 lp) { return clamp(lp.y * 0.5 + 0.5, 0.0, 1.0); }

float groovePhase(vec3 lp) {
  return 2.0 * (atan(lp.z, lp.x) + spin) - along(lp) * TWIST;
}

float horn(vec3 p) {
  vec3 lp = R * p;
  float t = along(lp);
  float r = RAD * pow(1.0 - t, 0.92) + 0.003;
  float ridge = 0.5 + 0.5 * cos(groovePhase(lp));
  float rr = r * (0.885 + 0.115 * sqrt(ridge));
  float d = length(lp.xz) - rr;
  return max(d, abs(lp.y) - 1.0);
}

vec3 normalAt(vec3 p) {
  const vec2 k = vec2(1, -1);
  const float e = 0.0012;
  return normalize(k.xyy * horn(p + k.xyy * e) + k.yyx * horn(p + k.yyx * e) +
                   k.yxy * horn(p + k.yxy * e) + k.xxx * horn(p + k.xxx * e));
}

/** A thin film of index 1.38 over a darker core: per-channel reflectance. */
vec3 thinFilm(float cosI, float nm) {
  float n = 1.38;
  float sinT = sqrt(max(0.0, 1.0 - cosI * cosI)) / n;
  float cosT = sqrt(max(0.0, 1.0 - sinT * sinT));
  vec3 phase = 4.0 * PI * n * nm * cosT / vec3(640.0, 535.0, 455.0);
  return 0.5 + 0.5 * cos(phase);
}

/** A dark studio: two soft boxes, a strip light, and a spectral horizon. */
vec3 studio(vec3 d) {
  vec3 c = vec3(0.015) + vec3(0.05) * smoothstep(-0.3, 1.0, d.y);
  c += vec3(1.6) * smoothstep(0.90, 0.985, dot(d, normalize(vec3(-0.55, 0.65, 0.5))));
  c += vec3(0.8) * smoothstep(0.88, 0.99, dot(d, normalize(vec3(0.7, 0.2, 0.6))));
  c += vec3(0.7) * smoothstep(0.06, 0.0, abs(d.x + 0.25)) * smoothstep(-0.1, 0.5, d.y);
  c += spectrum(atan(d.z, d.x) / TAU + uTime * 0.015) * 0.35 * smoothstep(0.3, 0.0, abs(d.y - 0.05));
  return c;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 q = (uv - uCenter) / uZoom;

  spin = uSpin;
  // world from local: lean the tip up and to the right, then the pointer's share
  mat3 W = rotZ(-0.62 + uTilt.x) * rotX(0.42 + uTilt.y);
  R = transpose(W);

  vec3 ro = vec3(0.0, 0.0, 5.2);
  vec3 rd = normalize(vec3(q, -1.75));

  // Bounding sphere: most pixels never march.
  float b = dot(ro, rd);
  float c = dot(ro, ro) - 1.35 * 1.35;
  float h = b * b - c;

  bool hit = false;
  float t = 0.0, minD = 1e9, glow = 0.0;
  vec3 p = ro;
  if (h > 0.0) {
    t = -b - sqrt(h);
    float tFar = -b + sqrt(h);
    for (int i = 0; i < 110; i++) {
      p = ro + rd * t;
      float d = horn(p);
      minD = min(minD, d);
      glow += 0.018 / (1.0 + d * d * 900.0);
      if (d < 0.0004 * t) { hit = true; break; }
      t += d * 0.55;
      if (t > tFar) break;
    }
  }

  // ---- background ----------------------------------------------------------
  float vign = smoothstep(1.25, 0.2, length(uv * vec2(0.85, 1.0)));
  vec3 bg = vec3(0.008, 0.008, 0.012);
  float neb = fbm(q * 1.25 + vec2(uTime * 0.02, -uTime * 0.015));
  float near = smoothstep(1.6, 0.0, length(q));
  bg += spectrum(neb * 0.9 + q.x * 0.18 - uTime * 0.01) * 0.09 * near * neb;
  bg *= vign;

  // world-space size of one pixel at the horn's depth, for line widths
  float px = (5.2 / 1.75) / (uRes.y * uZoom);

  vec3 colour = bg;
  vec3 drawing = uPaper;
  float ink = 0.0;

  float pulse = uPulse * 0.85;

  if (hit) {
    vec3 n = normalAt(p);
    vec3 v = -rd;
    float cosI = clamp(dot(n, v), 0.0, 1.0);
    vec3 lp = R * p;
    float a = along(lp);
    float ph = groovePhase(lp);
    float ridge = 0.5 + 0.5 * cos(ph);

    float wave = exp(-pow((a - pulse) * 7.0, 2.0)) * step(0.0, uPulse) * step(uPulse, 2.4);
    float nm = 360.0 + 240.0 * sin(ph * 0.5 + a * 5.0 + uTime * 0.5) + 220.0 * a + 520.0 * wave;
    vec3 film = thinFilm(cosI, nm);

    vec3 r = reflect(rd, n);
    vec3 env = studio(r);
    float fres = 0.04 + 0.96 * pow(1.0 - cosI, 5.0);
    float ao = mix(0.45, 1.0, sqrt(ridge));

    float graze = pow(1.0 - cosI, 1.5);
    vec3 pearl = mix(vec3(0.82, 0.8, 0.86), film, 0.35 + 0.55 * graze);
    vec3 L = normalize(vec3(-0.5, 0.75, 0.6));
    float wrap = clamp((dot(n, L) + 0.35) / 1.35, 0.0, 1.0);
    vec3 body = pearl * (0.06 + 0.42 * wrap * wrap) * ao;
    vec3 spec = env * mix(pearl, vec3(1.0), 0.25) * mix(0.45, 1.3, fres) * mix(0.7, 1.0, ao);
    vec3 rim = spectrum(a * 1.3 + ph / TAU * 0.12 + uTime * 0.04) * pow(1.0 - cosI, 3.0) * 0.8;
    colour = body + spec + rim + film * wave * 0.8;

    // the base dissolves into the dark instead of showing a cut
    colour = mix(bg, colour, smoothstep(0.0, 0.16, a));

    // ---- hairline: the grooves and the silhouette, nothing else ----
    // derivative of the phase without atan's wrap: d(atan(z, x)) = (x dz - z dx) / (x² + z²)
    vec2 dx = vec2(dFdx(lp.x), dFdy(lp.x));
    vec2 dz = vec2(dFdx(lp.z), dFdy(lp.z));
    vec2 dy = vec2(dFdx(lp.y), dFdy(lp.y));
    vec2 dAng = (lp.x * dz - lp.z * dx) / max(dot(lp.xz, lp.xz), 1e-5);
    float w = length(2.0 * dAng - TWIST * 0.5 * dy) / TAU;
    float g = abs(fract(ph / TAU) - 0.5);
    float groove = 1.0 - smoothstep(0.0, max(w, 1e-4) * 1.3, g);
    float edge = 1.0 - smoothstep(0.0, 0.14, cosI);
    float fade = smoothstep(0.02, 0.12, a);
    ink = max(groove * 0.7, edge) * fade;
  } else {
    // a near miss is the silhouette: in colour a soft spectral edge, in line the stroke
    float edgeCov = (1.0 - smoothstep(0.0, 1.6 * px, minD)) * step(minD, 1.0);
    colour += spectrum(q.y * 0.5 + uTime * 0.04) * edgeCov * 0.35;
    ink = (1.0 - smoothstep(0.6 * px, 1.8 * px, minD)) * step(minD, 1.0);
  }

  colour += spectrum(q.y * 0.45 + q.x * 0.2 + uTime * 0.03) * glow * 0.16;
  colour = aces(colour * 1.35);
  colour = pow(colour, vec3(0.92));

  vec3 inkColour = mix(uPaper, vec3(0.93), 0.92);
  drawing = mix(uPaper, inkColour, ink);

  vec3 outC = mix(colour, drawing, uLine);
  // dither, so the dark gradients never band
  outC += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  outColor = vec4(outC, 1.0);
}
`;

export const HORN_SCRIPT = `<script>var FRAG = ${JSON.stringify(FRAG)};\n(function () {
  var panel = document.querySelector("[data-horn]");
  var canvas = panel && panel.querySelector("canvas");
  if (!canvas) return;
  var gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance" });
  if (!gl) return;
  function compile(type, text) {
    var s = gl.createShader(type);
    gl.shaderSource(s, text);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog = gl.createProgram();
  try {
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, "#version 300 es\\nin vec2 p;\\nvoid main(){gl_Position=vec4(p,0.0,1.0);}"));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) { return; }
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.useProgram(prog);
  var cache = {};
  function u(n) { if (!(n in cache)) cache[n] = gl.getUniformLocation(prog, n); return cache[n]; }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var scale = 0.9, maxDpr = 1.5;
  function spring(x) { return { x: x, v: 0, t: x, step: function (dt) {
    var a = -100 * (this.x - this.t) - 18 * this.v; this.v += a * dt; this.x += this.v * dt;
    var m = Math.abs(this.v) > 1e-4 || Math.abs(this.x - this.t) > 1e-4; if (!m) this.x = this.t; return m; } }; }
  var tiltX = spring(0), tiltY = spring(0);
  var spin = 0.6, spinV = 0, pulse = -1, time = 0, drag = null, first = true;

  function layout() {
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr) * scale;
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    var aspect = w / h;
    gl.uniform2f(u("uRes"), w, h);
    // the horn stands in the free space above the copy, sized to it (screen units: height = 1)
    var foot = panel.querySelector(".door-foot");
    var H = canvas.clientHeight || 1;
    var free = Math.max(0.3, (H - (foot ? foot.offsetHeight : 0)) / H);
    gl.uniform2f(u("uCenter"), 0.035 * Math.min(1, aspect), 0.5 - free / 2);
    gl.uniform1f(u("uZoom"), Math.min(1.25, free * 1.15, aspect * 1.5));
  }
  gl.uniform3f(u("uPaper"), 0.008, 0.008, 0.012);
  gl.uniform1f(u("uLine"), 0);
  layout();

  var raf = 0, last = 0, avg = 1 / 60, since = 0, onScreen = true;
  function frame(now) {
    raf = 0;
    var dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
    last = now;
    // drop resolution when frames run long, never below 0.45
    avg += (dt - avg) * 0.05; since += dt;
    if (since > 1 && avg > 1 / 42 && scale > 0.45) { scale = Math.max(0.45, scale * 0.8); since = 0; avg = 1 / 60; layout(); }
    if (!reduced) time += dt;
    var moving = tiltX.step(dt); moving = tiltY.step(dt) || moving;
    if (!drag) { spinV *= Math.exp(-dt * 2.2); if (Math.abs(spinV) < 1e-3) spinV = 0; }
    spin += (reduced ? 0 : 0.32 * dt) + spinV * dt;
    if (pulse >= 0) { pulse += dt; if (pulse > 2.6) pulse = -1; }
    gl.uniform1f(u("uTime"), time);
    gl.uniform1f(u("uSpin"), spin);
    gl.uniform2f(u("uTilt"), tiltX.x, tiltY.x);
    gl.uniform1f(u("uPulse"), pulse);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (first) { first = false; panel.classList.add("is-live"); }
    if (!reduced || moving || spinV !== 0 || pulse >= 0) schedule();
  }
  function schedule() { if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
  new IntersectionObserver(function (e) { onScreen = e[0].isIntersecting; if (onScreen) schedule(); else stop(); }).observe(canvas);
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else schedule(); });
  new ResizeObserver(function () { layout(); schedule(); }).observe(canvas);

  window.addEventListener("pointermove", function (e) {
    var r = panel.getBoundingClientRect();
    var nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    if (drag && e.pointerId === drag.id) {
      var now = performance.now(), dx = e.clientX - drag.x, dts = Math.max(1, now - drag.t) / 1000;
      spinV = spinV * 0.4 + ((dx / r.width) * 9 / dts) * 0.6; spin += (dx / r.width) * 9;
      drag.x = e.clientX; drag.t = now;
    }
    tiltX.t = -Math.max(-1.4, Math.min(1.4, nx)) * 0.32;
    tiltY.t = Math.max(-1.2, Math.min(1.2, ny)) * 0.22;
    schedule();
  }, { passive: true });
  panel.addEventListener("pointerdown", function (e) {
    if (e.target.closest("a,button,input")) return;
    drag = { x: e.clientX, t: performance.now(), id: e.pointerId }; pulse = 0; schedule();
  });
  window.addEventListener("pointerup", function () { drag = null; });
  window.addEventListener("pointercancel", function () { drag = null; });
  canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); panel.classList.remove("is-live"); });
  schedule();
})();</script>`;

export const HORN_FALLBACK = `<svg class="horn-mark" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <defs>
    <linearGradient id="horn-ink" x1="6" y1="22" x2="18" y2="2" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff7a70"/><stop offset=".25" stop-color="#ffc35c"/><stop offset=".5" stop-color="#8be39a"/><stop offset=".75" stop-color="#6dbbff"/><stop offset="1" stop-color="#b896ff"/>
    </linearGradient>
    <filter id="horn-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".8"/></filter>
  </defs>
  <g stroke="url(#horn-ink)" stroke-width=".55" filter="url(#horn-glow)" opacity=".7"><path d="M12 2.5 17.5 20a5.5 2 0 0 1-11 0Z"/><path d="M8.4 14.4q3.6 1.9 7.4-.6M10.1 9q2.2 1.2 4.3-.4"/></g>
  <g stroke="url(#horn-ink)" stroke-width=".32"><path class="draw" pathLength="1" d="M12 2.5 17.5 20a5.5 2 0 0 1-11 0Z"/><path class="draw" pathLength="1" d="M8.4 14.4q3.6 1.9 7.4-.6M10.1 9q2.2 1.2 4.3-.4"/></g>
</svg>`;
