/* Rail Inspection 3D Map — viewer
 * Reads two data files produced by the processing pipeline:
 *   window.RAIL_LINE   (data/rail_line.js)   rail centreline + stations
 *   window.INSPECTION  (data/inspection.js)  campaigns, sections, defects (schema rail-inspection/0.1)
 * Renders them on MapLibre (base map + 3D buildings) with a deck.gl overlay.
 */
(() => {
  'use strict';
  const L = window.RAIL_LINE;
  const D = window.INSPECTION;
  if (!L || !D) { document.body.innerHTML = '<p style="padding:24px">data/*.js が見つかりません。tools/build_demo_data.ps1 を実行してください。</p>'; return; }

  // ------------------------------------------------------------------ constants & helpers
  const NC = D.campaigns.length;
  const GRANK = { AA: 0, A1: 1, A2: 2, B: 3, C: 4, S: 5 };
  const GCOL = { AA: [255, 61, 87], A1: [255, 111, 69], A2: [255, 166, 43], B: [240, 208, 60], C: [52, 199, 138], S: [52, 199, 138] };
  const CAT = g => (g === 'AA' || g === 'A1') ? 'red' : g === 'A2' ? 'orange' : g === 'B' ? 'yellow' : 'green';
  const CAT_COL = { red: [255, 61, 87], orange: [255, 166, 43], yellow: [240, 208, 60], green: [46, 170, 120] };
  const MAJOR = new Set(['東京', '品川', '渋谷', '新宿', '池袋', '田端', '上野', '大崎', '秋葉原']);
  const FONT = '"Noto Sans JP","Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif';

  const defById = new Map(D.defects.map(d => [d.id, d]));
  const secById = new Map(D.sections.map(s => [s.id, s]));
  const gradeInfo = id => D.grades.find(g => g.id === id);
  const typeInfo = t => D.defect_types[t];
  const rgb = (c, a) => a == null ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${a})`;
  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------------ i18n (JA / EN)
  // Data files stay Japanese (the operator's vocabulary); English is a display layer.
  let lang = 'en';
  try { lang = localStorage.getItem('railDemo.lang') || lang; } catch (e) { /* storage blocked */ }
  const qLang = new URLSearchParams(location.search).get('lang');
  if (qLang === 'ja' || qLang === 'en') lang = qLang;
  const EN = lang => lang === 'en';

  const UI = {
    ja: {
      title: '鉄道インフラ点検 3Dマップ', list: '一覧', compare: '前回比較', flights: '飛行ルート', bldg: '3D建物', home: '全体表示',
      pipeline: '処理パイプライン', prio: '優先対応リスト', prioSub: 'リスク順 · AI提案', strip: 'キロ程ストリップ', stripHint: 'クリックで区間へ移動',
      banner: 'デモ用の擬似点検データ · 線形 © OpenStreetMap contributors', langBtn: 'EN', langTitle: 'Switch to English',
    },
    en: {
      title: 'Rail Infrastructure Inspection 3D Map', list: 'List', compare: 'Compare prev.', flights: 'Flight paths', bldg: '3D buildings', home: 'Overview',
      pipeline: 'Processing pipeline', prio: 'Priority list', prioSub: 'by risk · AI proposal', strip: 'Chainage strip', stripHint: 'click to jump to a section',
      banner: 'Demo with simulated inspection data · Track geometry © OpenStreetMap contributors', langBtn: '日本語', langTitle: '日本語に切り替え',
    },
  };
  const tr = k => UI[lang][k];
  const ST_EN = Object.fromEntries(L.stations.map(s => [s.name, s.name_en || s.name]));
  const COMP_EN = {
    'アーチ部': 'Arch', '橋脚': 'Pier', '架線柱': 'Catenary pole', 'スラブ・梁': 'Slab / beam', '高欄': 'Parapet',
    '主桁（鋼）': 'Main girder (steel)', '支承': 'Bearing', '橋台': 'Abutment', '擁壁': 'Retaining wall', '法面': 'Slope', '軌道': 'Track',
  };
  const ASSET_EN = { viaduct_brick: 'Brick arch viaduct', viaduct_rc: 'RC viaduct', bridge_steel: 'Steel bridge', earthwork: 'Embankment / cutting' };
  const ASSET_LABEL_EN = { '目黒川橋梁（仮）': 'Meguro River bridge (tentative)', '神田川橋梁（仮）': 'Kanda River bridge (tentative)', '跨線橋（仮）': 'Overbridge (tentative)' };
  const GRADE_EN = {
    AA: ['Urgent action', 'Emergency measures; decide on operating restrictions'],
    A1: ['Prompt action', 'Detailed survey → prompt repair plan'],
    A2: ['Action when needed', 'Register in the repair plan'],
    B: ['Monitor (may progress)', 'Intensify monitoring; prioritise in next flight'],
    C: ['Focus at next inspection', 'Check at next periodic inspection'],
    S: ['Sound', 'No action needed'],
  };
  const METRIC_EN = { crack: 'Length', spalling: 'Area', rebar: 'Exposed length', rust: 'Area', leak: 'Area', deform: 'Displacement', missing: 'Count' };
  const NOTE_EN = {
    '前回比でひび割れ長・幅ともに進展。進展速度が増加傾向。': 'Crack length and width both grew since the last inspection; the growth rate is accelerating.',
    '下フランジ付近の腐食面積が2年で約4.5倍。塗装劣化の可能性。': 'Corroded area near the bottom flange grew ~4.5× in 2 years. Possible coating deterioration.',
    '今回検査で新規検出。かぶりコンクリート剥落後の鉄筋露出と推定。': 'Newly detected in this inspection. Likely rebar exposed after the cover concrete spalled.',
    '2025年度に初検出。面積が拡大。': 'First detected in FY2025. The area is expanding.',
    '遊離石灰を伴う漏水。降雨後の再撮影を推奨。': 'Leakage with efflorescence. Re-shoot after rainfall recommended.',
    '点群比較で柱頭の傾斜量が増加。': 'Point-cloud comparison shows increasing tilt at the pole top.',
    '締結装置の欠損候補。夜間の近接目視で確認要。': 'Possible missing rail fastenings. Confirm by close visual check at night.',
  };
  const stName = n => EN(lang) ? (ST_EN[n] || n) : n;
  const typeName = t => EN(lang) ? typeInfo(t).en : typeInfo(t).ja;
  const compName = c => EN(lang) ? (COMP_EN[c] || c) : c;
  const assetName = a => EN(lang) ? ASSET_EN[a] : D.asset_types[a].ja;
  const assetLabel = s => s.asset_label ? (EN(lang) ? (ASSET_LABEL_EN[s.asset_label] || s.asset_label) : s.asset_label) : null;
  const gradeName = g => EN(lang) ? GRADE_EN[g][0] : gradeInfo(g).ja;
  const gradeAction = g => EN(lang) ? GRADE_EN[g][1] : gradeInfo(g).action;
  const metric = t => EN(lang) ? METRIC_EN[t] : typeInfo(t).metric;
  const unit = t => EN(lang) && typeInfo(t).unit === '箇所' ? 'pcs' : typeInfo(t).unit;
  const noteText = d => EN(lang) ? (NOTE_EN[d.note] || d.note) : d.note;
  const campLabel = cp => EN(lang) ? `FY${cp.id} periodic inspection` : cp.label;
  const fmt = (n, d = 0) => n == null ? '—' : Number(n).toLocaleString(EN(lang) ? 'en-US' : 'ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
  const between = s => EN(lang) ? `${stName(s.between[0])} – ${stName(s.between[1])}` : `${s.between[0]}〜${s.between[1]}`;
  const J = (ja, en) => EN(lang) ? en : ja;   // inline strings

  function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function growth(d, c) {
    const o = d.obs[c]; if (!o) return null;
    const p = c > 0 ? d.obs[c - 1] : null;
    if (!p) return 0.3;  // newly detected
    return Math.max(0, Math.min(1, (o.sev - p.sev) / 0.3));
  }
  function trendTag(d, c) {
    if (!d.obs[c]) return { cls: 'flat', txt: '' };
    if (c === 0) return { cls: 'flat', txt: J('初回', 'first') };
    if (!d.obs[c - 1]) return { cls: 'new', txt: 'NEW' };
    const dv = d.risk[c] - d.risk[c - 1];
    if (dv > 0.05) return { cls: 'up', txt: `▲ +${dv.toFixed(2)}` };
    return { cls: 'flat', txt: `${dv >= 0 ? '+' : ''}${dv.toFixed(2)}` };
  }

  // ------------------------------------------------------------------ state
  const state = {
    c: NC - 1, compare: false, flights: true, buildings: true,
    sel: null,               // {kind:'defect'|'section', id}
    zoom: 12.5,
    cloud: null,             // {id, points, anchorZ}
  };

  // ------------------------------------------------------------------ map
  const lons = L.coordinates.map(p => p[0]), lats = L.coordinates.map(p => p[1]);
  const BBOX = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  const startedWithHash = location.hash.length > 1;   // read before MapLibre starts writing the hash
  const map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [(BBOX[0][0] + BBOX[1][0]) / 2, (BBOX[0][1] + BBOX[1][1]) / 2],
    zoom: 12.3, pitch: 50, bearing: -18, maxPitch: 75,
    hash: true,   // camera in URL (#zoom/lat/lon/bearing/pitch) — handy for sharing a view
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  function padding() {
    if (window.innerWidth <= 860) return { top: 40, bottom: state.sel ? window.innerHeight * 0.45 : 40, left: 20, right: 20 };
    const css = getComputedStyle(document.documentElement);
    const lw = parseFloat(css.getPropertyValue('--left-w')) || 340;
    const dw = parseFloat(css.getPropertyValue('--detail-w')) || 390;
    return { top: 50, bottom: 110, left: lw + 30, right: state.sel ? dw + 30 : 40 };
  }
  function home(duration = 1600) {
    const cam = map.cameraForBounds(BBOX, { padding: padding(), bearing: -18 });
    // cameraForBounds ignores pitch; a pitched view needs a bit more zoom to fill the screen
    const boost = window.innerWidth <= 860 ? -0.15 : 0.45;
    map.flyTo({ center: cam.center, zoom: cam.zoom + boost, pitch: 50, bearing: -18, duration });
  }

  const overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip });
  map.addControl(overlay);

  map.on('load', () => {
    // 3D buildings from the OpenMapTiles "building" source-layer
    const firstSymbol = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
    map.addLayer({
      id: 'bldg-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#18212b', 120, '#273445'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.88,
      },
    }, firstSymbol);
    if (!state.buildings) map.setLayoutProperty('bldg-3d', 'visibility', 'none');
  });
  map.once('styledata', () => { if (!state.sel && !startedWithHash) home(0); });
  state.zoom = map.getZoom();
  map.on('zoom', () => {
    const z = map.getZoom();
    const bucket = z => z < 14 ? 0 : z < 16 ? 1 : 2;
    const changed = bucket(z) !== bucket(state.zoom);
    state.zoom = z;
    if (changed) renderLayers();
  });

  // ------------------------------------------------------------------ derived geometry
  // Drone flight routes: ~2 km legs, offset 14 m from the track, 30 m above it.
  const flights = (() => {
    const out = []; const R = 6371008.8, rad = Math.PI / 180;
    const co = L.coordinates; let leg = [], dist = 0;
    for (let i = 0; i < co.length; i++) {
      const a = co[Math.max(0, i - 1)], b = co[Math.min(co.length - 1, i + 1)];
      const kx = Math.cos(co[i][1] * rad);
      const dx = (b[0] - a[0]) * kx, dy = b[1] - a[1]; const n = Math.hypot(dx, dy) || 1;
      const off = 14 * (out.length % 2 ? 1 : -1);   // alternate sides per leg
      const ox = (dy / n) * off, oy = (-dx / n) * off;
      leg.push([co[i][0] + ox / (R * kx * rad), co[i][1] + oy / (R * rad), 32]);
      if (i > 0) { const p = co[i - 1]; dist += Math.hypot((co[i][0] - p[0]) * kx, co[i][1] - p[1]) * rad * R; }
      if (dist > 2000 || i === co.length - 1) { out.push({ id: out.length + 1, path: leg }); leg = [leg[leg.length - 1]]; dist = 0; }
    }
    return out;
  })();

  // ------------------------------------------------------------------ synthetic reconstruction (point cloud)
  // Stand-in for the SfM/MVS output: a procedurally generated structure around the defect.
  function buildCloud(d) {
    const r = rng(hash(d.id)); const pts = [];
    const H = D.asset_types[d.asset].height_m;
    const shade = (c, k = 26) => { const v = (r() - 0.5) * k; return [c[0] + v, c[1] + v, c[2] + v].map(x => Math.max(0, Math.min(255, x))); };
    const add = (x, y, z, c) => pts.push({ p: [x, y, z], c });
    const LEN = 50;
    let anchor = [0, 0, 0];

    // ground
    for (let i = 0; i < 4000; i++) add((r() - 0.5) * LEN * 1.2, (r() - 0.5) * 40, r() * 0.05, shade([48, 56, 52], 14));

    if (d.asset === 'viaduct_rc' || d.asset === 'viaduct_brick') {
      const brick = d.asset === 'viaduct_brick';
      const base = brick ? [146, 80, 58] : [150, 154, 158];
      const W = 10, T = 1.1, span = brick ? 12 : 10;
      for (let i = 0; i < 7000; i++) add((r() - 0.5) * LEN, (r() - 0.5) * W, H + 0.02 * r(), shade([92, 90, 86]));     // deck / ballast
      for (let i = 0; i < 4000; i++) { const s = r() < 0.5 ? -1 : 1; add((r() - 0.5) * LEN, s * W / 2, H - T + r() * (T + 1.0), shade(base)); } // girders + parapet
      // rails
      for (let i = 0; i < 1500; i++) { const y = (r() < 0.5 ? -1 : 1) * 0.53 + (r() < 0.5 ? -2.2 : 2.2); add((r() - 0.5) * LEN, y, H + 0.18, [190, 196, 204]); }
      if (brick) {
        const rr = span / 2 - 0.6, spring = H - T - rr - 0.2;
        for (let i = 0; i < 9000; i++) {
          const x = (r() - 0.5) * LEN, z = r() * (H - T), s = r() < 0.5 ? -1 : 1;
          const ax = x - (Math.floor(x / span) * span + span / 2);   // distance to arch centre
          const inOpen = (z <= spring && Math.abs(ax) < rr) || (z > spring && ax * ax + (z - spring) ** 2 < rr * rr);
          if (inOpen) continue;
          add(x, s * W / 2, z, shade(base, 34));
        }
        // arch ring sits at x = span/2 (+k*span); piers are around x = 0
        anchor = d.component === '架線柱' ? [0, W / 2 + 0.4, H + 4]
          : d.component === 'アーチ部' ? [span / 2, W / 2, spring + rr + 0.15] : [0, W / 2, spring * 0.8];
      } else {
        for (let k = -2; k <= 2; k++) {
          for (const y0 of [-(W / 2 - 1.6), W / 2 - 1.6]) {
            for (let i = 0; i < 700; i++) {
              const f = Math.floor(r() * 4), u = (r() - 0.5) * 1.2, z = r() * (H - T);
              const [x, y] = f === 0 ? [k * span - 0.6, y0 + u] : f === 1 ? [k * span + 0.6, y0 + u] : f === 2 ? [k * span + u, y0 - 0.6] : [k * span + u, y0 + 0.6];
              add(x, y, z, shade(base));
            }
          }
        }
        anchor = d.component === '橋脚' ? [0, W / 2 - 1.0, (H - T) * 0.55]
          : d.component === '高欄' ? [0, W / 2, H + 0.5]
          : d.component === '架線柱' ? [0, W / 2 + 0.4, H + 4] : [3, W / 2, H - T / 2];
      }
      // catenary poles
      for (let k = -1; k <= 1; k++) for (let i = 0; i < 300; i++) add(k * 25 + (r() - 0.5) * 0.35, W / 2 + 0.4 + (r() - 0.5) * 0.35, H + r() * 7, shade([120, 124, 128]));
    } else if (d.asset === 'bridge_steel') {
      const steel = [86, 112, 140];
      for (const y0 of [-1.6, 1.6]) {
        for (let i = 0; i < 3500; i++) {
          const x = (r() - 0.5) * LEN * 0.7, f = r();
          if (f < 0.6) add(x, y0, H - 2.2 + r() * 2.2, shade(steel));                       // web
          else add(x, y0 + (r() - 0.5) * 0.7, f < 0.8 ? H : H - 2.2, shade(steel));          // flanges
        }
      }
      for (let i = 0; i < 3000; i++) add((r() - 0.5) * LEN * 0.7, (r() - 0.5) * 4.6, H + 0.15, shade([90, 88, 84]));
      for (const sx of [-1, 1]) for (let i = 0; i < 2200; i++) add(sx * LEN * 0.35 + sx * r() * 4, (r() - 0.5) * 7, r() * H, shade([150, 152, 150]));
      for (let i = 0; i < 2500; i++) add((r() - 0.5) * LEN * 0.66, (r() - 0.5) * 30, -0.6, shade([30, 70, 110], 18));      // river
      anchor = d.component === '支承' ? [LEN * 0.35 - 0.5, 1.6, H - 2.4] : d.component === '橋台' ? [LEN * 0.35, -1, H * 0.5] : [2, 1.6, H - 1.4];
    } else {
      // earthwork: ballast + rails + retaining wall + slope + poles
      for (let i = 0; i < 5000; i++) add((r() - 0.5) * LEN, (r() - 0.5) * 6, 0.3 + r() * 0.1, shade([96, 90, 84]));
      for (let i = 0; i < 1500; i++) add((r() - 0.5) * LEN, (r() < 0.5 ? -1 : 1) * 0.53, 0.5, [190, 196, 204]);
      for (let i = 0; i < 6000; i++) add((r() - 0.5) * LEN, 6, r() * 4, shade([150, 150, 146]));
      for (let i = 0; i < 6000; i++) { const t = r(); add((r() - 0.5) * LEN, 6 + t * 7, 4 + t * 4, shade([54, 92, 60], 30)); }
      for (let k = -1; k <= 1; k++) for (let i = 0; i < 300; i++) add(k * 25 + (r() - 0.5) * 0.35, -3.6 + (r() - 0.5) * 0.35, r() * 8, shade([120, 124, 128]));
      anchor = d.component === '擁壁' ? [0, 6, 2] : d.component === '法面' ? [0, 9, 5.7] : d.component === '架線柱' ? [0, -3.6, 6.5] : [0, 0.53, 0.5];
      if (d.component === '架線柱') for (let i = 0; i < 300; i++) add((r() - 0.5) * 0.35 + r() * 0.3, -3.6 + (r() - 0.5) * 0.35, r() * 8, shade([120, 124, 128]));
    }

    // defect patch: recolour nearby points + add a dense cluster
    const gc = GCOL[d.grade[state.c] || 'B'];
    for (const q of pts) { const dx = q.p[0] - anchor[0], dy = q.p[1] - anchor[1], dz = q.p[2] - anchor[2]; if (dx * dx + dy * dy + dz * dz < 2.2) q.c = gc; }
    for (let i = 0; i < 600; i++) add(anchor[0] + (r() - 0.5) * 1.4, anchor[1] + (r() - 0.5) * 0.4, anchor[2] + (r() - 0.5) * 1.4, gc);

    // local (x along track, y right of track) -> east/north, defect anchor at origin
    const b = d.bearing * Math.PI / 180, sb = Math.sin(b), cb = Math.cos(b);
    for (const q of pts) {
      const x = q.p[0] - anchor[0], y = q.p[1] - anchor[1];
      q.p = [x * sb + y * cb, x * cb - y * sb, q.p[2]];
    }
    return { id: d.id, c: state.c, points: pts, anchorZ: anchor[2] };
  }

  // ------------------------------------------------------------------ deck.gl layers
  function sectionColor(s) {
    const c = state.c;
    if (state.compare) {
      if (c === 0) return [90, 110, 130, 200];
      const dv = s.risk[c] - s.risk[c - 1];
      return dv > 0.15 ? [255, 61, 87, 255] : dv > 0.05 ? [255, 166, 43, 255] : dv < -0.05 ? [56, 189, 248, 230] : [80, 96, 114, 200];
    }
    return [...CAT_COL[CAT(s.grade[c])], 255];
  }

  function renderLayers() {
    const c = state.c;
    const zb = state.zoom < 14 ? 0 : state.zoom < 16 ? 1 : 2;
    const pillar = [{ r: 55, h: 1500 }, { r: 14, h: 260 }, { r: 0, h: 0 }][zb];
    const selDef = state.sel && state.sel.kind === 'defect' ? state.sel.id : null;
    const selSec = state.sel ? (state.sel.kind === 'section' ? state.sel.id : defById.get(state.sel.id).section) : null;
    const present = D.defects.filter(d => d.obs[c]);
    const serious = present.filter(d => GRANK[d.grade[c]] <= GRANK.B);

    const layers = [];
    if (state.flights) {
      layers.push(new deck.PathLayer({
        id: 'flights', data: flights, getPath: f => f.path, getColor: f => f.id % 2 ? [56, 189, 248, 150] : [125, 211, 252, 110],
        getWidth: 1.6, widthUnits: 'pixels', jointRounded: true,
      }));
    }
    layers.push(new deck.PathLayer({
      id: 'sections', data: D.sections, getPath: s => s.path, getColor: sectionColor,
      getWidth: s => s.id === selSec ? 11 : (CAT(s.grade[c]) === 'green' && !state.compare ? 4 : 7),
      widthUnits: 'pixels', capRounded: true, jointRounded: true,
      pickable: true, autoHighlight: true, highlightColor: [56, 189, 248, 230],
      onClick: info => info.object && select('section', info.object.id),
      updateTriggers: { getColor: [c, state.compare], getWidth: [c, selSec, state.compare] },
    }));
    layers.push(new deck.ColumnLayer({
      // hidden at street level (zb 2): the dots + point cloud take over there
      id: 'pillars', data: zb === 2 ? [] : serious, diskResolution: 16, radius: pillar.r, extruded: true,
      getPosition: d => [d.lon, d.lat, d.z], getElevation: d => d.risk[c] * pillar.h,
      getFillColor: d => [...GCOL[d.grade[c]], d.id === selDef ? 255 : 200],
      pickable: true, onClick: info => info.object && select('defect', info.object.id),
      updateTriggers: { getElevation: [c], getFillColor: [c, selDef] },
      transitions: { getElevation: 500 },
    }));
    if (selDef && state.cloud && state.cloud.id === selDef) {
      const d = defById.get(selDef);
      layers.push(new deck.PointCloudLayer({
        id: 'cloud', data: state.cloud.points, coordinateSystem: deck.COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: [d.lon, d.lat, 0], getPosition: q => q.p, getColor: q => q.c, pointSize: 2.2, material: false,
      }));
    }
    layers.push(new deck.ScatterplotLayer({
      id: 'defects', data: present,
      getPosition: d => [d.lon, d.lat, (d.id === selDef && state.cloud && state.cloud.id === selDef) ? state.cloud.anchorZ : d.z + 0.3],
      getRadius: d => d.id === selDef ? 9 : GRANK[d.grade[c]] <= GRANK.A2 ? 6 : 4, radiusUnits: 'pixels',
      getFillColor: d => [...GCOL[d.grade[c]], 255], stroked: true, getLineColor: d => d.id === selDef ? [255, 255, 255] : [10, 14, 19],
      lineWidthUnits: 'pixels', getLineWidth: d => d.id === selDef ? 2.5 : 1.5, billboard: true,
      pickable: true, onClick: info => info.object && select('defect', info.object.id),
      updateTriggers: { getFillColor: [c], getRadius: [c, selDef], getLineColor: [selDef], getLineWidth: [selDef], getPosition: [selDef, state.cloud && state.cloud.id] },
    }));
    layers.push(new deck.ScatterplotLayer({
      id: 'stations', data: L.stations, getPosition: s => [s.lon, s.lat, 12], getRadius: 4.5, radiusUnits: 'pixels',
      getFillColor: [236, 241, 246], stroked: true, getLineColor: [12, 16, 22], lineWidthUnits: 'pixels', getLineWidth: 2, billboard: true,
    }));
    layers.push(new deck.TextLayer({
      id: 'station-labels', data: zb === 0 ? L.stations.filter(s => MAJOR.has(s.name)) : L.stations,
      getPosition: s => [s.lon, s.lat, 12], getText: s => stName(s.name), characterSet: 'auto', fontFamily: FONT, fontWeight: 700,
      getSize: zb === 0 ? 14 : 13, getColor: [232, 238, 244], getPixelOffset: [0, -16],
      fontSettings: { sdf: true }, outlineWidth: 5, outlineColor: [8, 11, 15, 235], billboard: true,
      updateTriggers: { getSize: [zb], getText: [lang] },
    }));
    overlay.setProps({ layers });
  }

  function getTooltip({ object, layer }) {
    if (!object || !layer) return null;
    const c = state.c;
    const style = { background: 'rgba(10,14,19,0.95)', color: '#e6edf3', border: '1px solid #2b3847', borderRadius: '8px', fontSize: '12px', padding: '8px 10px', maxWidth: '260px' };
    if (layer.id === 'sections') {
      const s = object;
      const n = s.defects.filter(id => defById.get(id).obs[c]).length;
      return { html: `<b>${s.id}</b> · ${between(s)}<br>${s.from_km.toFixed(1)}–${s.to_km.toFixed(1)} km · ${assetLabel(s) || assetName(s.asset)}<br>${J('区間リスク', 'Section risk')} <b>${s.risk[c].toFixed(2)}</b> (${s.grade[c]}) · ${J(`損傷 ${n}件`, `${n} defect${n === 1 ? '' : 's'}`)}`, style };
    }
    if (layer.id === 'defects' || layer.id === 'pillars') {
      const d = object, o = d.obs[c];
      return { html: `<b>${d.grade[c]}</b> · ${typeName(d.type)} (${compName(d.component)})<br>${d.km.toFixed(2)} km · ${between(secById.get(d.section))}<br>${J('リスク', 'Risk')} <b>${d.risk[c].toFixed(2)}</b> · ${J('AI確信度', 'AI confidence')} ${Math.round(o.conf * 100)}%`, style };
    }
    return null;
  }

  // ------------------------------------------------------------------ selection
  function select(kind, id, fly = true) {
    state.sel = id ? { kind, id } : null;
    document.body.classList.toggle('has-detail', !!state.sel);
    document.body.classList.remove('show-list');
    state.cloud = null;
    if (kind === 'defect' && id) {
      const d = defById.get(id);
      state.cloud = buildCloud(d);
      if (fly) map.flyTo({ center: [d.lon, d.lat], zoom: 18.7, pitch: 64, bearing: (d.bearing + 300) % 360 - 180, padding: padding(), duration: 2200, essential: true });
    } else if (kind === 'section' && id) {
      const s = secById.get(id);
      const mid = s.path[Math.floor(s.path.length / 2)];
      const a = s.path[0], b = s.path[s.path.length - 1];
      const brg = Math.atan2((b[0] - a[0]) * Math.cos(mid[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
      if (fly) map.flyTo({ center: [mid[0], mid[1]], zoom: 16.8, pitch: 58, bearing: brg - 70, padding: padding(), duration: 1800, essential: true });
    }
    renderAll();
  }

  // ------------------------------------------------------------------ left panel
  function renderLeft() {
    const c = state.c, cp = D.campaigns[c];
    const present = D.defects.filter(d => d.obs[c]);
    const by = { AA: 0, A1: 0, A2: 0, B: 0, C: 0, S: 0 };
    present.forEach(d => by[d.grade[c]]++);
    const fresh = c > 0 ? present.filter(d => !d.obs[c - 1]).length : 0;
    const prog = c > 0 ? present.filter(d => d.obs[c - 1] && d.obs[c].sev - d.obs[c - 1].sev >= 0.1).length : 0;

    $('campaignChip').textContent = `${cp.date} ${D.mock ? '· MOCK' : ''}`;
    const kept = fmt(Math.round(cp.frames * 0.21));
    const steps = EN(lang) ? [
      ['Data ingest', 'MP4 + SRT', `${cp.videos} videos · ${fmt(cp.images)} photos · ${cp.flights} flights`],
      ['Keyframe selection', 'OpenCV', `${fmt(cp.frames)} → ${kept} frames (blur & duplicates removed)`],
      ['3D reconstruction', 'SfM / MVS', `Point cloud & mesh · GSD ${cp.gsd_mm} mm/px`],
      ['AI damage detection', 'Detect + Seg', `${present.length} defect candidates (7 classes)`],
      ['Localisation', 'Georef / km', `${D.sections.length} sections × ${D.section_length_m} m, chainage assigned`],
      ['Assessment & priority', 'Risk', `AA ${by.AA} · A1 ${by.A1} · A2 ${by.A2} · B ${by.B}`],
    ] : [
      ['データ取込', 'Ingest', `動画 ${cp.videos}本 · 静止画 ${fmt(cp.images)}枚 · ${cp.flights}フライト`],
      ['フレーム選別', 'Keyframes', `${fmt(cp.frames)} → ${kept} 枚（ブレ・重複除去）`],
      ['3D再構築', 'SfM / MVS', `点群・メッシュ · GSD ${cp.gsd_mm} mm/px`],
      ['AI損傷検出', 'Detect + Seg', `損傷候補 ${present.length} 件（7クラス）`],
      ['位置特定', 'Georef / km', `${D.sections.length}区間 × ${D.section_length_m} m にキロ程付与`],
      ['評価・優先度', 'Risk', `AA ${by.AA} · A1 ${by.A1} · A2 ${by.A2} · B ${by.B}`],
    ];
    $('pipeline').innerHTML = steps.map(s => `<li><span class="st-name">${s[0]}</span><span class="st-en">${s[1]}</span><div class="st-out">${s[2]}</div></li>`).join('');

    $('kpis').innerHTML = [
      ['red', by.AA + by.A1, J('要対応 AA/A1', 'Action AA/A1')],
      ['orange', by.A2, J('計画補修 A2', 'Repair plan A2')],
      ['cyan', fresh, J('新規検出', 'New')],
      ['yellow', prog, J('進行あり', 'Worsening')],
    ].map(k => `<div class="kpi ${k[0]}"><div class="v">${k[1]}</div><div class="l">${k[2]}</div></div>`).join('');

    const list = present.slice().sort((a, b) => b.risk[c] - a.risk[c]).slice(0, 14);
    const selId = state.sel && state.sel.kind === 'defect' ? state.sel.id : null;
    $('prio').innerHTML = list.map(d => {
      const t = trendTag(d, c);
      return `<li data-id="${d.id}" class="${d.id === selId ? 'sel' : ''}">
        <span class="badge g-${d.grade[c]}">${d.grade[c]}</span>
        <div style="min-width:0"><div class="t">${typeName(d.type)} · ${compName(d.component)}</div>
        <div class="s">${between(secById.get(d.section))} · ${d.km.toFixed(2)} km</div></div>
        <div class="r">${d.risk[c].toFixed(2)}<div class="d ${t.cls}">${t.txt}</div></div></li>`;
    }).join('');
  }
  $('prio').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select('defect', li.dataset.id); });

  // ------------------------------------------------------------------ detail drawer
  function renderDetail() {
    const el = $('detail');
    if (!state.sel) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = state.sel.kind === 'defect' ? defectHTML(defById.get(state.sel.id)) : sectionHTML(secById.get(state.sel.id));
  }

  function defectHTML(d) {
    const c = state.c, o = d.obs[c], s = secById.get(d.section), ti = typeInfo(d.type);
    const trendTitle = `${J('推移', 'Trend')} · ${metric(d.type)} (${unit(d.type)})`;
    const head = (g) => `<div class="det-head"><span class="badge big g-${g || 'none'}">${g || '—'}</span>
      <div class="tt"><div class="det-title">${typeName(d.type)} <span class="muted small mono">${d.id}</span></div>
      <div class="det-sub">${assetLabel(s) || assetName(d.asset)} · ${compName(d.component)}</div></div>
      <button class="x" data-act="close" aria-label="${J('閉じる', 'Close')}">×</button></div>`;
    const where = `<dl class="kv"><dt>${J('位置', 'Location')}</dt><dd>${between(s)} · <span class="mono">${d.km.toFixed(3)} km</span></dd>
      <dt>${J('区間', 'Section')}</dt><dd><a href="#" data-act="section" data-id="${s.id}" style="color:var(--accent)">${s.id}</a> (${s.from_km.toFixed(1)}–${s.to_km.toFixed(1)} km)</dd>
      <dt>${J('座標', 'Coords')}</dt><dd class="mono">${d.lat.toFixed(6)}, ${d.lon.toFixed(6)} · h ${d.z} m</dd></dl>`;
    if (!o) {
      const firstC = d.obs.findIndex(Boolean);
      return head(null) + where + `<p class="empty">${J(`${campLabel(D.campaigns[c])}では未検出です（初検出: ${campLabel(D.campaigns[firstC])}）。`,
        `Not detected in the ${campLabel(D.campaigns[c])} (first detected: ${campLabel(D.campaigns[firstC])}).`)}</p>`
        + `<div class="blk"><h3>${trendTitle}</h3><div class="chart">${trendSVG(d)}</div></div>`;
    }
    const g = d.grade[c], gr = growth(d, c);
    const fr = o.frame;
    const mm = Math.floor(fr.t / 60), ss = (fr.t % 60).toFixed(1).padStart(4, '0');
    const meas = `${metric(d.type)} ${fmt(o.value, 1)} ${unit(d.type)}${o.width_mm != null ? ` · ${J('幅', 'width')} ${o.width_mm} mm` : ''}`;
    const note = noteText(d);
    return head(g) + where + `
      <figure class="frame">${frameSVG(d, c)}<figcaption>${fr.flight} · ${String(mm).padStart(2, '0')}:${ss} · 4K/30fps · AI ${Math.round(o.conf * 100)}%</figcaption></figure>
      <div class="blk"><h3>${J('計測値', 'Measurement')} (${campLabel(D.campaigns[c])})</h3><div>${meas}</div></div>
      <div class="blk"><h3>${trendTitle}</h3><div class="chart">${trendSVG(d)}</div></div>
      <div class="blk"><h3>${J('リスク内訳', 'Risk breakdown')}</h3>
        <div class="bars">
          ${bar(J('損傷の重大度', 'Severity'), o.sev)}${bar(J('進行度', 'Growth'), gr)}${bar(J('部材の重要度', 'Criticality'), d.crit)}
          <span><b>${J('リスク', 'Risk')}</b></span><div class="bar"><i style="width:${d.risk[c] * 100}%;background:${rgb(GCOL[g])}"></i></div><b class="mono">${d.risk[c].toFixed(2)}</b>
        </div>
        <div class="formula">${D.risk_formula}</div></div>
      <div class="blk"><h3>${J('推奨対応（AI提案）', 'Recommended action (AI proposal)')}</h3>
        <div class="action" style="border-left-color:${rgb(GCOL[g])}"><div class="a">${g}: ${gradeName(g)}</div><div>${gradeAction(g)}</div>
        ${note ? `<div class="muted small" style="margin-top:4px">${note}</div>` : ''}</div></div>
      <div class="btn-row">
        <button class="btn primary" data-act="confirm">${J('技術者確認', 'Engineer review')}</button>
        <button class="btn" data-act="wo">${J('作業指示を作成', 'Create work order')}</button>
        <button class="btn" data-act="cloud">${state.cloud ? J('点群を隠す', 'Hide point cloud') : J('点群を表示', 'Show point cloud')}</button>
      </div>
      <p class="note-ai">${J('※ AIの判定は候補の提示です。健全度の最終判定は検査技術者が行います。点群は再構築結果のイメージ（合成）です。',
        '* AI output is a proposal only. The final condition grade is decided by the inspection engineer. The point cloud is a synthetic illustration of the 3D reconstruction.')}</p>`;
  }
  function bar(label, v) {
    return `<span>${label}</span><div class="bar"><i style="width:${Math.round((v || 0) * 100)}%"></i></div><span class="mono">${(v || 0).toFixed(2)}</span>`;
  }

  function sectionHTML(s) {
    const c = state.c, g = s.grade[c];
    const defs = s.defects.map(id => defById.get(id));
    const bars = D.campaigns.map((cp, i) => {
      const h = Math.max(3, s.risk[i] * 60);
      return `<g transform="translate(${30 + i * 90},0)"><rect x="0" y="${70 - h}" width="44" height="${h}" rx="3" fill="${rgb(CAT_COL[CAT(s.grade[i])])}" opacity="${i === c ? 1 : 0.45}"/>
        <text x="22" y="${64 - h}" text-anchor="middle" fill="#e6edf3" font-size="11" font-family="JetBrains Mono">${s.risk[i].toFixed(2)}</text>
        <text x="22" y="86" text-anchor="middle" fill="#8a98a8" font-size="11" font-family="JetBrains Mono">${cp.id}</text></g>`;
    }).join('');
    return `<div class="det-head"><span class="badge big g-${g}">${g}</span>
      <div class="tt"><div class="det-title">${J('区間', 'Section')} ${s.id}</div><div class="det-sub">${between(s)}</div></div>
      <button class="x" data-act="close" aria-label="${J('閉じる', 'Close')}">×</button></div>
      <dl class="kv"><dt>${J('キロ程', 'Chainage')}</dt><dd class="mono">${s.from_km.toFixed(3)} – ${s.to_km.toFixed(3)} km</dd>
      <dt>${J('構造物', 'Structure')}</dt><dd>${assetLabel(s) ? assetLabel(s) + ' · ' : ''}${assetName(s.asset)}</dd>
      <dt>${J('施工基面高', 'Track level')}</dt><dd>${s.height_m} m ${J('（概略）', '(approx.)')}</dd></dl>
      <div class="blk"><h3>${J('区間リスクの推移', 'Section risk trend')}</h3><div class="chart"><svg viewBox="0 0 300 92">${bars}</svg></div></div>
      <div class="blk"><h3>${J(`この区間の損傷（${defs.length}件）`, `Defects in this section (${defs.length})`)}</h3>
      ${defs.length ? `<ul class="dlist">${defs.map(d => `<li data-act="defect" data-id="${d.id}">
        <span class="badge g-${d.grade[c] || 'none'}">${d.grade[c] || '—'}</span>
        <span class="grow">${typeName(d.type)} · ${compName(d.component)}<br><span class="muted small">${d.km.toFixed(3)} km · ${d.id}</span></span>
        <span class="mono">${d.risk[c] != null ? d.risk[c].toFixed(2) : J('未検出', 'not detected')}</span></li>`).join('')}</ul>` : `<p class="empty">${J('損傷の検出はありません。', 'No defects detected.')}</p>`}</div>
      <p class="note-ai">${J('区間リスク = 区間内損傷リスクの最大値。', 'Section risk = highest defect risk within the section.')}</p>`;
  }

  $('detail').addEventListener('click', e => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    e.preventDefault();
    const act = t.dataset.act;
    if (act === 'close') select(null, null);
    else if (act === 'section') select('section', t.dataset.id);
    else if (act === 'defect') select('defect', t.dataset.id);
    else if (act === 'confirm') toast(J('技術者確認キューに追加しました（デモ）', 'Added to the engineer review queue (demo)'));
    else if (act === 'wo') toast(J(`作業指示 WO-${state.sel.id.slice(2)} を下書き作成しました（デモ）`, `Draft work order WO-${state.sel.id.slice(2)} created (demo)`));
    else if (act === 'cloud') {
      state.cloud = state.cloud ? null : buildCloud(defById.get(state.sel.id));
      renderLayers(); renderDetail();
    }
  });

  // ------------------------------------------------------------------ small SVGs
  function trendSVG(d) {
    const ti = typeInfo(d.type), W = 300, H = 120, padL = 30, padR = 20, top = 22, bot = 26;
    const vals = d.obs.map(o => o ? o.value : null);
    const max = Math.max(...vals.filter(v => v != null)) * 1.2 || 1;
    const X = i => padL + i * (W - padL - padR) / Math.max(1, NC - 1);
    const Y = v => top + (1 - v / max) * (H - top - bot);
    let path = '', started = false;
    vals.forEach((v, i) => { if (v == null) { started = false; return; } path += `${started ? 'L' : 'M'}${X(i)},${Y(v)} `; started = true; });
    const g = d.grade[state.c] || 'B';
    const col = rgb(GCOL[g]);
    const pts = vals.map((v, i) => v == null
      ? `<text x="${X(i)}" y="${H - bot - 6}" text-anchor="middle" fill="#5b6878" font-size="10">${J('未検出', 'not detected')}</text>`
      : `<circle cx="${X(i)}" cy="${Y(v)}" r="${i === state.c ? 5 : 3.5}" fill="${i === state.c ? col : '#0e131a'}" stroke="${col}" stroke-width="2"/>
         <text x="${X(i)}" y="${Y(v) - 10}" text-anchor="middle" fill="#e6edf3" font-size="11" font-family="JetBrains Mono">${fmt(v, v < 10 ? 1 : 0)}</text>
         ${d.obs[i].width_mm != null ? `<text x="${X(i)}" y="${Y(v) + 18}" text-anchor="middle" fill="#8a98a8" font-size="9.5" font-family="JetBrains Mono">w${d.obs[i].width_mm}</text>` : ''}`).join('');
    const xl = D.campaigns.map((cp, i) => `<text x="${X(i)}" y="${H - 6}" text-anchor="middle" fill="${i === state.c ? '#e6edf3' : '#8a98a8'}" font-size="11" font-family="JetBrains Mono">${cp.id}</text>`).join('');
    const band = `<rect x="${X(state.c) - 26}" y="4" width="52" height="${H - 10}" rx="6" fill="rgba(56,189,248,0.07)"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${metric(d.type)} ${J('の推移', 'trend')}">${band}
      <line x1="${padL - 10}" x2="${W - padR + 10}" y1="${H - bot}" y2="${H - bot}" stroke="#2b3847"/>
      <path d="${path}" fill="none" stroke="${col}" stroke-width="2"/>${pts}${xl}</svg>`;
  }

  // Simulated drone frame with an AI bounding box (stand-in for the real image crop)
  function frameSVG(d, c) {
    const r = rng(hash(d.id + 'f')), W = 320, H = 180, o = d.obs[c];
    const steel = ['主桁（鋼）', '支承', '架線柱'].includes(d.component);
    const brick = d.asset === 'viaduct_brick' && !steel;
    const baseCol = steel ? '#5a6876' : brick ? '#8a4c38' : d.component === '法面' ? '#4d5f45' : '#8e9296';
    let s = `<rect width="${W}" height="${H}" fill="${baseCol}"/>`;
    for (let i = 0; i < 260; i++) s += `<rect x="${(r() * W).toFixed(1)}" y="${(r() * H).toFixed(1)}" width="${(1 + r() * 3).toFixed(1)}" height="${(1 + r() * 3).toFixed(1)}" fill="${r() < 0.5 ? '#000' : '#fff'}" opacity="${(0.05 + r() * 0.12).toFixed(2)}"/>`;
    if (brick) for (let y = 0; y < H; y += 14) { s += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#d6c7b8" stroke-opacity=".35"/>`; for (let x = (y / 14) % 2 ? 0 : 20; x < W; x += 40) s += `<line x1="${x}" x2="${x}" y1="${y}" y2="${y + 14}" stroke="#d6c7b8" stroke-opacity=".35"/>`; }
    const cx = 150 + (r() - 0.5) * 40, cy = 92 + (r() - 0.5) * 20;
    let bx = cx - 70, by = cy - 48, bw = 140, bh = 96;
    const sevW = o ? o.sev : 0.4;
    switch (d.type) {
      case 'crack': {
        let x = cx - 62, y = cy - 36, p = `M${x},${y}`;
        while (x < cx + 62) { x += 6 + r() * 8; y += (r() - 0.35) * 9; p += ` L${x.toFixed(1)},${y.toFixed(1)}`; }
        s += `<path d="${p}" fill="none" stroke="#141414" stroke-width="${(1 + (o && o.width_mm ? o.width_mm * 3 : 1)).toFixed(1)}" stroke-linejoin="round"/>`;
        s += `<path d="M${cx - 10},${cy - 8} l12,18 l-4,14 l9,12" fill="none" stroke="#1a1a1a" stroke-width="1.2"/>`;
        break;
      }
      case 'spalling': case 'rebar': {
        let p = ''; const n = 14, R0 = 30 + sevW * 22;
        for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, rr = R0 * (0.7 + r() * 0.5); p += `${i ? 'L' : 'M'}${(cx + Math.cos(a) * rr * 1.3).toFixed(1)},${(cy + Math.sin(a) * rr * 0.85).toFixed(1)} `; }
        s += `<path d="${p}Z" fill="#b9b5ad" stroke="#55524d" stroke-width="2"/>`;
        if (d.type === 'rebar') for (let k = -1; k <= 1; k++) s += `<line x1="${cx - 40}" x2="${cx + 40}" y1="${cy + k * 12}" y2="${cy + k * 12 + 3}" stroke="#7a3d17" stroke-width="5" stroke-linecap="round"/>`;
        break;
      }
      case 'rust':
        for (let i = 0; i < 26; i++) s += `<ellipse cx="${(cx + (r() - 0.5) * 110).toFixed(1)}" cy="${(cy + (r() - 0.5) * 60).toFixed(1)}" rx="${(4 + r() * 16 * (0.5 + sevW)).toFixed(1)}" ry="${(3 + r() * 9).toFixed(1)}" fill="${r() < 0.5 ? '#8a3b12' : '#b5561e'}" opacity="${(0.55 + r() * 0.4).toFixed(2)}"/>`;
        break;
      case 'leak':
        s += `<ellipse cx="${cx}" cy="${cy}" rx="62" ry="44" fill="#3e4348" opacity=".55"/>`;
        for (let i = 0; i < 9; i++) { const x = cx - 50 + r() * 100; s += `<path d="M${x.toFixed(1)},${cy - 40} q${(r() * 6 - 3).toFixed(1)},40 ${(r() * 4 - 2).toFixed(1)},${(60 + r() * 30).toFixed(1)}" stroke="#ece7da" stroke-width="${(1.5 + r() * 2.5).toFixed(1)}" fill="none" opacity=".8"/>`; }
        break;
      case 'deform':
        s += `<line x1="${cx}" x2="${cx}" y1="8" y2="${H - 8}" stroke="#38bdf8" stroke-dasharray="5 4" stroke-width="1.5"/>`;
        s += `<g transform="rotate(${(3 + sevW * 6).toFixed(1)} ${cx} ${H - 8})"><rect x="${cx - 9}" y="10" width="18" height="${H - 18}" fill="#3a4148"/></g>`;
        bx = cx - 40; bw = 80; by = 10; bh = H - 20;
        break;
      case 'missing':
        for (let i = 0; i < 6; i++) { const x = cx - 75 + i * 30; s += `<rect x="${x - 10}" y="${cy - 14}" width="20" height="28" fill="#4b4e52"/>`; if (i !== 3) s += `<circle cx="${x}" cy="${cy}" r="6" fill="#a7abb0" stroke="#2a2d30"/>`; }
        s += `<rect x="${cx - 75}" y="${cy + 18}" width="170" height="6" fill="#c8ccd1"/>`;
        bx = cx + 5 - 22; by = cy - 26; bw = 44; bh = 52;
        break;
    }
    const g = o ? d.grade[c] : 'B', col = rgb(GCOL[g]);
    const lbl = `${typeInfo(d.type).en} ${o ? Math.round(o.conf * 100) : '--'}%`;
    s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${col}" stroke-width="2.5"/>`;
    s += `<rect x="${bx}" y="${by - 17}" width="${lbl.length * 6.6 + 10}" height="17" fill="${col}"/><text x="${bx + 5}" y="${by - 5}" font-size="11" font-family="JetBrains Mono" fill="#0a0e13" font-weight="600">${lbl}</text>`;
    s += `<text x="8" y="16" font-size="10" font-family="JetBrains Mono" fill="#fff" opacity=".85">● REC ${o ? o.frame.flight : ''}</text>`;
    s += `<text x="${W - 8}" y="${H - 8}" font-size="10" font-family="JetBrains Mono" fill="#fff" opacity=".85" text-anchor="end">GSD ${D.campaigns[c].gsd_mm}mm</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${J('ドローン画像（模擬）', 'Drone frame (simulated)')}">${s}</svg>`;
  }

  // ------------------------------------------------------------------ kilometre strip
  function renderStrip() {
    const c = state.c, T = L.length_m / 1000;
    const selSec = state.sel ? (state.sel.kind === 'section' ? state.sel.id : defById.get(state.sel.id).section) : null;
    $('stripLen').textContent = `0 – ${T.toFixed(1)} km`;
    $('stripTrack').innerHTML = D.sections.map(s => {
      const col = sectionColor(s);
      return `<b data-id="${s.id}" class="${s.id === selSec ? 'sel' : ''}" title="${s.id} ${between(s)}" style="left:${s.from_km / T * 100}%;width:${(s.to_km - s.from_km) / T * 100}%;background:${rgb(col.slice(0, 3))}"></b>`;
    }).join('');
    $('stripMarks').innerHTML = D.defects.filter(d => d.obs[c] && GRANK[d.grade[c]] <= GRANK.A2)
      .map(d => `<i style="left:${d.km / T * 100}%;color:${rgb(GCOL[d.grade[c]])}" title="${d.id}"></i>`).join('');
    $('stripLabels').innerHTML = L.stations.map(st => `<span class="${MAJOR.has(st.name) ? 'major' : 'minor'}" style="left:${st.km / T * 100}%">${stName(st.name)}</span>`).join('');
  }
  $('stripTrack').addEventListener('click', e => { const b = e.target.closest('b[data-id]'); if (b) select('section', b.dataset.id); });

  // ------------------------------------------------------------------ legend / header
  function renderLegend() {
    const item = (col, txt, cls = '') => `<span class="lg"><i class="${cls}" style="background:${col}"></i>${txt}</span>`;
    $('legend').innerHTML = state.compare
      ? item(rgb([255, 61, 87]), J('悪化 大（Δ&gt;0.15）', 'Much worse (Δ&gt;0.15)')) + item(rgb([255, 166, 43]), J('悪化', 'Worse'))
        + item(rgb([80, 96, 114]), J('変化なし', 'No change')) + item(rgb([56, 189, 248]), J('改善', 'Improved'))
      : item(rgb(CAT_COL.red), J('要対応 AA/A1', 'Action AA/A1')) + item(rgb(CAT_COL.orange), J('計画補修 A2', 'Repair plan A2'))
        + item(rgb(CAT_COL.yellow), J('監視 B', 'Monitor B')) + item(rgb(CAT_COL.green), J('健全・軽微 C/S', 'Sound / minor C/S'))
        + item('#8a98a8', J('柱の高さ = リスク', 'Column height = risk'), 'col')
        + (state.flights ? item('rgb(56,189,248)', J('ドローン飛行ルート', 'Drone flight path')) : '');
  }

  // static texts in index.html carry data-i18n="key"
  function applyStaticText() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
    $('btnLang').textContent = tr('langBtn');
    $('btnLang').title = tr('langTitle');
    $('subtitle').textContent = EN(lang)
      ? `${D.line.name_en || D.line.name} (Tokyo) · ${(L.length_m / 1000).toFixed(1)} km · ${L.stations.length} stations · Drone × AI Inspection — Concept Demo`
      : `${D.line.name}（${D.line.city}）· ${(L.length_m / 1000).toFixed(1)} km · ${L.stations.length}駅 · Drone × AI Inspection — Concept Demo`;
    [...$('campaigns').children].forEach((b, i) => { b.title = campLabel(D.campaigns[i]); });
  }
  $('campaigns').innerHTML = D.campaigns.map((cp, i) => `<button type="button" role="tab" data-i="${i}">${cp.id}</button>`).join('');
  $('btnLang').addEventListener('click', () => {
    lang = EN(lang) ? 'ja' : 'en';
    try { localStorage.setItem('railDemo.lang', lang); } catch (e) { /* storage blocked */ }
    applyStaticText();
    renderAll();
  });
  $('campaigns').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    state.c = +b.dataset.i;
    if (state.cloud) state.cloud = buildCloud(defById.get(state.cloud.id));
    renderAll();
  });
  $('tCompare').addEventListener('change', e => { state.compare = e.target.checked; renderAll(); });
  $('tFlights').addEventListener('change', e => { state.flights = e.target.checked; renderAll(); });
  $('tBldg').addEventListener('change', e => { state.buildings = e.target.checked; if (map.getLayer('bldg-3d')) map.setLayoutProperty('bldg-3d', 'visibility', state.buildings ? 'visible' : 'none'); });
  $('btnHome').addEventListener('click', () => { select(null, null, false); home(); });
  $('btnList').addEventListener('click', () => document.body.classList.toggle('show-list'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.sel) select(null, null); });

  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2400); }

  function renderAll() {
    [...$('campaigns').children].forEach((b, i) => b.setAttribute('aria-selected', String(i === state.c)));
    renderLayers(); renderLeft(); renderDetail(); renderStrip(); renderLegend();
  }

  applyStaticText();
  renderAll();

  // debug / presentation hooks (e.g. ?defect=D-0001)
  window.__railDemo = { map, state, select };
  const q = new URLSearchParams(location.search);
  if (q.get('campaign')) { const i = D.campaigns.findIndex(cp => cp.id === q.get('campaign')); if (i >= 0) { state.c = i; renderAll(); } }
  if (q.get('defect') && defById.has(q.get('defect'))) select('defect', q.get('defect'));
  else if (q.get('section') && secById.has(q.get('section'))) select('section', q.get('section'));
})();
