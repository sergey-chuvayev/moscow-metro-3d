import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ---------------------------------------------------------------------------
// Constants, i18n
// ---------------------------------------------------------------------------

const LAT0 = 55.7539, LNG0 = 37.6208; // Red Square = scene origin. 1 scene unit = 1 km.
const TUBE_R = 0.085;
const LIFT = 0.09; // surface lines ride just above the map plane
const MOBILE = matchMedia('(max-width: 760px)').matches;

const LINE_NUM = { 97: '11', 95: '14', 98: '15', 133: '8A', 137: '16', 171: '' };
const DEPTH_STOPS = [[0, '#7ef9ff'], [20, '#4f8cff'], [40, '#7b5cff'], [60, '#d24dff'], [85, '#ff4d8d']];

function ruPlural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const I18N = {
  en: {
    title: 'Moscow Metro, underground', vOverview: 'Overview', vSide: 'Cross-section', vTop: 'Top', vBelow: 'From below',
    exag: 'Depth exaggeration', ground: 'Ground', colorDepth: 'Color by depth', shafts: 'Shafts to surface',
    transfers: 'Transfers', rotate: 'Auto-rotate', lines: 'Lines', showAll: 'show all', deepest: 'Deepest stations',
    sources: 'Data: Wikidata, ru.wikipedia, hh.ru. Map © OpenStreetMap, © Stadia Maps / Esri',
    hint: 'Drag to orbit · right-drag to pan · scroll to zoom · click a line or station',
    subtitle: (s, l) => `${s} stations on ${l} lines, depth below street level`,
    stations: (n) => (n === 1 ? 'station' : 'stations'), max: 'max', avg: 'avg', deepestOn: 'deepest', below: 'below the street', above: 'above the ground',
    surface: 'at street level', kinds: { deep: 'Deep-level', shallow: 'Shallow', surface: 'Surface', elevated: 'Elevated' },
    floors: (n) => `As deep as a <b>${n}-storey</b> building is tall`,
    estimate: 'Depth is an estimate: no published figure found.', transfer: 'Transfer to', m: 'm', langBtn: 'Русский', showHide: 'Show / hide', close: 'Close', docTitle: 'Moscow Metro Depths',
    loading: 'Digging tunnels…',
  },
  ru: {
    title: 'Московское метро под землёй', vOverview: 'Обзор', vSide: 'Разрез', vTop: 'Сверху', vBelow: 'Снизу',
    exag: 'Масштаб глубины', ground: 'Поверхность', colorDepth: 'Цвет по глубине', shafts: 'Шахты к поверхности',
    transfers: 'Пересадки', rotate: 'Вращение', lines: 'Линии', showAll: 'показать все', deepest: 'Самые глубокие',
    sources: 'Данные: Wikidata, ru.wikipedia, hh.ru. Карта © OpenStreetMap, © Stadia Maps / Esri',
    hint: 'Тяните для вращения · правая кнопка для сдвига · колесо для масштаба · нажмите на линию или станцию',
    subtitle: (s, l) => `${s} ${ruPlural(s, 'станция', 'станции', 'станций')}, ${l} ${ruPlural(l, 'линия', 'линии', 'линий')}, глубина от поверхности`,
    stations: (n) => ruPlural(n, 'станция', 'станции', 'станций'), max: 'макс.', avg: 'сред.', deepestOn: 'глубже всего', below: 'под землёй', above: 'над землёй',
    surface: 'на уровне земли', kinds: { deep: 'Глубокого заложения', shallow: 'Мелкого заложения', surface: 'Наземная', elevated: 'Эстакада / мост' },
    floors: (n) => `Как <b>${n}-этажный</b> дом, только вниз`,
    estimate: 'Глубина приблизительная: точных данных не нашлось.', transfer: 'Пересадка', m: 'м', langBtn: 'English', showHide: 'Показать / скрыть', close: 'Закрыть', docTitle: 'Глубина московского метро',
    loading: 'Роем тоннели…',
  },
};

function savedLang() {
  try { return localStorage.getItem('lang'); } catch { return null; }
}

const state = {
  lang: savedLang() || 'ru', exag: 60, ground: 0.85, depthColor: false, shafts: true, transfers: true,
  hidden: new Set(), focusLine: null, hoverLine: null, hoverStation: null, selStation: null,
};
const t = (k) => I18N[state.lang][k] ?? I18N.en[k];
document.querySelector('#loading span').textContent = t('loading');
const sName = (s) => (state.lang === 'ru' ? s.name : s.nameEn);
const lName = (l) => (state.lang === 'ru' ? l.name : l.nameEn);
const lineNum = (l) => { const n = l.id in LINE_NUM ? LINE_NUM[l.id] : l.id; return state.lang === 'ru' ? n.replace('A', 'А') : n; };
const k = () => state.exag / 1000; // scene km per metre of depth
const yOf = (d) => (d <= 0 ? LIFT - d * k() : -d * k());
const fmtNum = (d) => (Number.isInteger(d) ? String(d) : d.toFixed(1));

function fmtDepth(d) {
  if (d < 0) return `+${fmtNum(-d)} ${t('m')}`;
  if (d === 0) return `0 ${t('m')}`;
  return `${fmtNum(d)} ${t('m')}`;
}
function kindOf(d) {
  if (d < 0) return { key: 'elevated', color: '#b8ffcf' };
  if (d === 0) return { key: 'surface', color: '#9fe870' };
  if (d < 20) return { key: 'shallow', color: '#7ef9ff' };
  return { key: 'deep', color: '#e07bff' };
}

const depthStops = DEPTH_STOPS.map(([d, c]) => [d, new THREE.Color(c)]);
function depthColor(d, out = new THREE.Color()) {
  d = Math.max(0, d);
  for (let i = 1; i < depthStops.length; i++) {
    if (d <= depthStops[i][0] || i === depthStops.length - 1) {
      const [d0, c0] = depthStops[i - 1], [d1, c1] = depthStops[i];
      return out.copy(c0).lerp(c1, Math.min(1, (d - d0) / (d1 - d0)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projection (Web Mercator, scaled to true km at Moscow's latitude)
// ---------------------------------------------------------------------------

const R = 6378137, SCALE = Math.cos((LAT0 * Math.PI) / 180);
const mercX = (lng) => (R * lng * Math.PI) / 180;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const X0 = mercX(LNG0), Y0 = mercY(LAT0);
const project = (lat, lng) => ({ x: ((mercX(lng) - X0) * SCALE) / 1000, z: (-(mercY(lat) - Y0) * SCALE) / 1000 });
const lng2tile = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const tile2lng = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x05070b, 1);
container.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
container.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 600);
camera.position.set(0, 95, 1);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.2;
controls.maxDistance = 160;
controls.screenSpacePanning = false;
controls.autoRotateSpeed = 0.35;

const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(devicePixelRatio, 2));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.4, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const groups = {
  tracks: new THREE.Group(), stations: new THREE.Group(), shafts: new THREE.Group(),
  transfers: new THREE.Group(), guides: new THREE.Group(), labels: new THREE.Group(),
};
Object.values(groups).forEach((g) => scene.add(g));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const data = await (await fetch('data/metro.json')).json();
const stationById = new Map();
const lineById = new Map();
for (const s of data.stations) {
  Object.assign(s, project(s.lat, s.lng), { transfers: [], pos: new THREE.Vector3() });
  stationById.set(s.id, s);
}
for (const [a, b] of data.transfers) {
  stationById.get(a).transfers.push(stationById.get(b));
  stationById.get(b).transfers.push(stationById.get(a));
}
const ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '133', '9', '10', '97', '12', '95', '98', '137', '171'];
const lines = data.lines.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
for (const l of lines) {
  lineById.set(l.id, l);
  l.stations = data.stations.filter((s) => s.line === l.id);
  l.stations.forEach((s) => (s.lineObj = l));
  l.maxDepth = Math.max(...l.stations.map((s) => s.depth));
  l.avgDepth = l.stations.reduce((a, s) => a + Math.max(0, s.depth), 0) / l.stations.length;
  l.deepestStation = l.stations.reduce((a, s) => (s.depth > a.depth ? s : a));
  const c = new THREE.Color(l.color);
  const hsl = c.getHSL({});
  if (hsl.l < 0.45) c.setHSL(hsl.h, hsl.s, 0.58); // keep dark line colours readable on black
  l.color3 = c;
  l.css = '#' + c.getHexString();
}

// Bounds of the network, used for the map and the guides.
const bounds = data.stations.reduce(
  (b, s) => ({ n: Math.max(b.n, s.lat), s: Math.min(b.s, s.lat), e: Math.max(b.e, s.lng), w: Math.min(b.w, s.lng),
    minX: Math.min(b.minX, s.x), maxX: Math.max(b.maxX, s.x), minZ: Math.min(b.minZ, s.z), maxZ: Math.max(b.maxZ, s.z) }),
  { n: -90, s: 90, e: -180, w: 180, minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 },
);

// ---------------------------------------------------------------------------
// Ground: stitched CARTO dark tiles on a plane, plus a faint "veil" drawn after the
// tunnels so they read as being underneath the city.
// ---------------------------------------------------------------------------

const ground = (() => {
  // Stadia's dark style is keyless on localhost only; anywhere else use Esri Dark Gray (base + labels).
  const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const hi = !MOBILE;
  const P = local
    ? { z: 12, ts: hi ? 512 : 256, layers: [(z, x, y) => `https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/${z}/${x}/${y}${hi ? '@2x' : ''}.png`] }
    : { z: hi ? 13 : 12, ts: 256, layers: [
        (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
        (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
      ] };
  const Z = P.z, ts = P.ts, pad = 0.06;
  const x0 = Math.floor(lng2tile(bounds.w - pad * 1.8, Z)), x1 = Math.floor(lng2tile(bounds.e + pad * 1.8, Z));
  const y0 = Math.floor(lat2tile(bounds.n + pad, Z)), y1 = Math.floor(lat2tile(bounds.s - pad, Z));
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = nx * ts;
  canvas.height = ny * ts;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b1c1f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  // Soft edge fade so the map dissolves into the dark instead of ending in a hard square.
  const A = 128, ac = document.createElement('canvas');
  ac.width = ac.height = A;
  const actx = ac.getContext('2d'), img = actx.createImageData(A, A);
  for (let y = 0; y < A; y++) for (let x = 0; x < A; x++) {
    const e = Math.min(x, y, A - 1 - x, A - 1 - y) / (A * 0.16);
    const v = Math.round(255 * Math.min(1, e) ** 1.6), i = (y * A + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  actx.putImageData(img, 0, 0);
  const alpha = new THREE.CanvasTexture(ac);

  const nw = project(tile2lat(y0, Z), tile2lng(x0, Z)), se = project(tile2lat(y1 + 1, Z), tile2lng(x1 + 1, Z));
  const geo = new THREE.PlaneGeometry(se.x - nw.x, se.z - nw.z);
  geo.rotateX(-Math.PI / 2);
  const base = { map: tex, alphaMap: alpha, transparent: true, depthWrite: false, side: THREE.DoubleSide };
  const mat = new THREE.MeshBasicMaterial({ ...base, opacity: state.ground });
  const veilMat = new THREE.MeshBasicMaterial({ ...base, opacity: state.ground * 0.3 });
  const mesh = new THREE.Mesh(geo, mat), veil = new THREE.Mesh(geo, veilMat);
  for (const m of [mesh, veil]) m.position.set((nw.x + se.x) / 2, 0, (nw.z + se.z) / 2);
  mesh.renderOrder = 0;
  veil.renderOrder = 10;
  scene.add(mesh, veil);

  let dirty = false, loaded = 0;
  const total = nx * ny;
  const ready = new Promise((resolve) => {
    const done = () => { if (++loaded >= Math.min(total, 12)) resolve(); };
    const load = (src) => new Promise((ok) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => ok(im);
      im.onerror = () => ok(null);
      im.src = src;
    });
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      Promise.all(P.layers.map((u) => load(u(Z, x, y)))).then((imgs) => {
        for (const im of imgs) if (im) ctx.drawImage(im, (x - x0) * ts, (y - y0) * ts, ts, ts);
        dirty = true;
        done();
      });
    }
    setTimeout(resolve, 6000);
  });
  let last = 0;
  return {
    ready,
    setOpacity(o) { mat.opacity = o; veilMat.opacity = o * 0.3; mesh.visible = veil.visible = o > 0.001; },
    tick(now) { if (dirty && now - last > 250) { tex.needsUpdate = true; dirty = false; last = now; } },
  };
})();

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function tubeMaterial() {
  return new THREE.ShaderMaterial({
    vertexColors: true,
    transparent: true,
    uniforms: { uOpacity: { value: 1 }, uGlow: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vColor; varying vec3 vN; varying vec3 vV;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; uniform float uGlow;
      varying vec3 vColor; varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 n = normalize(vN), v = normalize(vV);
        float ndv = max(dot(n, v), 0.0);
        float rim = pow(1.0 - ndv, 2.2);
        float spec = pow(ndv, 24.0) * 0.35;
        vec3 c = vColor * (0.42 + 0.58 * ndv) + vColor * rim * 0.9 + spec + vColor * uGlow * 1.6;
        gl_FragColor = vec4(c, uOpacity);
      }`,
  });
}

const dotTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

const stationGeo = new THREE.SphereGeometry(1, 20, 14);
const haloGeo = new THREE.SphereGeometry(1, 20, 14);
for (const l of lines) {
  l.tubeMat = tubeMaterial();
  l.stationMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff').lerp(l.color3, 0.15), transparent: true });
  l.haloMat = new THREE.MeshBasicMaterial({ color: l.color3, transparent: true, opacity: 0.35, depthWrite: false });
  l.shaftMat = new THREE.LineBasicMaterial({ color: l.color3, transparent: true, opacity: 0.28, depthWrite: false });
  l.surfMat = new THREE.PointsMaterial({ color: l.color3, map: dotTexture, size: 7, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false });
}
const transferMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false });
const guideMat = new THREE.LineDashedMaterial({ color: 0x8fa3c0, transparent: true, opacity: 0.16, dashSize: 0.5, gapSize: 0.35, depthWrite: false });
const rulerMat = new THREE.LineBasicMaterial({ color: 0x8fa3c0, transparent: true, opacity: 0.55 });

// Station meshes and labels are created once; rebuild() only moves them.
for (const s of data.stations) {
  const l = s.lineObj;
  const big = s.transfers.length > 0;
  s.mesh = new THREE.Mesh(stationGeo, l.stationMat);
  s.mesh.scale.setScalar(big ? 0.16 : 0.12);
  s.halo = new THREE.Mesh(haloGeo, l.haloMat);
  s.halo.scale.setScalar(big ? 0.27 : 0.21);
  s.halo.renderOrder = 3;
  s.mesh.renderOrder = 4;
  groups.stations.add(s.mesh, s.halo);

  const wrap = document.createElement('div');
  const el = document.createElement('div');
  el.className = 'label';
  el.style.setProperty('--c', l.css);
  wrap.appendChild(el);
  s.labelEl = el;
  s.label = new CSS2DObject(wrap);
  s.label.visible = false;
  groups.labels.add(s.label);
}

// ---------------------------------------------------------------------------
// Geometry that depends on the depth exaggeration
// ---------------------------------------------------------------------------

function disposeGroup(g) {
  for (const o of [...g.children]) {
    o.geometry?.dispose();
    g.remove(o);
  }
}

function tubeColors(geo, line) {
  const pos = geo.attributes.position, n = pos.count, arr = new Float32Array(n * 3), c = new THREE.Color(), kk = k();
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    if (state.depthColor) depthColor(y > 0 ? 0 : -y / kk, c);
    else c.copy(line.color3);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

function rebuild() {
  for (const s of data.stations) {
    s.pos.set(s.x, yOf(s.depth), s.z);
    s.mesh.position.copy(s.pos);
    s.halo.position.copy(s.pos);
    s.label.position.copy(s.pos);
  }

  disposeGroup(groups.tracks);
  for (const l of lines) {
    l.meshes = [];
    for (const seg of l.segments) {
      const pts = seg.map((id) => stationById.get(id).pos.clone());
      const curve = new THREE.CatmullRomCurve3(pts, l.ring, 'centripetal', 0.5);
      const geo = new THREE.TubeGeometry(curve, Math.max(80, pts.length * 28), TUBE_R, 10, l.ring);
      tubeColors(geo, l);
      const m = new THREE.Mesh(geo, l.tubeMat);
      m.userData.line = l;
      m.renderOrder = 2;
      l.meshes.push(m);
      groups.tracks.add(m);
    }
  }

  disposeGroup(groups.shafts);
  for (const l of lines) {
    const seg = [], surf = [];
    for (const s of l.stations) {
      surf.push(s.x, 0.004, s.z);
      if (s.depth > 0) seg.push(s.x, 0, s.z, s.x, s.pos.y, s.z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    const ls = new THREE.LineSegments(lg, l.shaftMat);
    ls.renderOrder = 1;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(surf, 3));
    const pts = new THREE.Points(pg, l.surfMat);
    pts.renderOrder = 11;
    ls.userData.line = pts.userData.line = l;
    l.shaftObjs = [ls, pts];
    groups.shafts.add(ls, pts);
  }

  disposeGroup(groups.transfers);
  const tr = [];
  for (const [a, b] of data.transfers) {
    const A = stationById.get(a).pos, B = stationById.get(b).pos;
    tr.push(A.x, A.y, A.z, B.x, B.y, B.z);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(tr, 3));
  const tl = new THREE.LineSegments(tg, transferMat);
  tl.renderOrder = 3;
  groups.transfers.add(tl);

  buildGuides();
  applyVisibility();
}

// Dashed depth "floors" every 20 m, and a ruler at the south-west corner.
const rulerLabels = [];
function buildGuides() {
  disposeGroup(groups.guides);
  rulerLabels.forEach((o) => groups.labels.remove(o));
  rulerLabels.length = 0;
  const m = 1.2, x0 = bounds.minX - m, x1 = bounds.maxX + m, z0 = bounds.minZ - m, z1 = bounds.maxZ + m;
  for (const d of [20, 40, 60, 80]) {
    const y = yOf(d);
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1),
      new THREE.Vector3(x0, y, z1), new THREE.Vector3(x0, y, z0),
    ]);
    const line = new THREE.Line(g, guideMat);
    line.computeLineDistances();
    groups.guides.add(line);
  }
  const rx = x0, rz = z1;
  const pts = [new THREE.Vector3(rx, 0, rz), new THREE.Vector3(rx, yOf(90), rz)];
  for (let d = 10; d <= 90; d += 10) {
    const y = yOf(d), w = d % 20 === 0 ? 0.6 : 0.3;
    pts.push(new THREE.Vector3(rx, y, rz), new THREE.Vector3(rx + w, y, rz));
  }
  groups.guides.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), rulerMat));
  for (let d = 0; d <= 80; d += 20) {
    const el = document.createElement('div');
    el.className = 'ruler-label';
    el.textContent = d === 0 ? `0 ${t('m')}` : `−${d} ${t('m')}`;
    const o = new CSS2DObject(el);
    o.position.set(rx, d === 0 ? 0 : yOf(d), rz);
    groups.labels.add(o);
    rulerLabels.push(o);
  }
}

// ---------------------------------------------------------------------------
// Visibility and highlight
// ---------------------------------------------------------------------------

function activeLine() {
  return state.hoverLine ?? state.focusLine;
}

function applyVisibility() {
  const active = activeLine();
  const selLine = state.selStation?.lineObj;
  for (const l of lines) {
    const hidden = state.hidden.has(l.id);
    const on = !active || l.id === active || (selLine && l.id === selLine.id);
    const op = on ? 1 : 0.07;
    l.tubeMat.uniforms.uOpacity.value = op;
    l.tubeMat.uniforms.uGlow.value = l.id === state.hoverLine ? 0.28 : l.id === state.focusLine ? 0.12 : 0;
    l.tubeMat.depthWrite = op > 0.9;
    l.stationMat.opacity = on ? 1 : 0.05;
    l.haloMat.opacity = on ? 0.35 : 0;
    l.shaftMat.opacity = on ? (active ? 0.55 : 0.26) : 0.04;
    l.surfMat.opacity = on ? 0.85 : 0.08;
    for (const m of l.meshes ?? []) m.visible = !hidden;
    for (const o of l.shaftObjs ?? []) o.visible = !hidden && state.shafts;
    for (const s of l.stations) {
      s.mesh.visible = s.halo.visible = !hidden;
      const show = !hidden && (
        s === state.selStation || s === state.hoverStation ||
        (state.focusLine === l.id && !state.hoverLine) || (state.hoverLine === l.id)
      );
      s.label.visible = show;
      if (show) s.labelEl.textContent = sName(s);
      s.labelEl.classList.toggle('small', !(s === state.selStation || s === state.hoverStation));
    }
  }
  groups.transfers.visible = state.transfers;
  transferMat.opacity = active ? 0.2 : 0.5;
  document.querySelectorAll('#lines li').forEach((li) => {
    li.classList.toggle('active', li.dataset.id === state.focusLine);
    li.classList.toggle('off', state.hidden.has(li.dataset.id));
  });
}

// ---------------------------------------------------------------------------
// Camera animation
// ---------------------------------------------------------------------------

let fly = null;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
function flyTo(pos, target, dur = 1400) {
  fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, start: performance.now(), dur };
}
renderer.domElement.addEventListener('pointerdown', () => (fly = null));

const VIEWS = {
  overview: () => [new THREE.Vector3(20, 17, 34), new THREE.Vector3(0, -2, 1)],
  top: () => [new THREE.Vector3(0, 78, 0.01), new THREE.Vector3(0, 0, 0)],
  side: () => [new THREE.Vector3(0, yOf(35) + 0.4, 44), new THREE.Vector3(0, yOf(35), 0)],
  below: () => [new THREE.Vector3(14, -30, 30), new THREE.Vector3(0, -1, 0)],
};
function setView(name) {
  const [p, tg] = VIEWS[name]();
  flyTo(p, tg);
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

function frameLine(l) {
  const box = new THREE.Box3();
  l.stations.forEach((s) => box.expandByPoint(s.pos));
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.25) dir.y = 0.25;
  dir.normalize();
  flyTo(c.clone().add(dir.multiplyScalar(Math.max(8, size * 1.25))), c);
}

function frameStation(s) {
  const dir = camera.position.clone().sub(controls.target).normalize();
  const dist = Math.min(camera.position.distanceTo(controls.target), 9);
  flyTo(s.pos.clone().add(dir.multiplyScalar(Math.max(dist, 7))), s.pos.clone());
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmp = new THREE.Vector3();
let mouse = null, mouseDirty = false;

function pickStation(mx, my) {
  let best = null, bd = 13 * 13;
  const active = activeLine();
  for (const s of data.stations) {
    if (state.hidden.has(s.line)) continue;
    tmp.copy(s.pos).project(camera);
    if (tmp.z > 1) continue;
    const sx = ((tmp.x + 1) / 2) * innerWidth, sy = ((1 - tmp.y) / 2) * innerHeight;
    let d = (sx - mx) ** 2 + (sy - my) ** 2;
    if (active && s.line !== active) d *= 2.5; // prefer the highlighted line
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function pickLine(mx, my) {
  ndc.set((mx / innerWidth) * 2 - 1, -(my / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = groups.tracks.children.filter((m) => m.visible);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit?.object.userData.line ?? null;
}

const tooltip = document.getElementById('tooltip');
function showTooltip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.min(x + 16, innerWidth - r.width - 8) + 'px';
  tooltip.style.top = Math.max(8, y - r.height - 12) + 'px';
}
const hideTooltip = () => (tooltip.hidden = true);

function stationTip(s) {
  const kd = kindOf(s.depth);
  return `<div class="row"><span class="dot" style="background:${s.lineObj.css}"></span><b>${sName(s)}</b><span class="dp">${fmtDepth(s.depth)}</span></div>
    <div class="sub">${lName(s.lineObj)} · ${t('kinds')[kd.key]}</div>`;
}
function lineTip(l) {
  return `<div class="row"><span class="dot" style="background:${l.css}"></span><b>${lName(l)}</b><span class="dp">${t('max')} ${fmtNum(l.maxDepth)} ${t('m')}</span></div>
    <div class="sub">${l.stations.length} ${t('stations')(l.stations.length)} · ${t('avg')} ${Math.round(l.avgDepth)} ${t('m')}</div>`;
}

function doHover() {
  if (!mouse) return;
  const s = pickStation(mouse.x, mouse.y);
  const l = s ? null : pickLine(mouse.x, mouse.y);
  const newHoverLine = s ? null : l?.id ?? null;
  if (s !== state.hoverStation || newHoverLine !== state.hoverLine) {
    state.hoverStation = s;
    state.hoverLine = newHoverLine;
    applyVisibility();
    highlightProfile(s);
  }
  renderer.domElement.style.cursor = s || l ? 'pointer' : '';
  if (s) showTooltip(stationTip(s), mouse.x, mouse.y);
  else if (l) showTooltip(lineTip(l), mouse.x, mouse.y);
  else hideTooltip();
}

let downAt = null;
renderer.domElement.addEventListener('pointermove', (e) => { mouse = { x: e.clientX, y: e.clientY }; mouseDirty = true; });
renderer.domElement.addEventListener('pointerleave', () => {
  mouse = null; hideTooltip();
  if (state.hoverLine || state.hoverStation) { state.hoverLine = state.hoverStation = null; applyVisibility(); }
});
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const s = pickStation(e.clientX, e.clientY);
  if (s) return selectStation(s, true);
  const l = pickLine(e.clientX, e.clientY);
  if (l) return focusLine(l.id, true);
  clearSelection();
});
addEventListener('keydown', (e) => e.key === 'Escape' && clearSelection());

// ---------------------------------------------------------------------------
// Selection: focus line, station card, depth profile
// ---------------------------------------------------------------------------

const card = document.getElementById('card');
const profile = document.getElementById('profile');
const svg = document.getElementById('profile-svg');

function focusLine(id, frame = false) {
  state.focusLine = id;
  state.hoverLine = null;
  if (state.selStation && state.selStation.line !== id) closeCard();
  applyVisibility();
  if (id) {
    renderProfile(lineById.get(id));
    if (frame) frameLine(lineById.get(id));
  } else {
    profile.hidden = true;
    document.body.classList.remove('has-profile');
  }
}

function selectStation(s, frame = false) {
  state.selStation = s;
  if (state.focusLine !== s.line) focusLine(s.line);
  applyVisibility();
  renderCard(s);
  highlightProfile(s);
  if (frame) frameStation(s);
}

function closeCard() {
  state.selStation = null;
  card.hidden = true;
  applyVisibility();
  highlightProfile(null);
}

function clearSelection() {
  closeCard();
  focusLine(null);
}

function renderCard(s) {
  const kd = kindOf(s.depth);
  const others = [...new Map(s.transfers.map((o) => [o.line, o])).values()];
  const chip = (st) => `<button class="chip" data-station="${st.id}"><i style="background:${st.lineObj.css}">${lineNum(st.lineObj)}</i>${lName(st.lineObj)}</button>`;
  const d = s.depth;
  const floors = Math.round(d / 3);
  const sub = d < 0 ? t('above') : d === 0 ? t('surface') : t('below');
  card.innerHTML = `
    <button class="icon-btn close" aria-label="${t('close')}">✕</button>
    <h3>${sName(s)}</h3>
    <div class="ru">${state.lang === 'ru' ? s.nameEn : s.name}</div>
    <div class="chips">${chip(s)}${others.length ? others.map(chip).join('') : ''}</div>
    <div class="depth-big"><b style="color:${kd.color}">${fmtDepth(d)}</b><span>${sub}</span></div>
    <span class="kind" style="background:${kd.color}22;color:${kd.color}">${t('kinds')[kd.key]}</span>
    ${d >= 6 ? `<div class="compare">${depthGlyph(d, kd.color)}<p>${t('floors')(floors)}</p></div>` : ''}
    ${s.source === 'estimate' ? `<div class="note">${t('estimate')}</div>` : ''}
  `;
  card.hidden = false;
  card.querySelector('.close').onclick = closeCard;
  card.querySelectorAll('[data-station]').forEach((b) => {
    b.onclick = () => selectStation(stationById.get(b.dataset.station), true);
  });
}

// Side-view glyph: the station's depth next to an upside-down building of the same height.
function depthGlyph(d, color) {
  const px = 70 / 85, h = Math.max(6, d * px), top = 6, W = 70;
  const floors = Math.round(d / 3);
  let win = '';
  for (let i = 1; i < floors; i++) {
    const y = top + i * 3 * px;
    win += `<line x1="9" x2="27" y1="${y}" y2="${y}"/>`;
  }
  return `<svg width="${W}" height="${top + h + 10}" viewBox="0 0 ${W} ${top + h + 10}" aria-hidden="true">
    <rect x="8" y="${top}" width="20" height="${h}" fill="rgba(138,147,166,0.08)" stroke="#8a93a6" stroke-width="1"/>
    <g stroke="#8a93a6" stroke-width="0.6" opacity="0.5">${win}</g>
    <line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="#cfd6e4" stroke-width="1.2"/>
    <line x1="50" x2="50" y1="${top}" y2="${top + h}" stroke="${color}" stroke-width="1.5" stroke-dasharray="3 2"/>
    <rect x="38" y="${top + h - 3}" width="24" height="6" rx="3" fill="${color}"/>
  </svg>`;
}

// Depth profile: distance along the line vs depth.
let profilePts = [];
function renderProfile(l) {
  profile.hidden = false;
  document.body.classList.add('has-profile');
  profile.querySelector('.profile-title').innerHTML = `
    <span class="badge" style="background:${l.css}">${lineNum(l)}</span>
    <span>${lName(l)}</span>
    <small>${l.stations.length} ${t('stations')(l.stations.length)} · ${t('deepestOn')}: ${sName(l.deepestStation)} (${fmtNum(l.maxDepth)} ${t('m')}) · ${t('avg')} ${Math.round(l.avgDepth)} ${t('m')}</small>`;
  profile.querySelector('#profile-close').onclick = clearSelection;

  const W = svg.clientWidth || 800, H = svg.clientHeight || 180;
  const m = { l: 44, r: 14, t: 14, b: 62 };
  const segs = l.segments.map((seg) => {
    const st = seg.map((id) => stationById.get(id));
    if (l.ring) st.push(st[0]);
    return st;
  });
  const gap = 1.5; // km between branches
  let cum = 0;
  profilePts = [];
  segs.forEach((st, si) => {
    if (si) cum += gap;
    st.forEach((s, i) => {
      if (i) cum += Math.hypot(s.x - st[i - 1].x, s.z - st[i - 1].z);
      profilePts.push({ s, dist: cum, seg: si, dup: l.ring && i === st.length - 1 });
    });
  });
  const minD = Math.min(-10, ...l.stations.map((s) => s.depth)), maxD = Math.max(30, Math.ceil(l.maxDepth / 10) * 10);
  const X = (v) => m.l + (v / cum) * (W - m.l - m.r);
  const Y = (d) => m.t + ((d - Math.min(0, minD)) / (maxD - Math.min(0, minD))) * (H - m.t - m.b);
  const y0 = Y(0);

  let grid = '';
  for (let d = 10; d <= maxD; d += 10) {
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(d)}" y2="${Y(d)}"/>`;
    if (d % 20 === 0 || maxD <= 40) grid += `<text x="${m.l - 8}" y="${Y(d) + 3}" text-anchor="end">−${d}</text>`;
  }

  const pathFor = (pts) => {
    const P = pts.map((p) => [X(p.dist), Y(p.s.depth)]);
    let d = `M${P[0][0]},${P[0][1]}`;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
    }
    return { d, first: P[0], last: P[P.length - 1] };
  };

  let curves = '';
  segs.forEach((_, si) => {
    const pts = profilePts.filter((p) => p.seg === si);
    const { d, first, last } = pathFor(pts);
    curves += `<path d="${d} L${last[0]},${y0} L${first[0]},${y0} Z" fill="url(#pg)" />`;
    curves += `<path d="${d}" fill="none" stroke="${l.css}" stroke-width="2.5" stroke-linecap="round"/>`;
  });

  const spacing = (W - m.l - m.r) / Math.max(1, profilePts.length - 1);
  let dots = '';
  profilePts.forEach((p, i) => {
    if (p.dup) return;
    const x = X(p.dist), y = Y(p.s.depth);
    const showNum = spacing > 34 || p.s === l.deepestStation;
    dots += `<g class="st" data-i="${i}">
      <line x1="${x}" x2="${x}" y1="${y0}" y2="${y}" stroke="${l.css}" stroke-opacity="0.25"/>
      <circle cx="${x}" cy="${y}" r="3.8" fill="#0c0f16" stroke="${l.css}" stroke-width="2"/>
      ${showNum ? `<text x="${x}" y="${y + 15}" text-anchor="middle" class="axis" style="font-family:var(--mono);font-size:9.5px">${fmtNum(p.s.depth)}</text>` : ''}
      <text transform="translate(${x + 3},${H - m.b + 12}) rotate(-38)" text-anchor="end">${sName(p.s)}</text>
      <rect x="${x - spacing / 2}" y="${m.t}" width="${spacing}" height="${H - m.t}" fill="transparent"/>
    </g>`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs><linearGradient id="pg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${l.css}" stop-opacity="0.05"/><stop offset="1" stop-color="${l.css}" stop-opacity="0.35"/>
    </linearGradient></defs>
    <g class="axis">${grid}</g>
    <line class="ground" x1="${m.l}" x2="${W - m.r}" y1="${y0}" y2="${y0}"/>
    <text x="${m.l - 8}" y="${y0 + 3}" text-anchor="end" class="axis" style="font-family:var(--mono);font-size:10px">0 ${t('m')}</text>
    ${curves}${dots}`;

  svg.querySelectorAll('.st').forEach((g) => {
    const p = profilePts[+g.dataset.i];
    g.addEventListener('mouseenter', (e) => {
      state.hoverStation = p.s;
      applyVisibility();
      g.classList.add('hl');
      showTooltip(stationTip(p.s), e.clientX, e.clientY);
    });
    g.addEventListener('mouseleave', () => {
      state.hoverStation = null;
      applyVisibility();
      g.classList.toggle('hl', p.s === state.selStation);
      hideTooltip();
    });
    g.addEventListener('click', () => selectStation(p.s, true));
  });
  highlightProfile(state.selStation);
}

function highlightProfile(s) {
  if (profile.hidden) return;
  svg.querySelectorAll('.st').forEach((g) => {
    const p = profilePts[+g.dataset.i];
    g.classList.toggle('hl', p.s === s || p.s === state.selStation);
  });
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function renderPanel() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = t(el.dataset.i18n);
    if (typeof v === 'string') el.textContent = v;
  });
  document.documentElement.lang = state.lang;
  document.title = t('docTitle');
  document.getElementById('subtitle').textContent = t('subtitle')(data.stations.length, lines.length);
  document.getElementById('lang').textContent = t('langBtn');

  const ul = document.getElementById('lines');
  ul.innerHTML = lines.map((l) => `
    <li data-id="${l.id}">
      <span class="badge" style="background:${l.css}">${lineNum(l) || '·'}</span>
      <span class="nm"><b>${lName(l)}</b><small>${state.lang === 'ru' ? l.nameEn : l.name}</small></span>
      <span class="dp">${fmtNum(l.maxDepth)} ${t('m')}</span>
      <button class="eye" title="${t('showHide')}" aria-label="${t('showHide')}">${state.hidden.has(l.id) ? '◌' : '●'}</button>
    </li>`).join('');
  ul.querySelectorAll('li').forEach((li) => {
    const id = li.dataset.id;
    li.onclick = (e) => {
      if (e.target.closest('.eye')) {
        state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id);
        e.target.textContent = state.hidden.has(id) ? '◌' : '●';
        if (state.focusLine === id) clearSelection();
        applyVisibility();
        return;
      }
      if (state.hidden.has(id)) state.hidden.delete(id);
      focusLine(state.focusLine === id ? null : id, true);
    };
    li.onmouseenter = () => { if (!state.hidden.has(id)) { state.hoverLine = id; applyVisibility(); } };
    li.onmouseleave = () => { state.hoverLine = null; applyVisibility(); };
  });

  const seen = new Set();
  const deepest = [...data.stations].sort((a, b) => b.depth - a.depth).filter((s) => {
    const key = s.name + s.depth;
    return !seen.has(key) && seen.add(key);
  }).slice(0, 10);
  const ol = document.getElementById('deepest');
  ol.innerHTML = deepest.map((s) => `<li data-id="${s.id}"><span class="dot" style="background:${s.lineObj.css}"></span><span>${sName(s)}</span><span class="v">${fmtNum(s.depth)} ${t('m')}</span></li>`).join('');
  ol.querySelectorAll('li').forEach((li) => (li.onclick = () => {
    const s = stationById.get(li.dataset.id);
    state.hidden.delete(s.line);
    selectStation(s, true);
  }));
  applyVisibility();
}

document.getElementById('all-lines').onclick = () => {
  state.hidden.clear();
  clearSelection();
  renderPanel();
  setView('overview');
};
document.getElementById('lang').onclick = () => {
  state.lang = state.lang === 'en' ? 'ru' : 'en';
  try { localStorage.setItem('lang', state.lang); } catch {}
  document.querySelector('#loading span').textContent = t('loading');
  renderPanel();
  buildGuides();
  if (state.focusLine) renderProfile(lineById.get(state.focusLine));
  if (state.selStation) renderCard(state.selStation);
};
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document.getElementById('panel-toggle').onclick = () => document.getElementById('panel').classList.toggle('collapsed');
if (MOBILE) document.getElementById('panel').classList.add('collapsed');

let rebuildQueued = false;
const exagEl = document.getElementById('exag');
exagEl.oninput = () => {
  state.exag = +exagEl.value;
  document.getElementById('exag-val').textContent = state.exag + '×';
  if (!rebuildQueued) {
    rebuildQueued = true;
    requestAnimationFrame(() => { rebuildQueued = false; rebuild(); });
  }
};
const groundEl = document.getElementById('ground');
groundEl.oninput = () => {
  state.ground = groundEl.value / 100;
  document.getElementById('ground-val').textContent = groundEl.value + '%';
  ground.setOpacity(state.ground);
};
document.getElementById('t-depthcolor').onchange = (e) => {
  state.depthColor = e.target.checked;
  document.getElementById('depth-legend').hidden = !state.depthColor;
  for (const l of lines) for (const m of l.meshes) tubeColors(m.geometry, l);
};
document.getElementById('t-shafts').onchange = (e) => { state.shafts = e.target.checked; applyVisibility(); };
document.getElementById('t-transfers').onchange = (e) => { state.transfers = e.target.checked; applyVisibility(); };
document.getElementById('t-rotate').onchange = (e) => (controls.autoRotate = e.target.checked);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  if (state.focusLine) renderProfile(lineById.get(state.focusLine));
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

rebuild();
renderPanel();
controls.target.set(0, 0, 0);

function loop(now) {
  if (fly) {
    const x = Math.min(1, (now - fly.start) / fly.dur), e = ease(x);
    camera.position.lerpVectors(fly.p0, fly.p1, e);
    controls.target.lerpVectors(fly.t0, fly.t1, e);
    if (x >= 1) fly = null;
  }
  controls.update();
  if (mouseDirty) { mouseDirty = false; doHover(); }
  ground.tick(now);
  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

await ground.ready;
document.getElementById('loading').classList.add('done');
setTimeout(() => setView('overview'), 250);
