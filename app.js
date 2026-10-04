import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ================================================================== shared
const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const resultsP = fetch("assets/results.json").then((r) => r.json()).catch(() => null);   // charts data, requested first
const DATASETS = [["hdepic", "Kitchen", "HD-EPIC"], ["ucs", "Mall", "UCS-Bench"], ["vq3d", "Workshop", "Ego4D VQ3D"]];
const UP = { hdepic: "z", vq3d: "z", ucs: "-y" };                  // which world axis points up
const HFOV = { hdepic: 100, ucs: 68, vq3d: 92 };                   // drawn field of view of each wearer camera (deg)
const PT = { hdepic: 0.022, ucs: 0.026, vq3d: 0.034 };             // dense point size (m)
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const hue = (id) => (id * 137.508) % 360;
const col = (id, a = 1, l = 62) => `hsla(${hue(id)},72%,${l}%,${a})`;
const col3 = (id) => new THREE.Color(`hsl(${Math.round(hue(id))},72%,62%)`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const loadImg = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
const ICON = {                                                      // line icons (stroke = currentColor)
  text: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
  time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>',
  position: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg>',
  think: '<svg viewBox="0 0 24 24"><path d="M8 16.5H7a4.2 4.2 0 0 1-.7-8.35 5.6 5.6 0 0 1 10.9-.9A4.3 4.3 0 0 1 17 16.5z"/><circle cx="6.3" cy="19.6" r="1.25"/><circle cx="3.4" cy="22" r=".7"/></svg>',
  answer: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
};
const cache = {};
function toThree(X, xyz, rgb, n, ceil = Infinity) {                 // memory frame -> three.js; indoor scenes lose their ceiling (dollhouse cut)
  const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3); let k = 0;
  for (let i = 0; i < n; i++) { const v = X.W2T([xyz(3 * i), xyz(3 * i + 1), xyz(3 * i + 2)]); if (v.y > ceil) continue;
    pos[3 * k] = v.x; pos[3 * k + 1] = v.y; pos[3 * k + 2] = v.z; col[3 * k] = rgb[3 * i]; col[3 * k + 1] = rgb[3 * i + 1]; col[3 * k + 2] = rgb[3 * i + 2]; k++; }
  return { pos: pos.subarray(0, 3 * k), rgb: col.subarray(0, 3 * k), n: k };
}
async function loadDense(X) {                                      // Pi3X reconstruction, int16-quantised (tools/dense_recon.py)
  try {
    const [m, b] = await Promise.all([fetch(X.A + "dense.json").then((r) => (r.ok ? r.json() : null)), fetch(X.A + "dense.bin").then((r) => (r.ok ? r.arrayBuffer() : null))]);
    if (!m || !b) return null;
    const q = new Int16Array(b, 0, m.n * 3), o = m.offset, s = m.scale;
    const ceil = X.up === "z" ? Math.max(...X.D.camera.map((c) => X.W2T(c.slice(1, 4)).y)) + 0.45 : Infinity;
    return toThree(X, (i) => (q[i] + 32500) * s + o[i % 3], new Uint8Array(b, m.n * 6, m.n * 3), m.n, ceil);
  } catch (e) { return null; }
}
async function getDS(name) {
  if (cache[name]) return cache[name];
  const A = `assets/${name}/`;
  const [D, task] = await Promise.all([fetch(A + "data.json").then((r) => r.json()), fetch(A + "task.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  const sprite = await loadImg(A + D.sprite.file);
  let pts = null; try { const r = await fetch(A + "points.bin"); if (r.ok) pts = await r.arrayBuffer(); } catch (e) { /* none */ }
  const objById = new Map(D.objects.map((o) => [o.id, o])), detsByOb = new Map();
  D.frames.forEach((f, fi) => f.dets.forEach((d) => { if (d.ob === undefined) return; if (!detsByOb.has(d.ob)) detsByOb.set(d.ob, []); detsByOb.get(d.ob).push({ ...d, t: f.t, fi }); }));
  const moves = D.objects.filter((o) => o.segs.length >= 2 && o.segs.every((s) => s.w));
  const X = { name, A, D, task, sprite, objById, detsByOb, moves, speed: D.speed || 1, up: UP[name] };
  X.W2T = X.up === "z" ? (p) => new THREE.Vector3(p[0], p[2], -p[1]) : (p) => new THREE.Vector3(p[0], -p[1], -p[2]);
  if (pts) { const n = pts.byteLength / 15, xyz = new Float32Array(pts, 0, n * 3); X.sparse = toThree(X, (i) => xyz[i], new Uint8Array(pts, n * 12, n * 3), n); }
  X.denseP = loadDense(X);
  return (cache[name] = X);
}
function posAt(o, t) {
  const tr = o.traj; if (!tr.length || t < tr[0][0]) return null;
  const i = tr.findIndex((p) => p[0] > t); if (i === -1) return tr[tr.length - 1].slice(1);
  const a = tr[i - 1], b = tr[i]; if (b[0] - a[0] > 12) return a.slice(1);
  const f = (t - a[0]) / (b[0] - a[0]); return [0, 1, 2].map((k) => a[k + 1] + f * (b[k + 1] - a[k + 1]));
}
const firstDS = getDS(Q.get("ds") || "hdepic");                  // start loading before any WebGL context exists
if (Q.has("preload")) await (await firstDS).denseP;               // (headless tests: fetches after a WebGL context fail there)
const eventAt = (X, t) => { let e = null; for (const x of X.D.events) if (x.t <= t + 1e-6) e = x; return e; };
function camLerp(X, t) {                                           // wearer camera [t, centre, forward] at time t, interpolated
  const P = X.D.camera; if (t <= P[0][0]) return P[0]; const i = P.findIndex((c) => c[0] > t); if (i === -1) return P[P.length - 1];
  const a = P[i - 1], b = P[i]; if (b[0] - a[0] > 8) return a; const f = (t - a[0]) / (b[0] - a[0]); return a.map((v, k) => (k ? v + f * (b[k] - v) : t));
}
const tileXY = (X, id) => { const c = X.D.sprite.cols, s = X.D.sprite.tile; return [(id % c) * s, Math.floor(id / c) * s]; };
const nearestFrame = (X, t) => X.D.frames.reduce((b, f, i) => (Math.abs(f.t - t) < Math.abs(X.D.frames[b].t - t) ? i : b), 0);
const frameSrc = (X, i) => `${X.A}frames/${String(i).padStart(2, "0")}.jpg`;
const iou = (a, b) => { const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0; const i = w * h; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i); };
function textSprite(text, color = "#fff", size = 30) {
  const c = document.createElement("canvas"), g = c.getContext("2d"); g.font = `600 ${size}px Inter, -apple-system, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 24; c.width = w; c.height = size + 18; g.font = `600 ${size}px Inter, -apple-system, sans-serif`;
  g.fillStyle = "rgba(8,10,13,.82)"; g.beginPath(); g.roundRect(0, 0, w, c.height, c.height / 2); g.fill(); g.fillStyle = color; g.fillText(text, 12, size + 2);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, fog: false, sizeAttenuation: false }));
  s.renderOrder = 10; s.userData.aspect = w / c.height; return s;
}

// ================================================================== 3D world: dense point cloud + live memory (hero + ask)
const UPV = new THREE.Vector3(0, 1, 0), M4 = new THREE.Matrix4();
const DISC = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d"), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "#fff"); r.addColorStop(0.7, "#fff"); r.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
const texCache = new Map();
function tex(src) { if (!texCache.has(src)) { const t = new THREE.TextureLoader().load(src); t.colorSpace = THREE.SRGBColorSpace; texCache.set(src, t); } return texCache.get(src); }
function basis(X, c) {                                             // camera centre C, forward F, right R, up U (three.js frame)
  const C = X.W2T(c.slice(1, 4)), F = X.W2T(c.slice(4, 7)).normalize(), R = new THREE.Vector3().crossVectors(F, UPV);
  if (R.lengthSq() < 1e-6) R.set(1, 0, 0); R.normalize(); return { C, F, R, U: new THREE.Vector3().crossVectors(R, F) };
}
function orient(obj, b) { obj.position.copy(b.C); obj.quaternion.setFromRotationMatrix(M4.makeBasis(b.R, b.U, b.F.clone().negate())); }
function frustum(X, c, d, color, map, opacity = 1) {               // a camera pyramid with its picture on the image plane
  const b = basis(X, c), w = d * Math.tan((HFOV[X.name] * Math.PI) / 360), h = (w * X.D.res[1]) / X.D.res[0], g = new THREE.Group();
  const P = [[0, 0, 0], [-w, -h, -d], [w, -h, -d], [w, h, -d], [-w, h, -d]], E = [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 2, 3, 3, 4, 4, 1];
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(E.flatMap((i) => P[i]), 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, fog: false })));
  if (map !== undefined) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(2 * w, 2 * h), new THREE.MeshBasicMaterial({ map, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    pl.position.z = -d; pl.visible = !!map; g.add(pl); g.userData.plane = pl;
  }
  orient(g, b); Object.assign(g.userData, { C: b.C, F: b.F, centre: b.C.clone().addScaledVector(b.F, d) }); return g;
}
const easeBack = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);

class World {
  constructor(host, { path = true } = {}) {
    this.host = host; this.showPath = path; this.r = new THREE.WebGLRenderer({ antialias: true, alpha: true }); this.r.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.prepend(this.r.domElement); this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(50, 1, 0.02, 400);
    this.ctl = new OrbitControls(this.cam, this.r.domElement); this.ctl.enableDamping = true; this.ctl.autoRotateSpeed = 0.45;
    this.ctl.enableZoom = false; this.r.domElement.style.touchAction = "pan-y";      // the page keeps scrolling over a big 3D view
    this.r.domElement.addEventListener("pointerdown", () => (this.goal = null));
    this.tagLayer = document.createElement("div"); this.tagLayer.className = "tags3d"; host.appendChild(this.tagLayer);
    this.tags = new Map(); this.hl = null; this.keys = new Set(); this.goal = null; this.tw = []; this.visible = true;
    new ResizeObserver(() => this.resize()).observe(host); this.resize();
    new IntersectionObserver((es) => es.forEach((e) => (this.visible = e.isIntersecting)), { threshold: 0.02 }).observe(host);
  }
  resize() { const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return; this.r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
  tween(dur, f, delay = 0) { this.tw.push({ t0: performance.now() + delay, dur, f }); }
  set(X) {
    if (this.g) this.scene.remove(this.g); const g = (this.g = new THREE.Group()); this.scene.add(g); this.X = X; this.hl = null; this.keys = new Set(); this.tw = [];
    this.tagLayer.innerHTML = ""; this.tags = new Map(); this.cloud = null;
    const camPts = (this.camPts = X.D.camera.map((c) => X.W2T(c.slice(1, 4)))), objPts = X.D.objects.flatMap((o) => o.traj.map((p) => X.W2T(p.slice(1))));
    const box = new THREE.Box3().setFromPoints([...objPts, ...camPts]), ctr = box.getCenter(new THREE.Vector3());
    const rad = (this.rad = Math.max(1.5, box.getSize(new THREE.Vector3()).length() * 0.5)); this.ctr = ctr;
    this.scene.fog = new THREE.Fog(0x060708, rad * 1.5, rad * 5);
    if (X.sparse) this.setCloud(X.sparse, rad * 0.006);
    X.denseP.then((d) => { if (d && this.X === X) this.setCloud(d, PT[X.name]); });
    this.pathAll = new THREE.Line(new THREE.BufferGeometry().setFromPoints(camPts), new THREE.LineBasicMaterial({ color: 0x5a6372, transparent: true, opacity: 0.6, fog: false }));
    this.pathAll.visible = this.showPath; g.add(this.pathAll);
    this.pathNow = new THREE.Line(new THREE.BufferGeometry().setFromPoints(camPts), new THREE.LineBasicMaterial({ color: 0xffffff, fog: false })); this.pathNow.visible = this.showPath; g.add(this.pathNow);
    const dot = new THREE.SphereGeometry(rad * 0.009, 16, 12);
    this.nodes = X.D.objects.map((o) => { const m = new THREE.Mesh(dot, new THREE.MeshBasicMaterial({ color: col3(o.id), transparent: true, fog: false }));
      m.visible = false; m.renderOrder = 2; m.userData = { o, born: -1 }; g.add(m); return m; });
    this.byId = new Map(this.nodes.map((m) => [m.userData.o.id, m]));
    this.arrows = X.moves.map((o) => { const p = o.segs.map((s) => X.W2T(s.w)), lift = new THREE.Vector3(0, rad * 0.08, 0);
      const curve = new THREE.CatmullRomCurve3(p.flatMap((q, i) => (i ? [p[i - 1].clone().lerp(q, 0.5).add(lift), q] : [q])));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, rad * 0.003, 6), new THREE.MeshBasicMaterial({ color: 0xe8703a, fog: false })); tube.visible = false; g.add(tube);
      return { tube, t: o.segs[1].t[0] }; });
    this.extra = new THREE.Group(); g.add(this.extra); this.overview(true);
  }
  setCloud(c, size) {
    if (this.cloud) { this.g.remove(this.cloud); this.cloud.geometry.dispose(); this.cloud.material.dispose(); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(c.pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(c.rgb, 3, true));
    const mat = new THREE.PointsMaterial({ size, vertexColors: true, map: DISC, alphaTest: 0.4, transparent: true }), px = (4.5 * this.r.getPixelRatio()).toFixed(1), near = (this.rad * 0.05).toFixed(3);
    mat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace("#include <fog_vertex>",                  // close points stay small; the nearest vanish
      `#include <fog_vertex>\n  gl_PointSize = clamp(gl_PointSize, 1.6, ${px});\n  if (-mvPosition.z < ${near}) gl_PointSize = 0.0;`); };
    mat.customProgramCacheKey = () => `cloud${px}_${near}`;
    this.cloud = new THREE.Points(geo, mat); this.g.add(this.cloud);
  }
  fly(tgt, pos, snap = false) { if (snap) { this.ctl.target.copy(tgt); this.cam.position.copy(pos); this.goal = null; } else this.goal = { tgt: tgt.clone(), pos: pos.clone() }; }
  overview(snap = false) { this.fly(this.ctr, this.ctr.clone().add(new THREE.Vector3(this.rad * 0.72, this.rad * 0.8, this.rad * 0.72)), snap); }
  fit(pts, k = 2.2) {                                              // frame a set of points, keeping the current viewing direction (from above)
    if (!pts.length) return; const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const r = Math.max(this.rad * 0.16, ...pts.map((p) => p.distanceTo(c))), dir = this.cam.position.clone().sub(this.ctl.target);
    dir.y = Math.max(dir.y, dir.length() * 0.55); dir.normalize(); this.fly(c, c.clone().addScaledVector(dir, r * k));
  }
  objPos(id, t) { const o = this.X.objById.get(id); const p = o && (posAt(o, t) || (o.traj.length ? o.traj[o.traj.length - 1].slice(1) : null)); return p ? this.X.W2T(p) : null; }
  update(t) {
    if (!this.X) return 0; let n = 0; const now = performance.now();
    for (const m of this.nodes) {
      const p = posAt(m.userData.o, t); if (!p) { m.visible = false; m.userData.born = -1; continue; }
      if (m.userData.born < 0) m.userData.born = now; const age = (now - m.userData.born) / 600; let s = age < 1 ? 1 + 1.6 * (1 - age) : 1;
      const lit = !this.hl || this.hl.has(m.userData.o.id); if (this.hl && lit) s *= this.keys.has(m.userData.o.id) ? 2.1 : 1.5;
      m.material.opacity = lit ? 1 : 0.12; m.position.copy(this.X.W2T(p)); m.scale.setScalar(s); m.visible = true; n++;
    }
    for (const a of this.arrows) a.tube.visible = t >= a.t && !this.hl && !this.noArrows;
    const k = this.X.D.camera.findIndex((c) => c[0] > t); this.pathNow.geometry.setDrawRange(0, k === -1 ? this.X.D.camera.length : Math.max(1, k));
    if (this.cloud) this.cloud.material.color.setScalar(this.hl ? 0.5 : 1);          // dim by colour: opacity would push small points under the alpha test
    for (const s of this.extra.children) if (s.isSprite) { const h = (s.userData.h ?? 0.03) * (s.userData.k ?? 1); s.scale.set(h * s.userData.aspect, h, 1); }   // constant on screen
    return n;
  }
  highlight(ids, keys = null) { this.hl = ids && ids.size ? ids : null; this.keys = keys || new Set(); }
  placeTags() {                                                   // a name tag on every visible dot; overlapping tags give way to bigger ones
    const w = this.host.clientWidth, h = this.host.clientHeight, shown = new Set(), v = new THREE.Vector3(), hr = this.host.getBoundingClientRect();
    const placed = (this.avoid || []).map((e) => { const r = e.getBoundingClientRect(); return [r.left - hr.left, r.top - hr.top, r.right - hr.left, r.bottom - hr.top]; });   // keep clear of overlaid text
    const K = this.keys || new Set(), cand = this.nodes.filter((m) => m.visible && (!this.hl || this.hl.has(m.userData.o.id)))
      .sort((a, b) => (K.has(b.userData.o.id) - K.has(a.userData.o.id)) || ((this.seen?.has(b.userData.o.id) ?? 0) - (this.seen?.has(a.userData.o.id) ?? 0)) || b.userData.o.n_obs - a.userData.o.n_obs);
    for (const m of cand) {
      v.copy(m.position).project(this.cam); if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) continue;
      const o = m.userData.o, x = ((v.x + 1) / 2) * w + 7, y = ((1 - v.y) / 2) * h - 9; let el = this.tags.get(o.id);
      if (!el) { el = document.createElement("span"); el.textContent = o.name; el.style.borderLeftColor = col(o.id, 1, 66); this.tagLayer.appendChild(el); this.tags.set(o.id, el); el._w = el.offsetWidth || o.name.length * 6.4 + 14; }
      const r = [x, y, x + el._w, y + 17];
      if (!K.has(o.id) && placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
      placed.push(r); shown.add(o.id); el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      el.classList.toggle("lit", !!this.hl || !!this.seen?.has(o.id)); el.classList.toggle("key", K.has(o.id));
    }
    for (const [id, el] of this.tags) el.style.display = shown.has(id) ? "" : "none";
  }
  marker(p, color, label, size = 1) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(this.rad * 0.02 * size, 20, 14), new THREE.MeshBasicMaterial({ color, fog: false })); m.position.copy(this.X.W2T(p)); this.extra.add(m);
    if (label) { const s = textSprite(label, "#fff", 26); s.position.copy(m.position).add(new THREE.Vector3(0, this.rad * 0.06 * size, 0)); this.extra.add(s); } return m;
  }
  line(a, b, color) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.X.W2T(a), this.X.W2T(b)]), new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.05, fog: false })); l.computeLineDistances(); this.extra.add(l); }
  clearExtra() { for (const c of [...this.extra.children]) this.extra.remove(c); }
  render() {
    const now = performance.now(); this.tw = this.tw.filter((w) => { const k = (now - w.t0) / w.dur; if (k < 0) return true; w.f(Math.min(1, k)); return k < 1; });
    const a = 1 - Math.exp(-Math.min(1000, now - (this.last || now)) / 380); this.last = now;
    if (this.goal) { this.ctl.target.lerp(this.goal.tgt, a); this.cam.position.lerp(this.goal.pos, a); if (this.cam.position.distanceTo(this.goal.pos) < this.rad * 0.002) this.goal = null; }
    this.ctl.update(); const d = this.cam.position.distanceTo(this.ctl.target); this.scene.fog.near = d + this.rad * 0.5; this.scene.fog.far = d + this.rad * 3.2;   // fog follows the focus
    for (const m of this.nodes) if (m.visible) m.scale.multiplyScalar(Math.min(1.2, Math.max(0.22, this.cam.position.distanceTo(m.position) / (this.rad * 0.9))));   // ~constant on screen
    this.r.render(this.scene, this.cam); this.placeTags();
  }
}

// ================================================================== dataset switch
let X = null; const listeners = [];
const sw = $("switch");
for (const [k, a, b] of DATASETS) { const btn = document.createElement("button"); btn.innerHTML = `${a} <small>${b}</small>`; btn.dataset.k = k; btn.onclick = () => select(k); sw.appendChild(btn); }
async function select(k) { X = await (k === (Q.get("ds") || "hdepic") ? firstDS : getDS(k)); [...sw.children].forEach((b) => b.classList.toggle("on", b.dataset.k === k)); for (const f of listeners) f(X); }

// ================================================================== HERO: the wearer moving through the reconstructed scene
const vid = $("vid"), vpane = $("vpane"), hero = new World($("world")); hero.avoid = [document.querySelector(".heroText h1"), $("vpane"), $("modes"), document.querySelector(".hud")];
const vover = document.createElement("canvas"); vover.style.pointerEvents = "none"; vpane.appendChild(vover); const vctx = vover.getContext("2d");
const bar = $("bar"), fill = $("fill"), knob = $("knob"), vtex = new THREE.VideoTexture(vid); vtex.colorSpace = THREE.SRGBColorSpace;
let live = null, rays = null, trail = [], mode = "orbit";
listeners.push((X) => {
  vid.src = X.A + X.D.video; vpane.style.setProperty("--ar", `${X.D.res[0]}/${X.D.res[1]}`);
  hero.set(X); live = frustum(X, X.D.camera[0], hero.rad * 0.1, 0xffffff, vtex, 0.97); hero.g.add(live);
  rays = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, fog: false }));
  rays.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 6), 3)); rays.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(64 * 6), 3)); hero.g.add(rays);
  trail = X.D.frames.map((f, i) => { const fr = frustum(X, camLerp(X, f.t), hero.rad * 0.05, 0x9cc3f5, null, 0.85); fr.visible = false; Object.assign(fr.userData, { t: f.t, src: frameSrc(X, i) }); hero.g.add(fr); return fr; });
  bar.querySelectorAll(".tick").forEach((e) => e.remove());
  for (const o of X.moves) { const d = document.createElement("div"); d.className = "tick"; d.style.left = `${(100 * o.segs[1].t[0]) / X.D.duration}%`; bar.appendChild(d); }
  $("speedNote").textContent = X.speed > 1 ? `${X.speed}× time-lapse` : ""; setMode(Q.get("mode") || mode); vid.play().catch(() => {});
});
function setMode(m) {
  mode = m; hero.noArrows = m === "follow"; [...$("modes").children].forEach((b) => b.classList.toggle("on", b.dataset.m === m)); hero.ctl.autoRotate = m === "orbit";
  if (m === "orbit") hero.overview();
}
for (const b of $("modes").children) b.onclick = () => setMode(b.dataset.m);
hero.ctl.addEventListener("start", () => { if (mode !== "free") setMode("free"); });        // grabbing the view frees the camera
function heroUpdate(X, t) {
  const n = hero.update(t), b = basis(X, camLerp(X, t)); orient(live, b);
  const f = X.D.frames[nearestFrame(X, t)], ids = [...new Set(f.dets.filter((d) => d.ob !== undefined).map((d) => d.ob))];
  const P = rays.geometry.attributes.position.array, C = rays.geometry.attributes.color.array; let k = 0;       // rays: camera -> what it sees now
  for (const id of ids) { const m = hero.byId.get(id); if (!m || !m.visible || k >= 64) continue; const c = col3(id);
    P.set([b.C.x, b.C.y, b.C.z, m.position.x, m.position.y, m.position.z], 6 * k); C.set([c.r * 0.25, c.g * 0.25, c.b * 0.25, c.r, c.g, c.b], 6 * k); k++; }
  rays.geometry.setDrawRange(0, 2 * k); rays.geometry.attributes.position.needsUpdate = rays.geometry.attributes.color.needsUpdate = true; hero.seen = new Set(ids);
  for (const fr of trail) {                                        // every keyframe the memory read, left where it was taken
    const age = t - fr.userData.t; fr.visible = age >= -0.01 && (mode !== "follow" || age < 40 * X.speed);
    if (fr.visible && !fr.userData.loaded) { fr.userData.loaded = true; const pl = fr.userData.plane; pl.material.map = tex(fr.userData.src); pl.material.needsUpdate = true; pl.visible = true; }
    if (fr.visible) fr.userData.plane.material.opacity = Math.max(0.3, 0.9 - age / (90 * X.speed));            // older views fade
  }
  const Fh = new THREE.Vector3(b.F.x, 0, b.F.z); if (Fh.lengthSq() < 1e-4) Fh.set(0, 0, -1); Fh.normalize(); const R = hero.rad;
  const now = performance.now(), a = 1 - Math.exp(-Math.min(1000, now - (heroUpdate.last || now)) / 420); heroUpdate.last = now;   // frame-rate independent easing
  if (mode === "follow") { hero.cam.position.lerp(b.C.clone().addScaledVector(Fh, -R * 0.48).addScaledVector(UPV, R * 0.3), a); hero.ctl.target.lerp(b.C.clone().addScaledVector(b.F, R * 0.16), a); }
  else if (mode === "orbit") hero.ctl.target.lerp(hero.ctr.clone().lerp(b.C, 0.5), a * 0.4);          // circle the room, drifting with the wearer
  else if (mode === "top") { hero.cam.position.lerp(b.C.clone().addScaledVector(UPV, R * 1.15).addScaledVector(Fh, -R * 0.45), a); hero.ctl.target.lerp(b.C, a); }
  return n;
}
let tFix = Q.get("t") !== null ? +Q.get("t") : null;           // deep link: open the memory at a moment (until the user plays)
const tNow = () => (X ? Math.min(tFix ?? (vid.currentTime || 0) * X.speed, X.D.duration) : 0);
function seekFrom(e) { tFix = null; const r = bar.getBoundingClientRect(); vid.currentTime = (Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * X.D.duration) / X.speed; }
let dragging = false;
bar.addEventListener("pointerdown", (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seekFrom(e); });
bar.addEventListener("pointermove", (e) => dragging && seekFrom(e)); bar.addEventListener("pointerup", () => (dragging = false));
$("play").onclick = () => { tFix = null; vid.paused ? vid.play() : vid.pause(); };
$("pipx").onclick = () => vpane.classList.toggle("big");
vid.addEventListener("play", () => { $("play").textContent = "❚❚"; $("phint").style.opacity = 0; hero.highlight(null); vctx.clearRect(0, 0, vover.width, vover.height); });
vid.addEventListener("pause", () => { $("play").textContent = "▶"; $("phint").style.opacity = 1; });
new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? vid.play().catch(() => {}) : vid.pause())), { threshold: 0.3 }).observe($("world"));
const pick = (f, mx, my) => f.dets.filter((d) => d.ob !== undefined && mx >= d.box[0] && mx <= d.box[2] && my >= d.box[1] && my <= d.box[3])
  .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
vpane.addEventListener("pointermove", (e) => {
  if (!X || !vid.paused) return; $("phint").style.opacity = 0;
  const r = vpane.getBoundingClientRect(), mx = (e.clientX - r.left) / r.width, my = (e.clientY - r.top) / r.height, t = tNow();
  const fi = nearestFrame(X, t), f = X.D.frames[fi], S = (vover.width = r.width * 2), H = (vover.height = r.height * 2);
  vctx.clearRect(0, 0, S, H); const hit = Math.abs(f.t - t) <= 2.5 * X.speed ? pick(f, mx, my) : null;
  if (!hit) { hideSG(); hero.highlight(null); return; }
  vctx.strokeStyle = col(hit.ob); vctx.lineWidth = 4; vctx.strokeRect(hit.box[0] * S, hit.box[1] * H, (hit.box[2] - hit.box[0]) * S, (hit.box[3] - hit.box[1]) * H);
  showSG(sceneGraph(X, hit, f, t), e); hero.highlight(new Set([hit.ob]));
});
vpane.addEventListener("pointerleave", () => { hideSG(); vctx.clearRect(0, 0, vover.width, vover.height); if (vid.paused) hero.highlight(null); });
hero.r.domElement.addEventListener("pointermove", (e) => {      // hover a memory object in 3D -> its scene graph
  if (!X || e.buttons) return; const r = hero.r.domElement.getBoundingClientRect(), v = new THREE.Vector3(); let best = null, bd = 16;
  for (const m of hero.nodes) { if (!m.visible) continue; v.copy(m.position).project(hero.cam); if (v.z > 1) continue;
    const d = Math.hypot(((v.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - v.y) / 2) * r.height - (e.clientY - r.top)); if (d < bd) { bd = d; best = m; } }
  if (!best) { hideSG(); if (hero.hl && !vid.paused) hero.highlight(null); return; }
  const t = tNow(), ds = X.detsByOb.get(best.userData.o.id) || []; if (!ds.length) return;
  const d = ds.reduce((a, q) => (Math.abs(q.t - t) < Math.abs(a.t - t) ? q : a)); showSG(sceneGraph(X, d, X.D.frames[d.fi], t), e); hero.highlight(new Set([d.ob]));
});
hero.r.domElement.addEventListener("pointerleave", () => { hideSG(); hero.highlight(null); });

// ---- scene graph card (hero hover + pipeline "Ledger")
const sgEl = $("sg");
function showSG(svg, e) { sgEl.innerHTML = svg; sgEl.classList.add("on"); sgEl.style.left = `${Math.min(e.clientX + 24, innerWidth - 340)}px`; sgEl.style.top = `${Math.min(Math.max(10, e.clientY - 165), innerHeight - 340)}px`; }
function hideSG() { sgEl.classList.remove("on"); }
function tileSvg(X, det, x, y, s, ring) {
  const [sx, sy] = tileXY(X, det.id), T = X.D.sprite.tile, id = `c${det.id}_${Math.round(x)}_${Math.round(y)}`;
  return `<clipPath id="${id}"><circle cx="${x}" cy="${y}" r="${s / 2}"/></clipPath><g clip-path="url(#${id})">
    <svg x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" viewBox="${sx} ${sy} ${T} ${T}"><image href="${X.A + X.D.sprite.file}" width="${X.D.sprite.cols * T}" height="${X.sprite.height}"/></svg></g>
    <circle cx="${x}" cy="${y}" r="${s / 2}" fill="none" stroke="${ring}" stroke-width="2.5"/>`;
}
function sceneGraph(X, hit, f, t) {
  const o = X.objById.get(hit.ob), C = 165, here = posAt(o, t) || (o.traj[0] || []).slice(1), inFrame = new Map();
  for (const d of f.dets) if (d.ob !== undefined && d.ob !== o.id && iou(d.box, hit.box) < 0.2 && (!inFrame.has(d.ob) || d.s > inFrame.get(d.ob).s)) inFrame.set(d.ob, d);
  const near = [...inFrame.entries()].map(([id, d]) => { const q = X.objById.get(id), p = posAt(q, t); return p && here.length ? [q, Math.hypot(p[0] - here[0], p[1] - here[1], p[2] - here[2]), d] : null; })
    .filter((z) => z && z[1] < 1.5).sort((a, b) => a[1] - b[1]).slice(0, 3);
  const ev = eventAt(X, t), aka = [...new Set(o.tags)].filter((n) => n !== o.name), sats = [];
  near.forEach(([q, d, det], i) => sats.push({ ang: -150 + i * 38, kind: "near", q, d, det }));
  sats.push({ ang: -30, kind: "time" }); if (o.segs.length) sats.push({ ang: 25, kind: "moves" }); if (aka.length) sats.push({ ang: 80, kind: "aka" }); if (ev) sats.push({ ang: 128, kind: "doing" });
  let svg = `<svg viewBox="0 0 330 330" xmlns="http://www.w3.org/2000/svg"><circle cx="${C}" cy="${C}" r="160" fill="#0d1014ee" stroke="#2a3038"/>`;
  for (const s of sats) {
    const a = (s.ang * Math.PI) / 180, x = C + 112 * Math.cos(a), y = C + 112 * Math.sin(a);
    svg += `<line x1="${C}" y1="${C}" x2="${x}" y2="${y}" stroke="#3a414c" stroke-dasharray="3 3"/>`;
    if (s.kind === "near") svg += tileSvg(X, s.det, x, y, 40, col(s.q.id)) + `<text x="${x}" y="${y + 33}" fill="#cfd3da" font-size="10" text-anchor="middle">${s.q.name} · ${s.d.toFixed(1)} m</text>`;
    if (s.kind === "time") svg += `<text x="${x}" y="${y}" fill="#9cc3f5" font-size="11" text-anchor="middle">seen ${o.n_obs}×</text><text x="${x}" y="${y + 13}" fill="#666d78" font-size="10" text-anchor="middle">${fmt(o.t[0])}–${fmt(o.t[1])}</text>`;
    if (s.kind === "moves") { const n = o.segs.length; svg += `<g transform="translate(${x - 34},${y - 10})">`;
      for (let i = 0; i < n; i++) svg += `<circle cx="${n > 1 ? (i * 68) / (n - 1) : 34}" cy="10" r="5" fill="${i ? "#e8703a" : "#9cc3f5"}"/>` + (i ? `<line x1="${((i - 1) * 68) / (n - 1) + 6}" y1="10" x2="${(i * 68) / (n - 1) - 6}" y2="10" stroke="#e8703a" stroke-width="2"/>` : "");
      svg += `</g><text x="${x}" y="${y + 18}" fill="#666d78" font-size="10" text-anchor="middle">${n > 1 ? `moved ${n - 1}×` : "stayed put"}</text>`; }
    if (s.kind === "aka") svg += `<text x="${x}" y="${y}" fill="#c2bbff" font-size="11" text-anchor="middle">aka</text><text x="${x}" y="${y + 13}" fill="#c2bbff" font-size="10" text-anchor="middle">${aka.slice(0, 2).join(", ")}</text>`;
    if (s.kind === "doing") { const w = ev.text.replace(/^The camera wearer is /, "").replace(/\.$/, "").split(" ");
      svg += `<text x="${x}" y="${y + 6}" fill="#87e0c0" font-size="10" text-anchor="middle">${w.slice(0, 4).join(" ")}</text><text x="${x}" y="${y + 19}" fill="#87e0c0" font-size="10" text-anchor="middle">${w.slice(4, 8).join(" ")}${w.length > 8 ? "…" : ""}</text>`; }
  }
  return svg + tileSvg(X, hit, C, C, 92, col(o.id)) + `<text x="${C}" y="${C + 64}" fill="#fff" font-size="15" font-weight="700" text-anchor="middle">${o.name}</text></svg>`;
}

// ================================================================== PIPELINE lens
const STAGES = [{ k: "look", n: "Look", c: "#ffffff" }, { k: "tag", n: "Tag", c: "#e0a21b" }, { k: "detect", n: "Detect", c: "#3987e5" },
  { k: "segment", n: "Segment", c: "#9085e9", masks: true }, { k: "lift", n: "Lift to 3D", c: "#22b58a" }, { k: "track", n: "Track", c: "#e8703a" }, { k: "ledger", n: "Ledger", c: "#f3f4f6" }];
let stage = Q.get("stage") || "detect", fi = 0, lensOn = Q.get("lens") !== "0", mouse = null;
const pills = $("pills"), viewer = $("viewer"), vbase = $("vbase"), vlens = $("vlens"), bctx = vbase.getContext("2d"), lctx = vlens.getContext("2d"), strip = $("strip");
const overlay = document.createElement("canvas"), octx = overlay.getContext("2d"); let frameImgs = [];
function buildPills() { pills.innerHTML = ""; if (stage === "segment" && !X.D.masks) stage = "detect";
  for (const s of STAGES) { if (s.masks && !X.D.masks) continue; const b = document.createElement("button"); b.className = "pill"; b.dataset.k = s.k;
    b.innerHTML = `<i style="background:${s.c}"></i>${s.n}`; b.onclick = () => { stage = s.k; draw(); }; pills.appendChild(b); } }
listeners.push((X) => {
  buildPills(); frameImgs = new Array(X.D.frames.length); rectImgs = new Array(X.D.frames.length); viewer.style.setProperty("--ar", `${X.D.res[0]}/${X.D.res[1]}`);
  fi = Q.get("frame") !== null && X.name === (Q.get("ds") || "hdepic") ? +Q.get("frame") : X.D.frames.reduce((b, f, i, F) => { const n = (g) => new Set(g.dets.filter((d) => d.ob !== undefined).map((d) => d.ob)).size; return n(f) > n(F[b]) ? i : b; }, 0);
  strip.innerHTML = ""; X.D.frames.forEach((f, i) => { const im = document.createElement("img"); im.loading = "lazy"; im.src = frameSrc(X, i); im.title = fmt(f.t); im.onclick = () => { fi = i; draw(); }; strip.appendChild(im); });
  sizeViewer();
});
function sizeViewer() { const k = Math.min(devicePixelRatio, 2), w = viewer.clientWidth * k, h = viewer.clientHeight * k; for (const c of [vbase, vlens]) { c.width = w; c.height = h; } draw(); }
new ResizeObserver(() => X && sizeViewer()).observe(viewer);
viewer.addEventListener("pointermove", (e) => { const r = viewer.getBoundingClientRect(); mouse = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; drawLens(); hoverPipe(e); });
viewer.addEventListener("pointerleave", () => { mouse = null; drawLens(); hideSG(); });
addEventListener("keydown", (e) => { const r = $("pipeline").getBoundingClientRect(); if (r.top > innerHeight || r.bottom < 0 || !X) return;
  if (e.key === " ") { lensOn = !lensOn; viewer.classList.toggle("free", !lensOn); e.preventDefault(); drawLens(); }
  if (e.key === "ArrowRight") { fi = Math.min(X.D.frames.length - 1, fi + 1); draw(); } if (e.key === "ArrowLeft") { fi = Math.max(0, fi - 1); draw(); } });
function chip(ctx, x, y, text, color, S) {
  ctx.font = `600 ${Math.round(S * 0.02)}px Inter, -apple-system, sans-serif`; const w = ctx.measureText(text).width + S * 0.018, h = S * 0.031;
  ctx.fillStyle = "rgba(10,12,15,.78)"; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, S * 0.0016);
  ctx.beginPath(); ctx.roundRect(x, y - h, w, h, h / 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#fff"; ctx.fillText(text, x + S * 0.009, y - h * 0.3); return w;
}
function poly(ctx, p, W, H) { ctx.beginPath(); for (let i = 0; i < p.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, p[i] * W, p[i + 1] * H); ctx.closePath(); }
const BOX_EDGES = [[0, 1], [1, 5], [5, 4], [4, 0], [2, 3], [3, 7], [7, 6], [6, 2], [0, 2], [1, 3], [4, 6], [5, 7]];
let rectImgs = [];
function renderOverlay(f, W, H) {
  overlay.width = W; overlay.height = H; const c = octx, S = Math.max(W, H); c.clearRect(0, 0, W, H); if (stage === "look") return;
  if (stage === "lift" && X.D.lift_view === "rect") {             // HD-EPIC lifts in the undistorted (rectified) view: show that view
    const im = rectImgs[fi]; if (im) c.drawImage(im, 0, 0, W, H);
  }
  if (stage === "tag") {
    c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(0, 0, W, H); const placed = new Set(); let y = H * 0.08, x = W * 0.03;
    for (const tg of f.tags) { const d = f.dets.filter((q) => q.tag === tg).sort((a, b) => b.s - a.s)[0]; if (d) { chip(c, d.box[0] * W, d.box[1] * H, tg, "#e0a21b", S); placed.add(tg); } }
    for (const tg of f.tags) if (!placed.has(tg)) { c.font = `600 ${Math.round(S * 0.02)}px Inter, sans-serif`; const w = c.measureText(tg).width + S * 0.03; if (x + w > W * 0.97) { x = W * 0.03; y += S * 0.042; } x += chip(c, x, y, tg, "rgba(224,162,27,.6)", S) + S * 0.008; }
    return;
  }
  for (const d of f.dets) {
    const x0 = d.box[0] * W, y0 = d.box[1] * H, x1 = d.box[2] * W, y1 = d.box[3] * H;
    if (stage === "detect") { c.strokeStyle = d.s > 0.25 ? "#3987e5" : "rgba(57,135,229,.45)"; c.lineWidth = S * 0.0028; c.strokeRect(x0, y0, x1 - x0, y1 - y0); if (d.s > 0.25) chip(c, x0, y0, `${d.tag} ${d.s.toFixed(2)}`, "#3987e5", S); }
    else if (stage === "segment") { if (!d.poly.length) continue; poly(c, d.poly, W, H); c.fillStyle = `hsla(${(d.tag.length * 47) % 360},70%,60%,.42)`; c.fill(); c.strokeStyle = "#fff"; c.lineWidth = S * 0.0015; c.stroke(); }
    else if (stage === "lift") {
      if (!d.cam) { if (X.D.lift_view !== "rect") { c.strokeStyle = "rgba(255,255,255,.16)"; c.lineWidth = S * 0.002; c.strokeRect(x0, y0, x1 - x0, y1 - y0); } continue; }
      if (d.b3) {                                                  // the lifted 3D box, projected into the image the lift used
        const P = d.b3.map(([u, v]) => [u * W, v * H]), colr = d.ob !== undefined ? col(d.ob, 1, 64) : "#22b58a";
        c.lineWidth = S * 0.0024; c.strokeStyle = colr; c.globalAlpha = 0.95;
        for (const [i, j] of BOX_EDGES) { c.beginPath(); c.moveTo(...P[i]); c.lineTo(...P[j]); c.stroke(); }
        c.globalAlpha = 0.16; c.fillStyle = colr; c.beginPath(); for (const k of [0, 1, 5, 4]) c.lineTo(...P[k]); c.closePath(); c.fill(); c.globalAlpha = 1;
        const cx = P.reduce((a, p) => a + p[0], 0) / 8, cy = P.reduce((a, p) => a + p[1], 0) / 8;
        c.fillStyle = "#fff"; c.beginPath(); c.arc(cx, cy, S * 0.004, 0, 7); c.fill();
        chip(c, cx + S * 0.008, cy - S * 0.006, `${Math.hypot(...d.cam).toFixed(1)} m`, colr, S); continue;
      }
      if (X.D.lift_view === "rect") continue;
      const z = Math.hypot(...d.cam), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = (S * 0.03) / Math.max(0.4, z);
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2); g.addColorStop(0, "rgba(34,181,138,.9)"); g.addColorStop(1, "rgba(34,181,138,0)");
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, r * 2.2, 0, 7); c.fill(); c.fillStyle = "#fff"; c.beginPath(); c.arc(cx, cy, S * 0.004, 0, 7); c.fill();
      chip(c, cx + S * 0.01, cy - S * 0.008, `${z.toFixed(1)} m`, "#22b58a", S);
    } else if (d.ob !== undefined) {
      const a = stage === "ledger" ? 0.16 : 0.32;
      if (X.D.masks && d.poly.length) { poly(c, d.poly, W, H); c.fillStyle = col(d.ob, a); c.fill(); c.strokeStyle = col(d.ob); c.lineWidth = S * 0.0022; c.stroke(); }
      else { c.fillStyle = col(d.ob, a); c.fillRect(x0, y0, x1 - x0, y1 - y0); c.strokeStyle = col(d.ob); c.lineWidth = S * 0.0026; c.strokeRect(x0, y0, x1 - x0, y1 - y0); }
      if (stage === "track") chip(c, x0, y0, `#${d.ob} ${X.objById.get(d.ob).name}`, col(d.ob), S);
    }
  }
}
function drawLens() {
  const W = vlens.width, H = vlens.height; lctx.clearRect(0, 0, W, H); if (stage === "look") return;
  if (!lensOn || !mouse) { if (!lensOn || matchMedia("(hover:none)").matches) lctx.drawImage(overlay, 0, 0); else { lctx.globalAlpha = 0.18; lctx.drawImage(overlay, 0, 0); lctx.globalAlpha = 1; } return; }
  const mx = mouse[0] * W, my = mouse[1] * H, r = Math.max(W, H) * 0.2;
  lctx.save(); lctx.beginPath(); lctx.arc(mx, my, r, 0, 7); lctx.clip(); lctx.drawImage(overlay, 0, 0); lctx.restore();
  lctx.strokeStyle = "rgba(255,255,255,.9)"; lctx.lineWidth = Math.max(W, H) * 0.003; lctx.beginPath(); lctx.arc(mx, my, r, 0, 7); lctx.stroke();
}
const SIDE = {
  look: () => [`one frame every 4 s`, `<div class="big3">${X.D.frames.length}</div><div class="mini">frames from ${fmt(X.D.duration)} of video</div>`],
  tag: (f) => [`open-vocabulary tags · Qwen3.5-9B`, `<div class="tagcloud">${f.tags.map((t) => `<span>${t}</span>`).join("")}</div>`],
  detect: (f) => [`boxes · ${X.D.masks ? "SAM3" : "YOLO-World"}`, `<div class="big3">${f.dets.length}</div><div class="mini">boxes in this frame</div>`],
  segment: (f) => [`masks · SAM3`, `<div class="big3">${f.dets.filter((d) => d.poly.length).length}</div><div class="mini">object masks</div>`],
  lift: (f) => [`metric 3D boxes · WildDet3D`, `<div class="big3">${f.dets.filter((d) => d.cam).length}</div><div class="mini">2D boxes lifted to 3D boxes, labelled with the distance to their centre${X.D.lift_view === "rect" ? " · shown in the undistorted view the lift uses" : ""}</div>`],
  track: (f) => [`one identity per object`, `<div class="big3">${new Set(f.dets.filter((d) => d.ob !== undefined).map((d) => d.ob)).size}</div><div class="mini">objects · same colour = same object in every frame</div>`],
  ledger: () => [`the memory`, `<div class="mini" style="font-size:14px;color:#cfd3da">hover any object</div>`],
};
async function draw() {
  if (!X) return; const f = X.D.frames[fi]; [...pills.children].forEach((b) => b.classList.toggle("on", b.dataset.k === stage));
  [...strip.children].forEach((c, i) => c.classList.toggle("on", i === fi)); { const c = strip.children[fi]; if (c) strip.scrollLeft = c.offsetLeft - strip.clientWidth / 2 + c.clientWidth / 2; }
  $("vlabel").textContent = `${fmt(f.t)} · frame ${fi + 1} of ${X.D.frames.length}`;
  const [t1, b1] = SIDE[stage](f); $("sideTitle").textContent = t1; $("sideBody").innerHTML = b1;
  const nl = f.dets.filter((d) => d.cam).length, no = new Set(f.dets.filter((d) => d.ob !== undefined).map((d) => d.ob)).size;
  $("frameStats").innerHTML = [[f.dets.length, "boxes"], [nl, "in 3D"], [no, "objects"]].map(([a, b]) => `<div><div class="big3" style="font-size:28px">${a}</div><div class="mini">${b}</div></div>`).join("");
  const i0 = fi, X0 = X, im = frameImgs[fi] || (frameImgs[fi] = await loadImg(frameSrc(X, fi))); if (i0 !== fi || X0 !== X || !im) return;
  if (stage === "lift" && X.D.lift_view === "rect" && !rectImgs[fi]) { rectImgs[fi] = await loadImg(`${X.A}rect/${String(fi).padStart(2, "0")}.jpg`); if (i0 !== fi || X0 !== X) return; }
  const W = vbase.width, H = vbase.height; if (!W) return; bctx.drawImage(im, 0, 0, W, H); renderOverlay(f, W, H); drawLens();
}
function hoverPipe(e) {
  if (!(stage === "ledger" || stage === "track") || !mouse || !X) { hideSG(); return; }
  const f = X.D.frames[fi], hit = pick(f, mouse[0], mouse[1]); if (!hit) { hideSG(); return; } showSG(sceneGraph(X, hit, f, f.t), e);
}

// ================================================================== COLLAPSE (re-identification)
const cv = $("collapse"), cx2 = cv.getContext("2d"), stepsEl = $("steps"), mg = $("merges");
let tiles = [], cstep = 0, hoverPile = null, piles = [], lastW = 0, autoStep = null;
listeners.push((X) => {
  const F = X.D.funnel; $("csub").innerHTML = `${F.detections.toLocaleString()} sightings → <b>${F.objects} objects</b> · drag the steps or hover a pile`;
  tiles = X.D.frames.flatMap((f) => f.dets.map((d) => ({ d: { ...d, t: f.t }, x: 0, y: 0, s: 0, a: 1, tx: 0, ty: 0, ts: 0, ta: 1 })));
  stepsEl.innerHTML = ""; [[F.detections, "boxes"], [F.lifted, "in 3D"], [F.clusters, "3D clusters"], [F.objects, "objects"]].forEach(([n, l], i) => {
    const b = document.createElement("button"); b.innerHTML = `<b>${n.toLocaleString()}</b>${l}`; b.onclick = () => setStep(i); stepsEl.appendChild(b); });
  mg.innerHTML = "";
  for (const o of X.D.objects.filter((o) => new Set(o.tags).size > 1)) {
    const el = document.createElement("div"); el.className = "merge";
    for (const d of (X.detsByOb.get(o.id) || []).slice(0, 3)) { const c = document.createElement("canvas"); c.width = c.height = 48; const [sx, sy] = tileXY(X, d.id); c.getContext("2d").drawImage(X.sprite, sx, sy, 48, 48, 0, 0, 48, 48); el.appendChild(c); }
    el.insertAdjacentHTML("beforeend", `<span>${[...new Set(o.tags)].join(" + ")} → <b style="color:#fff">one object</b></span>`);
    el.onclick = () => { setStep(3); setTimeout(() => (hoverPile = piles.find((p) => p.ob === o.id) || null), 900); }; mg.appendChild(el);
  }
  hoverPile = null; lastW = 0; setStep(+(Q.get("cstep") || 0)); sizeC(); if (Q.get("pile")) setTimeout(() => (hoverPile = piles.find((p) => p.ob === +Q.get("pile")) || null), 1200);
});
function layout() {
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !tiles.length) return;
  if (cstep <= 1) { const s = Math.max(6, Math.floor(Math.sqrt(((W - 20) * (H - 20)) / tiles.length))), cols = Math.floor((W - 20) / s);
    tiles.forEach((t, i) => { t.tx = 10 + (i % cols) * s; t.ty = 10 + Math.floor(i / cols) * s; t.ts = s - 1; t.ta = cstep === 1 && !t.d.world ? 0.08 : 1; }); piles = []; return; }
  const key = cstep === 2 ? (d) => (d.cl !== undefined ? "c" + d.cl : null) : (d) => (d.ob !== undefined ? "o" + d.ob : null), groups = new Map();
  for (const t of tiles) { const k = key(t.d); if (k === null) { t.ta = 0; continue; } if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const gs = [...groups.entries()].sort((a, b) => b[1].length - a[1].length), cell = Math.floor(Math.sqrt(((W - 20) * (H - 20)) / gs.length)), cols = Math.max(1, Math.floor((W - 20) / cell));
  piles = gs.map(([k, ts], i) => { const px = 10 + (i % cols) * cell + cell / 2, py = 10 + Math.floor(i / cols) * cell + cell / 2, s = Math.min(cell * 0.62, 90);
    ts.forEach((t, j) => { const o = Math.min(j, 6) * 2; t.tx = px - s / 2 + o; t.ty = py - s / 2 - o; t.ts = s; t.ta = 1; });
    const names = [...new Set(ts.map((t) => t.d.tag))]; return { ts, px, py, s, ob: ts[0].d.ob, names, merged: cstep === 3 && names.length > 1 }; });
}
function setStep(i) { cstep = i; [...stepsEl.children].forEach((b, j) => b.classList.toggle("on", j === i)); layout(); }
function sizeC() { const dpr = Math.min(devicePixelRatio, 2); cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; cx2.setTransform(dpr, 0, 0, dpr, 0, 0); layout();
  const snap = Math.abs(cv.clientWidth - lastW) > 40; lastW = cv.clientWidth; tiles.forEach((t) => { if (snap || !t.s) Object.assign(t, { x: t.tx, y: t.ty, s: t.ts, a: t.ta }); }); }
new ResizeObserver(() => tiles.length && sizeC()).observe(cv);
cv.addEventListener("pointermove", (e) => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; hoverPile = piles.find((p) => Math.abs(p.px - x) < p.s * 0.7 && Math.abs(p.py - y) < p.s * 0.7) || null; });
cv.addEventListener("pointerleave", () => (hoverPile = null));
new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && cstep === 0 && !Q.get("cstep") && !autoStep) { let i = 0; autoStep = setInterval(() => { if (++i > 3) { clearInterval(autoStep); autoStep = null; return; } setStep(i); }, 2200); } }), { threshold: 0.5 }).observe(cv);
function frameC() {
  const W = cv.clientWidth, H = cv.clientHeight, T = X.D.sprite.tile; cx2.clearRect(0, 0, W, H);
  for (const t of tiles) { t.x += (t.tx - t.x) * 0.12; t.y += (t.ty - t.y) * 0.12; t.s += (t.ts - t.s) * 0.12; t.a += (t.ta - t.a) * 0.12; }
  for (const t of tiles) { if (t.a < 0.02) continue; const [sx, sy] = tileXY(X, t.d.id); cx2.globalAlpha = t.a; cx2.drawImage(X.sprite, sx, sy, T, T, t.x, t.y, t.s, t.s); }
  cx2.globalAlpha = 1;
  for (const p of piles) if (p.merged) { cx2.strokeStyle = "#e8703a"; cx2.lineWidth = 2; cx2.beginPath(); cx2.roundRect(p.px - p.s * 0.62, p.py - p.s * 0.66, p.s * 1.26, p.s * 1.26, 8); cx2.stroke(); }
  if (hoverPile) {
    const p = hoverPile, n = Math.min(p.ts.length, 24), R0 = Math.max(70, p.s * 1.2), s = 46; cx2.fillStyle = "rgba(6,7,8,.72)"; cx2.fillRect(0, 0, W, H);
    const cxp = Math.min(Math.max(p.px, R0 + s), W - R0 - s), cyp = Math.min(Math.max(p.py, R0 + s), H - R0 - s - 20);
    p.ts.slice(0, n).forEach((t, j) => { const a = -Math.PI / 2 + (2 * Math.PI * j) / n, x = cxp + R0 * Math.cos(a) - s / 2, y = cyp + R0 * Math.sin(a) - s / 2;
      const [sx, sy] = tileXY(X, t.d.id); cx2.drawImage(X.sprite, sx, sy, T, T, x, y, s, s); cx2.strokeStyle = col(p.ob ?? 0); cx2.lineWidth = 2; cx2.strokeRect(x, y, s, s); });
    cx2.fillStyle = "#fff"; cx2.font = "700 15px Inter, -apple-system, sans-serif"; cx2.textAlign = "center"; cx2.fillText(p.names.join(" + "), cxp, cyp - 4);
    cx2.fillStyle = "#a4aab4"; cx2.font = "12px Inter, sans-serif"; cx2.fillText(`${p.ts.length} sightings · ${fmt(Math.min(...p.ts.map((t) => t.d.t)))}–${fmt(Math.max(...p.ts.map((t) => t.d.t)))}`, cxp, cyp + 14); cx2.textAlign = "left";
  }
}

// ================================================================== ASK: rolling questions, the agent's search replayed in 3D
const ask3d = new World($("askview")), feed = $("feed"), cap = $("cap3d"), qdots = $("qdots");
let askGen = 0, askIdx = 0, askT = 0;
const STOPPED = new Error("superseded");
function sleep(ms, g) {                                            // waits only while the section is on screen
  return new Promise((res, rej) => { let left = ms, last = performance.now();
    const tick = () => { if (g !== askGen) return rej(STOPPED); const now = performance.now(); if (ask3d.visible) left -= now - last; last = now; left <= 0 ? res() : setTimeout(tick, 60); }; tick(); });
}
function capSet(icon, html) { cap.innerHTML = `<span class="ic k-${icon}">${ICON[icon]}</span><span class="ct">${html}</span>`; cap.classList.add("on"); return cap.querySelector(".ct"); }
function typeInto(els, text, g) {
  return new Promise((res) => { let i = 0; const step = () => { if (g !== askGen) return res(); i = Math.min(text.length, i + 3); for (const e of els) e.textContent = text.slice(0, i); i < text.length ? setTimeout(step, 30) : res(); }; step(); });
}
function popIn(A, o, delay = 0) {
  o.userData.k = 0.001; if (!o.isSprite) o.scale.setScalar(0.001);
  A.tween(520, (k) => { const e = Math.max(0.001, easeBack(k)); o.userData.k = e; if (!o.isSprite) o.scale.setScalar(e); }, delay);
}
function link(A, a, b, color, delay = 0) {                         // an arc from a retrieved moment to an object it names, drawn as it grows
  const mid = a.clone().lerp(b, 0.5).addScaledVector(UPV, a.distanceTo(b) * 0.3), pts = new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(32);
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, fog: false }));
  l.geometry.setDrawRange(0, 0); A.extra.add(l); A.tween(650, (k) => l.geometry.setDrawRange(0, Math.ceil(33 * k)), delay); return l;
}
function sweep(A, i0, i1) {                                        // a light running along the recorded path: the memory being scanned
  const P = A.camPts, seg = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P), new THREE.LineBasicMaterial({ color: 0x9cc3f5, fog: false }));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(A.rad * 0.008, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })); A.extra.add(seg, dot);
  const L = Math.max(4, Math.round((i1 - i0) * 0.12));
  A.tween(1250, (k) => { const i = Math.round(i0 + k * (i1 - i0)); seg.geometry.setDrawRange(Math.max(i0, i - L), Math.min(L, i - i0) + 1); dot.position.copy(P[i]); if (k >= 1) A.extra.remove(seg, dot); });
}
function ring(A, p) {                                              // a ripple opening at a queried place
  const m = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ color: 0x9cc3f5, transparent: true, side: THREE.DoubleSide, fog: false }));
  m.rotation.x = -Math.PI / 2; m.position.copy(p); A.extra.add(m);
  A.tween(1250, (k) => { m.scale.setScalar(0.01 + A.rad * 0.3 * k); m.material.opacity = 1 - k * 0.7; });
}
const hms = (s) => { const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
const named = (o, text) => [o.name, ...o.tags].some((n) => n.length > 2 && new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(text));
const keysOf = (X, T, ids) => { const said = `${T.question} ${T.options ? T.options[T.answer_idx] : ""}`.toLowerCase();
  return new Set([...ids].filter((id) => { const o = X.objById.get(id); return o && named(o, said); })); };
async function qTexture(X, T) {                                    // the frame the question was asked on, with the item it points at
  const im = await loadImg(T.qframe ? X.A + T.qframe : frameSrc(X, nearestFrame(X, T.t))); if (!im) return null;
  const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; const g = c.getContext("2d"); g.drawImage(im, 0, 0);
  if (T.box) { const [a, b, d, e] = T.box; g.strokeStyle = "#e0a21b"; g.lineWidth = Math.max(4, im.width * 0.008); g.shadowColor = "#e0a21b"; g.shadowBlur = 18; g.strokeRect(a * c.width, b * c.height, (d - a) * c.width, (e - b) * c.height); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function dim(objs) { for (const o of objs) o.traverse((c) => { if (c.material) { c.material.transparent = true; c.material.opacity = Math.min(c.material.opacity, 0.22); } }); }

async function playSearch(X, T, s, add, g, prev) {
  const A = ask3d, q = Array.isArray(s.query) ? `(${s.query.map((v) => v.toFixed(1)).join(", ")})` : s.query;
  const verb = { text: "searches the memory for", time: "looks up the moment", position: "looks around the place" }[s.tool] || "searches for";
  const row = add("s", `<div class="row"><span class="ic">${ICON[s.tool] || ICON.text}</span><span>${verb} <b>${esc(q)}</b></span></div><div class="moments"></div>`);
  capSet(s.tool in ICON ? s.tool : "text", `${verb} <b>${esc(q)}</b>`); dim(prev); A.highlight(null);
  const N = A.camPts.length - 1, ts = X.D.camera.map((c) => c[0]);
  if (s.tool === "position" && Array.isArray(s.query)) { A.fit([X.W2T(s.query)], 3.2); ring(A, X.W2T(s.query)); }
  else if (s.tool === "time" && hms(s.query) !== null) { const t0 = hms(s.query), i0 = ts.findIndex((t) => t >= t0 - 8), i1 = ts.findIndex((t) => t > t0 + 8);
    const a = Math.max(0, i0), b = i1 < 0 ? N : Math.max(a + 1, i1); A.fit(A.camPts.slice(a, b + 1), 2.6); sweep(A, a, b); }
  else { A.overview(); sweep(A, 0, N); }
  await sleep(1400, g);
  const hits = s.hits.slice(0, 5), pts = [], ids = new Set(), box = row.querySelector(".moments");
  hits.forEach((h, k) => {
    const src = frameSrc(X, nearestFrame(X, h.t)), fr = frustum(X, camLerp(X, h.t), A.rad * 0.06, 0x3987e5, tex(src), 1), dl = k * 260;
    A.extra.add(fr); popIn(A, fr, dl); prev.push(fr); pts.push(fr.userData.centre, fr.userData.C);
    const lab = textSprite(`${k + 1} · ${fmt(h.t)}`, "#cfe3fb", 26); lab.position.copy(fr.userData.C).addScaledVector(UPV, A.rad * 0.045); lab.userData.h = 0.034; A.extra.add(lab); popIn(A, lab, dl); prev.push(lab);
    for (const id of h.obs) { const p = A.objPos(id, askT); if (!p) continue; ids.add(id); pts.push(p); prev.push(link(A, fr.userData.centre, p, col3(id), dl + 380)); }
    box.insertAdjacentHTML("beforeend", `<div class="moment" style="animation-delay:${dl / 1000}s"><img src="${src}"><div><b>${fmt(h.t)}</b> · ${h.obs.length} objects</div></div>`);
  });
  A.highlight(ids.size ? ids : null, keysOf(X, T, ids)); if (pts.length) A.fit(pts, 1.7);
  await sleep(900, g); capSet(s.tool in ICON ? s.tool : "text", `${hits.length} moments come back${ids.size ? ` · naming ${ids.size} objects in the memory` : ""}`);
  await sleep(2600, g);
}
async function playThink(X, T, s, add, g) {
  const A = ask3d, row = add("t", `<div class="row"><span class="ic k-think">${ICON.think}</span><span class="tt"></span></div>`), el = row.querySelector(".tt");
  const said = s.text.toLowerCase(), ids = new Set(X.D.objects.filter((o) => A.byId.get(o.id)?.visible && named(o, said)).map((o) => o.id));
  if (ids.size) { A.highlight(new Set([...(A.hl || []), ...ids]), ids); A.fit([...ids].map((id) => A.objPos(id, askT)).filter(Boolean), 2.6); }
  await typeInto([el, capSet("think", "")], s.text, g); await sleep(1700, g);
}
async function playAnswer(X, T, add, g, qEl) {
  const A = ask3d;
  if (T.preds) {
    add("ans", `<div class="row"><span class="ic k-answer">${ICON.answer}</span><span>${esc(T.answer.text)}</span></div><div class="verdict">${Object.entries(T.err_m).map(([n, e]) =>
      `<span class="vb ${n === "LEDGER" ? "us" : ""}">${n} ${e == null ? "–" : e.toFixed(2) + " m"}</span>`).join("")}</div><div class="mini" style="margin-top:4px">distance from the true position</div>`);
    capSet("answer", `answer: <b>(${T.answer.position.map((v) => v.toFixed(1)).join(", ")})</b> · ${T.err_m.LEDGER.toFixed(2)} m from the truth`);
    A.highlight(new Set([T.answer_ob ?? -1]), new Set([T.answer_ob])); A.marker(T.gt, 0xe0a21b, "★ truth", 2.2);
    const C = { LEDGER: 0x3987e5, ReMEmbR: 0xe8703a, OSNOM: 0x9085e9, DirectMe: 0xe66767, "no memory": 0x8a8984 }, pts = [X.W2T(T.gt)];
    for (const [n, p] of Object.entries(T.preds)) if (p) { A.marker(p, C[n] ?? 0xffffff, `${n} ${T.err_m[n].toFixed(2)} m`, n === "LEDGER" ? 1.5 : 0.8); A.line(p, T.gt, C[n] ?? 0xffffff); pts.push(X.W2T(p)); }
    A.fit(pts, 1.5);
  } else {
    const k = T.answer_idx, base = Object.entries(T.baselines || {}).filter(([, v]) => v !== null);
    add("ans", `<div class="row"><span class="ic k-answer">${ICON.answer}</span><span><b>${"ABCDE"[k]}.</b> ${esc(T.options[k])}</span><span class="cons">right in ${T.consistency} runs</span></div>
      <div class="verdict"><span class="vb us">LEDGER ✓</span>${base.map(([n, v]) => `<span class="vb ${v ? "ok" : "no"}">${n} ${v ? "✓" : "✗"}</span>`).join("")}</div>`);
    qEl.querySelectorAll(".opt")[k]?.classList.add("right"); capSet("answer", `answer: <b>${"ABCDE"[k]}. ${esc(T.options[k])}</b>`);
    const keys = keysOf(X, T, new Set(A.hl || [])); if (keys.size) { A.highlight(A.hl, keys); A.fit([...keys].map((id) => A.objPos(id, askT)).filter(Boolean), 2.8); }
  }
}
async function playTask(X, T, g) {
  const A = ask3d; A.clearExtra(); A.highlight(null); askT = T.t ?? X.D.duration;
  [...qdots.children].forEach((b, j) => b.classList.toggle("on", j === askIdx));
  const th = document.createElement("div"); th.className = "thread"; feed.appendChild(th); while (feed.children.length > 4) feed.firstChild.remove();
  const add = (cls, html) => { const d = document.createElement("div"); d.className = `msg ${cls}`; d.innerHTML = html; th.appendChild(d);
    setTimeout(() => d.classList.add("in"), 30); feed.scrollTop = feed.scrollHeight; return d; };
  const qEl = add("q", `<div class="who">${T.t !== undefined ? `asked at ${fmt(T.t)}` : "asked after the video"}</div><div class="qt">${esc(T.question)}</div>` +
    (T.options ? `<div class="opts">${T.options.map((o, i) => `<div class="opt">${"ABCDE"[i]}. ${esc(o)}</div>`).join("")}</div>` : ""));
  if (T.t !== undefined) {                                          // where and when the question was asked
    const c = camLerp(X, T.t), d = A.rad * 0.09, fr = frustum(X, c, d, 0xe0a21b, null, 1), b = basis(X, c); A.extra.add(fr); popIn(A, fr);
    qTexture(X, T).then((t) => { if (t && g === askGen) { const pl = fr.userData.plane; pl.material.map = t; pl.material.needsUpdate = true; pl.visible = true; } });
    A.fly(fr.userData.centre, b.C.clone().addScaledVector(b.F, -d * 3.4).addScaledVector(UPV, d * 1.3)); capSet("pin", `asked here, at ${fmt(T.t)}${T.box ? " · about the highlighted item" : ""}`);
  } else { A.overview(); capSet("pin", "asked after the whole video"); }
  await sleep(2600, g);
  const prev = [];
  for (const s of T.steps) await (s.kind === "search" ? playSearch(X, T, s, add, g, prev) : playThink(X, T, s, add, g));
  await playAnswer(X, T, add, g, qEl); await sleep(T.preds ? 5600 : 4400, g);
}
async function rollAsk(X, g) {
  const L = X.task?.tasks || []; if (!L.length) return;
  try { for (;;) { await playTask(X, L[askIdx], g); askIdx = (askIdx + 1) % L.length; } } catch (e) { if (e !== STOPPED) console.error(e); }
}
function jump(X, j) { askIdx = j; rollAsk(X, ++askGen); }
listeners.push((X) => {
  ask3d.set(X); feed.innerHTML = ""; cap.classList.remove("on"); const L = X.task?.tasks || [];
  $("askWho").textContent = `${X.task?.answerer || ""} · ${L.length} question${L.length === 1 ? "" : "s"}`;
  qdots.innerHTML = ""; L.forEach((T, j) => { const b = document.createElement("button"); b.textContent = j + 1; b.title = T.question; b.onclick = () => jump(X, j); qdots.appendChild(b); });
  jump(X, +(Q.get("q") || 0) % Math.max(1, L.length));
});

// ================================================================== CHARTS
function barChart(id, rows, unit) {
  const el = $(id), svg = el.querySelector("svg"), tip = el.querySelector(".tip"), W = 360, rh = 34, H = rows.length * rh + 10, mx = Math.max(...rows.map((r) => r[1])) * 1.12;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = rows.map(([n, v, ours], i) => `<g data-i="${i}"><text x="0" y="${i * rh + 21}" fill="${ours ? "#fff" : "#a4aab4"}" font-size="12" font-weight="${ours ? 700 : 400}">${n}</text>
      <rect x="108" y="${i * rh + 8}" width="${((W - 150) * v) / mx}" height="18" rx="4" fill="${ours ? "#3987e5" : "#3a414c"}"/>
      <text x="${114 + ((W - 150) * v) / mx}" y="${i * rh + 21}" fill="${ours ? "#9cc3f5" : "#666d78"}" font-size="12">${v}${unit}</text></g>`).join("");
  svg.querySelectorAll("g").forEach((g) => { g.onmouseenter = () => { const [n, v] = rows[+g.dataset.i]; tip.textContent = `${n}: ${v}${unit}`; tip.style.opacity = 1; };
    g.onmousemove = (e) => { const r = el.getBoundingClientRect(); tip.style.left = `${e.clientX - r.left + 12}px`; tip.style.top = `${e.clientY - r.top - 30}px`; }; g.onmouseleave = () => (tip.style.opacity = 0); });
}
function charts(R) {
barChart("c1", R.hdepic, "%"); barChart("c2", R.vq3d, " m");
(function lineChart() {
  const el = $("c3"), svg = el.querySelector("svg"), tip = el.querySelector(".tip"), W = 360, H = 230, L = 34, B = 196, T = 14, bins = R.length.bins, series = R.length.series;
  const ys = series.flatMap((s) => s.v), lo = Math.floor(Math.min(...ys) / 5) * 5, hi = Math.ceil(Math.max(...ys) / 5) * 5;
  const Xf = (i) => L + (i * (W - L - 16)) / (bins.length - 1), Y = (v) => B - ((v - lo) / (hi - lo)) * (B - T); svg.setAttribute("viewBox", `0 0 ${W} ${H}`); let s = "";
  for (let v = lo; v <= hi; v += 5) s += `<line x1="${L}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}" stroke="#1d2229"/><text x="${L - 6}" y="${Y(v) + 4}" fill="#666d78" font-size="10" text-anchor="end">${v}</text>`;
  bins.forEach((b, i) => (s += `<text x="${Xf(i)}" y="${B + 16}" fill="#666d78" font-size="10" text-anchor="middle">${b}</text>`));
  for (const se of series) { s += `<polyline points="${se.v.map((v, i) => `${Xf(i)},${Y(v)}`).join(" ")}" fill="none" stroke="${se.c}" stroke-width="2.4" ${se.dash ? 'stroke-dasharray="5 4"' : ""}/>`;
    s += se.v.map((v, i) => `<circle cx="${Xf(i)}" cy="${Y(v)}" r="3.5" fill="${se.c}" stroke="#111419" stroke-width="2"/>`).join("");
    s += `<text x="${Xf(bins.length - 1) - 2}" y="${Y(se.v[se.v.length - 1]) - 8}" fill="${se.c}" font-size="11" text-anchor="end">${se.n}</text>`; }
  s += `<line id="xh" y1="${T}" y2="${B}" stroke="#ffffff55" opacity="0"/><rect x="${L}" y="${T}" width="${W - L - 10}" height="${B - T}" fill="transparent" id="hit"/>`; svg.innerHTML = s;
  const hit = svg.querySelector("#hit"), xh = svg.querySelector("#xh");
  hit.onmousemove = (e) => { const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, i = Math.max(0, Math.min(bins.length - 1, Math.round(((x - L) / (W - L - 16)) * (bins.length - 1))));
    xh.setAttribute("x1", Xf(i)); xh.setAttribute("x2", Xf(i)); xh.setAttribute("opacity", 1); tip.innerHTML = `<b>${bins[i]}</b><br>` + series.map((se) => `<span style="color:${se.c}">●</span> ${se.n} ${se.v[i].toFixed(1)}%`).join("<br>");
    const er = el.getBoundingClientRect(); tip.style.left = `${Math.min(e.clientX - er.left + 14, er.width - 170)}px`; tip.style.top = `${e.clientY - er.top - 40}px`; tip.style.opacity = 1; };
  hit.onmouseleave = () => { tip.style.opacity = 0; xh.setAttribute("opacity", 0); };
})();
}

// ================================================================== main loop + start
let lastCount = -1, lastEv = null;
function loop() {
  if (X) {
    const t = tNow();
    if (hero.visible) { const n = heroUpdate(X, t); hero.render(); if (n !== lastCount) { $("count").textContent = `${n} objects in memory`; lastCount = n; } }
    fill.style.width = knob.style.left = `${(100 * t) / X.D.duration}%`; $("time").textContent = `${fmt(t)} / ${fmt(X.D.duration)}`;
    const ev = eventAt(X, t); if (ev !== lastEv) { $("ticker").textContent = ev ? ev.text : ""; lastEv = ev; }
    if (ask3d.visible) { ask3d.update(askT); ask3d.render(); }
    frameC();
  }
  requestAnimationFrame(loop);
}
await select(Q.get("ds") || "hdepic"); loop();
if (Q.get("only")) for (const el of document.querySelectorAll("section, .switch")) el.style.display = el.id === Q.get("only") ? "" : "none";   // (tests) one section
resultsP.then((R) => { try { if (R) charts(R); } catch (e) { console.error(e); } });
