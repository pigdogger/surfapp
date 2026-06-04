/* CaliSurf Light public app · west coast model V1.8 · no build step. */
(() => {
  const DEFAULT_CONFIG = {
    data_base_url: "https://raw.githubusercontent.com/pigdogger/surfapp/main/public/data",
    theme: { bg: "#071622", panel: "#0e2434", accent: "#1bb8d4", accent2: "#ff7f50" },
    marker_size: 7,
    marker_color_mode: "rating",
    typography_scale: 1,
    corner_radius: 8,
    edge_buffer: 22,
    mobile_detail_scale: 0.92,
    layout: "full",
    default_region: "san-diego",
    wave_layer_enabled: true,
    wave_layer_opacity: 0.44,
    wave_animation_ms: 1150,
    show_wave_direction_arrows: true,
    wind_layer_enabled: true,
    wind_layer_opacity: 0.70,
    wind_particle_density: 1.0,
    auto_scroll_selected_list: false,
    auto_scroll_region_chips: false,
    supabase: { enabled: false, url: "", anon_key: "" },
    show_cards: { swell: true, wind: true, tide: true, sun: true, confidence: true, model: true, hourly: true, five_day: true, warnings: true },
    show_swell_arrows: true,
    show_wind_arrows: true,
    hidden_spot_ids: [],
    added_spots: []
  };

  const REGION_DEFS = {
    "all": { label: "All CA", center: [36.2, -121.2], zoom: 6, match: () => true },
    "san-diego": { label: "San Diego", center: [32.86, -117.27], zoom: 10, match: s => Number(s.lat) < 33.35 },
    "orange-county": { label: "Orange County", center: [33.62, -117.93], zoom: 10, match: s => Number(s.lat) >= 33.35 && Number(s.lat) < 33.90 },
    "los-angeles": { label: "Los Angeles", center: [33.98, -118.55], zoom: 9, match: s => Number(s.lat) >= 33.90 && Number(s.lat) < 34.35 },
    "ventura-sb": { label: "Ventura / SB", center: [34.32, -119.25], zoom: 8, match: s => ["Ventura / Santa Barbara"].includes(s.region) || (Number(s.lat) >= 34.35 && Number(s.lat) < 35.4) },
    "central-coast": { label: "Central Coast", center: [35.45, -120.9], zoom: 8, match: s => s.region === "Central Coast" || (Number(s.lat) >= 35.4 && Number(s.lat) < 36.3) },
    "monterey-bay": { label: "Monterey Bay", center: [36.75, -121.95], zoom: 9, match: s => s.region === "Monterey Bay" || (Number(s.lat) >= 36.3 && Number(s.lat) < 37.1) },
    "bay-area": { label: "Bay Area", center: [37.65, -122.55], zoom: 8, match: s => s.region === "San Francisco / Marin" || (Number(s.lat) >= 37.1 && Number(s.lat) < 38.4) },
    "north-coast": { label: "North Coast", center: [40.45, -124.15], zoom: 7, match: s => Number(s.lat) >= 38.4 }
  };

  const state = {
    config: clone(DEFAULT_CONFIG),
    spots: [],
    forecasts: {},
    latest: null,
    waveGrid: null,
    windGrid: null,
    waveFrameIndex: 0,
    windFrameIndex: 0,
    waveTimer: null,
    waveRaf: 0,
    windRaf: 0,
    wavePlaying: true,
    windPlaying: true,
    selectedId: null,
    region: "san-diego",
    search: "",
    map: null,
    markerLayer: null,
    waveLayer: null,
    windLayer: null,
    windParticles: [],
    markers: new Map(),
    supabaseClient: null,
    deferredInstall: null,
    waitingWorker: null
  };

  const $ = id => document.getElementById(id);
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function mergeDeep(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    if (!override || typeof override !== "object") return out;
    for (const [key, value] of Object.entries(override)) {
      if (value && typeof value === "object" && !Array.isArray(value)) out[key] = mergeDeep(out[key] || {}, value);
      else out[key] = value;
    }
    return out;
  }

  async function fetchJson(baseUrl, name, opts = {}) {
    const clean = (baseUrl || "./data").replace(/\/$/, "");
    const res = await fetch(`${clean}/${name}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      if (opts.optional) return null;
      throw new Error(`${name} ${res.status}`);
    }
    return res.json();
  }

  async function loadConfig() {
    let config = clone(DEFAULT_CONFIG);
    try { config = mergeDeep(config, await fetchJson("./data", "site_config.json")); } catch (_) {}
    try {
      const fromAdmin = JSON.parse(localStorage.getItem("surfAppAdminConfig") || "null");
      if (fromAdmin) config = mergeDeep(config, fromAdmin);
    } catch (_) {}
    state.config = config;
    state.region = config.default_region || "san-diego";
    applyConfig(config);
  }

  function applyConfig(config) {
    const root = document.documentElement;
    root.style.setProperty("--bg", config.theme?.bg || DEFAULT_CONFIG.theme.bg);
    root.style.setProperty("--panel", config.theme?.panel || DEFAULT_CONFIG.theme.panel);
    root.style.setProperty("--accent", config.theme?.accent || DEFAULT_CONFIG.theme.accent);
    root.style.setProperty("--accent-2", config.theme?.accent2 || DEFAULT_CONFIG.theme.accent2);
    root.style.setProperty("--marker-size", `${Number(config.marker_size || 7)}px`);
    root.style.setProperty("--base-font-scale", Number(config.typography_scale || 1));
    root.style.setProperty("--corner-radius", `${Number(config.corner_radius ?? 8)}px`);
    root.style.setProperty("--edge-buffer", `${Number(config.edge_buffer ?? 22)}px`);
    root.style.setProperty("--mobile-detail-scale", Number(config.mobile_detail_scale ?? 0.92));
    root.style.setProperty("--wind-layer-opacity", Number(config.wind_layer_opacity ?? 0.70));
    document.body.classList.toggle("compact-layout", config.layout === "compact");
  }

  function allSpots() {
    return [...state.spots, ...(state.config.added_spots || [])].sort((a, b) => Number(a.lat) - Number(b.lat));
  }

  function activeSpots() {
    const hidden = new Set(state.config.hidden_spot_ids || []);
    return allSpots().filter(s => s.active !== false && !hidden.has(s.id));
  }

  function regionMatch(spot) {
    const def = REGION_DEFS[state.region] || REGION_DEFS.all;
    return def.match(spot);
  }

  function filteredSpots() {
    const q = state.search.trim().toLowerCase();
    return activeSpots().filter(s => {
      const qOk = !q || s.name.toLowerCase().includes(q) || (s.region || "").toLowerCase().includes(q);
      return regionMatch(s) && qOk;
    });
  }

  function mapSpots() {
    // Always show every active spot on the map. Region selection only dims spots outside the selected region.
    return activeSpots();
  }

  function preservePagePosition(fn) {
    const x = window.scrollX, y = window.scrollY;
    const result = fn();
    requestAnimationFrame(() => window.scrollTo(x, y));
    setTimeout(() => window.scrollTo(x, y), 0);
    return result;
  }

  function forecastFor(spotId) { return state.forecasts[spotId] || null; }

  function initMap() {
    if (!window.L) {
      $("map").innerHTML = `<div class="empty-state">Map library did not load. The spot list still works.</div>`;
      return;
    }
    const def = REGION_DEFS[state.region] || REGION_DEFS["san-diego"];
    state.map = L.map("map", { zoomControl: true, scrollWheelZoom: true, attributionControl: false, preferCanvas: true }).setView(def.center, def.zoom);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 13 }).addTo(state.map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 13 }).addTo(state.map);
    state.markerLayer = L.layerGroup().addTo(state.map);
    initWaveLayer();
    initWindLayer();
    drawMarkers({ fit: true });
  }

  function colorForValue(v, stops) {
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i];
      if (v <= b[0]) {
        const t = Math.max(0, Math.min(1, (v - a[0]) / (b[0] - a[0] || 1)));
        return mixHex(a[1], b[1], t);
      }
    }
    return stops[stops.length - 1][1];
  }

  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
    const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
    const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
  }

  function waveColor(ft) {
    return colorForValue(Number(ft || 0), [[0, "#294c8f"], [2, "#1eb6d0"], [4, "#22c55e"], [6, "#fde047"], [9, "#f97316"], [13, "#ef4444"], [18, "#d946ef"]]);
  }

  function scoreColor(score) {
    return colorForValue(Number(score || 0), [[0, "#c43b4d"], [0.42, "#f08b39"], [0.62, "#f4c542"], [0.78, "#74d66c"], [1, "#1ecb78"]]);
  }

  function markerColorFor(spotId) {
    const fc = forecastFor(spotId);
    const mode = state.config.marker_color_mode || "rating";
    if (!fc) return state.config.theme?.accent2 || "#ff7f50";
    if (mode === "wave_size") {
      return waveColor(fc.surf_height_ft?.max || 0);
    }
    if (["morning", "afternoon", "evening"].includes(mode)) {
      return scoreColor(windowScore(fc.hourly || [], mode));
    }
    const rating = String(fc.rating || "unknown").toLowerCase();
    if (rating.includes("good")) return "#1ecb78";
    if (rating.includes("fair")) return "#f4c542";
    if (rating.includes("poor")) return "#e05b52";
    if (rating.includes("flat")) return "#8da2af";
    return state.config.theme?.accent2 || "#ff7f50";
  }

  function windowScore(rows, mode) {
    const windows = { morning: [5, 9], afternoon: [10, 15], evening: [16, 21] };
    const [start, end] = windows[mode] || [5, 9];
    const scored = rows.map(r => {
      const hour = localHour(r.time);
      if (hour < start || hour > end) return null;
      const h = (Number(r.surf_min_ft || 0) + Number(r.surf_max_ft || 0)) / 2;
      const wind = Number(r.wind_speed_kt || 16);
      const tide = Number(r.tide_level_ft || 0);
      const windQ = r.wind_quality === "clean" ? 0.95 : r.wind_quality === "fair" ? 0.70 : r.wind_quality === "bumpy" ? 0.42 : 0.25;
      const tideQ = tide >= 1 && tide <= 4.8 ? 0.85 : 0.5;
      return Math.max(0, Math.min(1, h / 7 * 0.45 + windQ * 0.40 + tideQ * 0.15 - Math.max(0, wind - 12) * 0.015));
    }).filter(v => v !== null);
    return scored.length ? Math.max(...scored) : 0.3;
  }

  function markerHtml(spot) {
    const spotId = typeof spot === "string" ? spot : spot.id;
    const outOfRegion = typeof spot === "object" && state.region !== "all" && !regionMatch(spot) && spotId !== state.selectedId;
    const color = outOfRegion ? "#73818a" : markerColorFor(spotId);
    const active = spotId === state.selectedId ? "active" : "";
    const dim = outOfRegion ? "is-dim" : "";
    return `<div class="spot-marker ${active} ${dim}" style="--marker-color:${color};--marker-glow:${hexToRgba(color, .30)}"></div>`;
  }

  function hexToRgba(hex, alpha) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return `rgba(255,127,80,${alpha})`;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  function markerIcon(spot) {
    const spotId = typeof spot === "string" ? spot : spot.id;
    const size = Number(state.config.marker_size || 7) + (spotId === state.selectedId ? 5 : 0);
    return L.divIcon({ className: "", html: markerHtml(spot), iconSize: [size + 14, size + 14], iconAnchor: [(size + 14) / 2, (size + 14) / 2] });
  }

  function drawMarkers(opts = {}) {
    if (!state.map || !state.markerLayer) return;
    state.markerLayer.clearLayers();
    state.markers.clear();
    mapSpots().forEach(spot => {
      const marker = L.marker([spot.lat, spot.lon], { icon: markerIcon(spot), title: spot.name });
      marker.on("click", () => preservePagePosition(() => selectSpot(spot.id, true, false)));
      marker.addTo(state.markerLayer);
      state.markers.set(spot.id, marker);
    });
    if (opts.fit) moveMapToRegion({ fit: true });
  }

  function refreshMarkerIcons() {
    const byId = new Map(allSpots().map(s => [s.id, s]));
    state.markers.forEach((marker, spotId) => marker.setIcon(markerIcon(byId.get(spotId) || spotId)));
  }

  function moveMapToRegion(opts = {}) {
    if (!state.map) return;
    const visible = filteredSpots();
    if (visible.length && opts.fit !== false) {
      const bounds = L.latLngBounds(visible.map(s => [s.lat, s.lon]));
      state.map.fitBounds(bounds, { padding: [44, 44], maxZoom: (state.region === "all" ? 7 : 10) });
      return;
    }
    const def = REGION_DEFS[state.region] || REGION_DEFS["san-diego"];
    state.map.setView(def.center, def.zoom, { animate: true });
  }

  function initWaveLayer() {
    if (!state.map || !window.L) return;
    const WaveCanvasLayer = L.Layer.extend({
      onAdd(map) {
        this._map = map;
        this._canvas = L.DomUtil.create("canvas", "wave-grid-canvas leaflet-layer");
        this._ctx = this._canvas.getContext("2d");
        map.getPanes().overlayPane.appendChild(this._canvas);
        map.on("move zoom resize", this._reset, this);
        this._reset();
      },
      onRemove(map) {
        map.off("move zoom resize", this._reset, this);
        if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      },
      _reset() {
        const map = this._map, size = map.getSize();
        this._canvas.width = size.x;
        this._canvas.height = size.y;
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
        this.redraw();
      },
      redraw() { drawWaveLayerCanvas(this._ctx, this._canvas, this._map); }
    });
    state.waveLayer = new WaveCanvasLayer();
    if (state.config.wave_layer_enabled !== false) state.waveLayer.addTo(state.map);
    startWaveAnimation();
  }

  function currentWaveFrame() {
    const frames = state.waveGrid?.frames || [];
    return frames.length ? frames[state.waveFrameIndex % frames.length] : null;
  }

  function drawWaveLayerCanvas(ctx, canvas, map) {
    if (!ctx || !canvas || !map) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const frame = currentWaveFrame();
    if (!frame || !Array.isArray(frame.points)) return;
    const opacity = Math.max(0, Math.min(0.85, Number(state.config.wave_layer_opacity ?? 0.44)));
    const t = performance.now() / 1000;
    ctx.save();
    ctx.globalAlpha = opacity;
    const zoom = map.getZoom();
    const baseRadius = Math.max(24, Math.min(74, zoom * 5.1));
    for (const p of frame.points) {
      const pt = map.latLngToContainerPoint([p.lat, p.lon]);
      const pulse = 0.92 + 0.10 * Math.sin(t * 2.4 + Number(p.lat || 0) * .73 + Number(p.lon || 0) * .31);
      const radius = baseRadius * pulse;
      if (pt.x < -radius || pt.y < -radius || pt.x > canvas.width + radius || pt.y > canvas.height + radius) continue;
      const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
      const color = waveColor(p.height_ft);
      grad.addColorStop(0, color);
      grad.addColorStop(0.72, hexToRgba(color, 0.55));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (state.config.show_wave_direction_arrows === false) return;
    ctx.save();
    ctx.globalAlpha = Math.min(0.76, opacity + 0.18);
    ctx.strokeStyle = "rgba(255,255,255,.82)";
    ctx.fillStyle = "rgba(255,255,255,.82)";
    ctx.lineWidth = 1.3;
    frame.points.forEach((p, i) => {
      if (i % 3 !== 0 || p.direction_deg == null) return;
      const pt = map.latLngToContainerPoint([p.lat, p.lon]);
      if (pt.x < 0 || pt.y < 0 || pt.x > canvas.width || pt.y > canvas.height) return;
      drawWaveArrow(ctx, pt.x, pt.y, p.direction_deg, Math.max(9, Math.min(18, 5 + Number(p.height_ft || 0) * 2)));
    });
    ctx.restore();
  }

  function drawWaveArrow(ctx, x, y, fromDeg, len) {
    // Open-Meteo wave direction is where waves come from. Draw the motion toward shore/opposite direction.
    const rad = ((Number(fromDeg) + 180) - 90) * Math.PI / 180;
    const x2 = x + Math.cos(rad) * len;
    const y2 = y + Math.sin(rad) * len;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    const head = 4.5;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(rad - 0.55) * head, y2 - Math.sin(rad - 0.55) * head);
    ctx.lineTo(x2 - Math.cos(rad + 0.55) * head, y2 - Math.sin(rad + 0.55) * head);
    ctx.closePath(); ctx.fill();
  }

  function startWaveAnimation() {
    stopWaveAnimation();
    if (!state.wavePlaying) return;
    state.waveTimer = setInterval(() => {
      const frames = state.waveGrid?.frames || [];
      if (frames.length) {
        state.waveFrameIndex = (state.waveFrameIndex + 1) % frames.length;
        updateWaveFrameLabel();
      }
    }, Number(state.config.wave_animation_ms || 1150));
    const loop = () => {
      if (!state.wavePlaying) return;
      state.waveLayer?.redraw?.();
      state.waveRaf = requestAnimationFrame(loop);
    };
    state.waveRaf = requestAnimationFrame(loop);
  }

  function stopWaveAnimation() {
    if (state.waveTimer) clearInterval(state.waveTimer);
    state.waveTimer = null;
    if (state.waveRaf) cancelAnimationFrame(state.waveRaf);
    state.waveRaf = 0;
  }

  function updateWaveFrameLabel() {
    const frame = currentWaveFrame();
    const el = $("waveFrameLabel");
    if (!el) return;
    el.textContent = frame ? `waves ${fmtDateTime(frame.time)}` : "24h wave animation";
  }

  function setWaveLayerVisible(on) {
    state.config.wave_layer_enabled = on;
    if (!state.map || !state.waveLayer) return;
    if (on) {
      if (!state.map.hasLayer(state.waveLayer)) state.waveLayer.addTo(state.map);
      state.waveLayer.redraw?.();
    } else if (state.map.hasLayer(state.waveLayer)) state.map.removeLayer(state.waveLayer);
  }


  function initWindLayer() {
    if (!state.map || !window.L) return;
    const WindCanvasLayer = L.Layer.extend({
      onAdd(map) {
        this._map = map;
        this._canvas = L.DomUtil.create("canvas", "wind-grid-canvas leaflet-layer");
        this._ctx = this._canvas.getContext("2d");
        map.getPanes().overlayPane.appendChild(this._canvas);
        map.on("move zoom resize", this._reset, this);
        this._reset();
      },
      onRemove(map) {
        map.off("move zoom resize", this._reset, this);
        if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      },
      _reset() {
        const map = this._map, size = map.getSize();
        this._canvas.width = size.x;
        this._canvas.height = size.y;
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
        resetWindParticles(true);
        this.redraw?.();
      },
      redraw() { drawWindLayerCanvas(this._ctx, this._canvas, this._map); }
    });
    state.windLayer = new WindCanvasLayer();
    if (state.config.wind_layer_enabled !== false) state.windLayer.addTo(state.map);
    startWindAnimation();
  }

  function currentWindFrame() {
    const frames = state.windGrid?.frames || [];
    return frames.length ? frames[state.windFrameIndex % frames.length] : null;
  }

  function resetWindParticles(force = false) {
    if (!state.map || !state.windLayer?._canvas) return;
    if (state.windParticles.length && !force) return;
    const canvas = state.windLayer._canvas;
    const mobile = window.innerWidth < 760;
    const density = Number(state.config.wind_particle_density || 1);
    const count = Math.max(90, Math.min(mobile ? 420 : 900, Math.round((canvas.width * canvas.height) / (mobile ? 1650 : 1300) * density)));
    state.windParticles = Array.from({ length: count }, () => newWindParticle(canvas));
  }

  function newWindParticle(canvas) {
    return { x: Math.random() * canvas.width, y: Math.random() * canvas.height, age: Math.random() * 70, maxAge: 45 + Math.random() * 55 };
  }

  function windVectorAt(lat, lon) {
    const frame = currentWindFrame();
    const pts = frame?.points || [];
    if (!pts.length) return null;
    let best = null, bestD = Infinity;
    for (const p of pts) {
      const d = Math.pow(Number(p.lat) - lat, 2) + Math.pow(Number(p.lon) - lon, 2);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function drawWindLayerCanvas(ctx, canvas, map) {
    if (!ctx || !canvas || !map) return;
    const frame = currentWindFrame();
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(6,18,27,.08)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    if (!frame || !Array.isArray(frame.points) || !frame.points.length) return;
    resetWindParticles();
    const opacity = Math.max(.15, Math.min(.95, Number(state.config.wind_layer_opacity ?? .70)));
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineWidth = window.innerWidth < 760 ? 1.0 : 1.25;
    ctx.strokeStyle = "rgba(255,255,255,.78)";
    for (const p of state.windParticles) {
      if (p.age++ > p.maxAge || p.x < -10 || p.y < -10 || p.x > canvas.width + 10 || p.y > canvas.height + 10) Object.assign(p, newWindParticle(canvas));
      const ll = map.containerPointToLatLng([p.x, p.y]);
      const wind = windVectorAt(ll.lat, ll.lng);
      if (!wind || wind.direction_deg == null) { Object.assign(p, newWindParticle(canvas)); continue; }
      const speed = Math.max(1, Number(wind.speed_kt || 4));
      const motionDeg = (Number(wind.direction_deg) + 180) % 360;
      const rad = (motionDeg - 90) * Math.PI / 180;
      const step = Math.max(0.65, Math.min(5.6, speed * 0.105 * (window.innerWidth < 760 ? .82 : 1)));
      const nx = p.x + Math.cos(rad) * step;
      const ny = p.y + Math.sin(rad) * step;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
      p.x = nx; p.y = ny;
    }
    ctx.restore();
  }

  function startWindAnimation() {
    stopWindAnimation();
    if (!state.windPlaying) return;
    const loop = () => {
      if (!state.windPlaying) return;
      state.windLayer?.redraw?.();
      state.windRaf = requestAnimationFrame(loop);
    };
    state.windRaf = requestAnimationFrame(loop);
  }

  function stopWindAnimation() {
    if (state.windRaf) cancelAnimationFrame(state.windRaf);
    state.windRaf = 0;
  }

  function setWindLayerVisible(on) {
    state.config.wind_layer_enabled = on;
    if (!state.map || !state.windLayer) return;
    if (on) {
      if (!state.map.hasLayer(state.windLayer)) state.windLayer.addTo(state.map);
      state.windLayer.redraw?.();
      if (state.windPlaying) startWindAnimation();
    } else {
      if (state.map.hasLayer(state.windLayer)) state.map.removeLayer(state.windLayer);
      stopWindAnimation();
    }
  }

  function updateWindFrameLabel() {
    const frame = currentWindFrame();
    const el = $("windFrameLabel");
    if (el) el.textContent = frame ? `wind ${fmtDateTime(frame.time)}` : "wind model";
  }

  function renderSpotList() {
    const list = $("spotList");
    const spots = filteredSpots();
    list.innerHTML = spots.map(spot => {
      const fc = forecastFor(spot.id);
      const height = fc?.surf_height_ft?.human || "—";
      const rating = fc?.rating || "loading";
      const dotColor = markerColorFor(spot.id);
      return `<button class="spot-row ${spot.id === state.selectedId ? "is-active" : ""}" data-id="${spot.id}">
        <span class="spot-row-main"><i class="spot-color-dot" style="--dot-color:${dotColor}"></i><span><strong>${escapeHtml(spot.name)}</strong><small>${escapeHtml(spot.region || "California")} · ${escapeHtml(rating)}</small></span></span>
        <span class="height-badge">${escapeHtml(height)}</span>
      </button>`;
    }).join("") || `<div class="empty-state">No spots match this filter.</div>`;
    list.querySelectorAll(".spot-row").forEach(btn => btn.addEventListener("click", e => { e.preventDefault(); btn.blur(); preservePagePosition(() => selectSpot(btn.dataset.id, true, false)); }));
  }

  function scrollSelectedSpotIntoView() {
    if (state.config.auto_scroll_selected_list !== true) return;
    const row = document.querySelector(`.spot-row[data-id="${CSS.escape(state.selectedId || "")}"]`);
    const list = $("spotList");
    if (row && list) {
      const target = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2;
      list.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  function selectSpot(spotId, panMap = false, scrollList = false) {
    state.selectedId = spotId;
    renderSpotList();
    refreshMarkerIcons();
    renderForecast();
    if (scrollList && state.config.auto_scroll_selected_list === true) setTimeout(scrollSelectedSpotIntoView, 40);
    if (panMap && state.map) {
      const spot = allSpots().find(s => s.id === spotId);
      if (spot) state.map.setView([spot.lat, spot.lon], Math.max(state.map.getZoom(), 10), { animate: true });
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  function ratingClass(rating) { return String(rating || "unknown").toLowerCase().replace(/[^a-z]+/g, "-"); }

  function localHour(iso) {
    try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date(iso))); }
    catch (_) { return new Date(iso).getUTCHours(); }
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
    catch (_) { return iso; }
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
    catch (_) { return iso; }
  }

  function dayKey(iso) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)); }
    catch (_) { return String(iso).slice(0, 10); }
  }

  function shortDay(iso) {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "numeric", day: "numeric" }).format(new Date(iso)); }
    catch (_) { return String(iso).slice(5, 10); }
  }

  function arrowSvg(directionDeg, enabled = true) {
    if (!enabled || directionDeg === null || directionDeg === undefined) return "";
    const rot = Number(directionDeg) || 0;
    return `<span class="dir-arrow" title="${rot}°"><svg viewBox="0 0 24 24" style="transform:rotate(${rot}deg)"><path d="M12 2 L17 15 L12 12 L7 15 Z" fill="currentColor"></path><circle cx="12" cy="12" r="2" fill="#0b2030"></circle></svg></span>`;
  }

  function card(title, main, sub = "", extraClass = "") {
    return `<article class="info-card ${extraClass}"><div class="kicker">${escapeHtml(title)}</div><div class="metric-main">${main}</div>${sub ? `<div class="metric-sub">${sub}</div>` : ""}</article>`;
  }

  function renderForecast() {
    const panel = $("forecastPanel");
    const spot = allSpots().find(s => s.id === state.selectedId);
    if (!spot) { panel.innerHTML = `<div class="empty-state">Select a spot from the map or list.</div>`; return; }
    const fc = forecastFor(spot.id);
    if (!fc) { panel.innerHTML = `<div class="empty-state">No forecast found for ${escapeHtml(spot.name)}.</div>`; return; }
    const show = state.config.show_cards || DEFAULT_CONFIG.show_cards;
    const ps = fc.primary_swell || {}, ss = fc.secondary_swell || {}, wind = fc.wind || {}, tide = fc.tide || {}, sun = fc.sun || {}, notes = fc.model_notes || {};
    const cards = [];
    if (show.swell !== false) {
      cards.push(card("Primary swell", `<div class="arrow-row">${arrowSvg(ps.direction_deg, state.config.show_swell_arrows !== false)}<span>${ps.height_ft ?? "—"} ft @ ${ps.period_s ?? "—"}s</span></div>`, `${ps.direction_compass || "—"} ${ps.direction_deg ?? "—"}° · ${escapeHtml(ps.station_name || ps.source || "public wave source")}`));
      cards.push(card("Secondary swell", `<div class="arrow-row">${arrowSvg(ss.direction_deg, state.config.show_swell_arrows !== false)}<span>${ss.height_ft ?? "—"} ft @ ${ss.period_s ?? "—"}s</span></div>`, `${ss.direction_compass || "—"} ${ss.direction_deg ?? "—"}° · ${escapeHtml(ss.source || "model component")}`));
    }
    if (show.wind !== false) cards.push(card("Wind", `<div class="arrow-row">${arrowSvg(wind.direction_deg, state.config.show_wind_arrows !== false)}<span>${wind.direction_compass || "—"} ${wind.speed_kt ?? "—"} kt</span></div>`, `Gust ${wind.gust_kt ?? "—"} kt · ${escapeHtml(wind.quality || "unknown")} · ${escapeHtml(wind.source || "model")}`));
    if (show.tide !== false) cards.push(card("Tide", `${tide.level_ft ?? "—"} ft`, `${escapeHtml(tide.trend || "unknown")} · ${escapeHtml(tide.station_name || "NOAA CO-OPS")}`));
    if (show.sun !== false) cards.push(card("Sun", `${fmtTime(sun.sunrise_utc)} / ${fmtTime(sun.sunset_utc)}`, "sunrise / sunset · Pacific time"));
    if (show.confidence !== false) cards.push(card("Confidence", `${Math.round((fc.confidence || 0) * 100)}%`, `${escapeHtml(fc.best_window || "—")} · ${escapeHtml(fc.rating || "unknown")}`));
    if (show.model !== false) cards.push(card("Why this call", escapeHtml(notes.callout || "—"), `Exposure ${notes.transform?.directional_exposure ?? "—"} · bathy gain ${notes.transform?.bathymetry_gain ?? "—"}`, "full"));
    if (show.hourly !== false) cards.push(`<article class="info-card full"><div class="kicker">39 hour snapshots</div>${renderThirtyNineHourSnapshots(fc.hourly || [], spot)}</article>`);
    if (show.five_day !== false) cards.push(`<article class="info-card full"><div class="kicker">5 day forecast</div>${renderFiveDayForecast(fc.hourly || [])}</article>`);
    if (show.warnings !== false && (fc.warnings || []).length) cards.push(`<div class="warning-list"><strong>Data warnings:</strong><br>${(fc.warnings || []).slice(0, 7).map(escapeHtml).join("<br>")}</div>`);
    panel.innerHTML = `
      <div class="forecast-head">
        <div class="forecast-title"><h2>${escapeHtml(spot.name)}</h2><p>${escapeHtml(spot.region || "California")} · updated ${fmtDateTime(fc.last_updated)}</p></div>
        <div class="big-height"><strong>${escapeHtml(fc.surf_height_ft?.human || "—")}</strong><span class="rating ${ratingClass(fc.rating)}">${escapeHtml(fc.rating || "unknown")}</span></div>
      </div>
      <div class="card-grid">${cards.join("")}</div>`;
  }

  function nearestHourly(rows, targetDate) {
    if (!rows.length) return null;
    const target = targetDate.getTime();
    return rows.reduce((best, row) => Math.abs(new Date(row.time).getTime() - target) < Math.abs(new Date(best.time).getTime() - target) ? row : best, rows[0]);
  }

  function pacificMidnightFromIso(iso) {
    const d = iso ? new Date(iso) : new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
    // PST/PDT offset is handled approximately by constructing at local date + 08 UTC; the nearest model row logic absorbs the small DST difference.
    return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 8, 0, 0));
  }

  function renderThirtyNineHourSnapshots(rows, spot) {
    if (!rows.length) return `<div class="metric-sub">No snapshot values in this forecast.</div>`;
    const base = pacificMidnightFromIso(rows[0].time);
    const slots = [];
    for (let h = 0; h <= 39; h += 3) {
      const target = new Date(base.getTime() + h * 3600_000);
      const row = nearestHourly(rows, target);
      if (row) slots.push(row);
    }
    const maxH = Math.max(2, ...slots.map(r => Number(r.surf_max_ft || 0)));
    return `<div class="ampm-line"><span>AM</span><i></i><span>PM</span><i></i><span>AM</span><i></i><span>PM</span></div><div class="snapshot-row">${slots.map(r => {
      const h = Number(r.surf_max_ft || 0);
      const windC = windConditionColor(r, spot);
      return `<div class="snapshot-cell" style="--snap-color:${waveColor(h)};--wind-color:${windC}"><span>${fmtTime(r.time).replace(":00", "")}</span><b style="height:${Math.max(18, h / maxH * 78)}%"></b><strong>${r.surf_min_ft}-${r.surf_max_ft}</strong><em><i></i>${r.wind_speed_kt ?? "—"}kt</em></div>`;
    }).join("")}</div>`;
  }

  function windConditionColor(row, spot) {
    const speed = Number(row.wind_speed_kt ?? 99);
    const quality = String(row.wind_quality || "").toLowerCase();
    const dir = Number(row.wind_direction_deg);
    const beach = Number(spot?.beach_orientation_deg ?? 270);
    const offshoreDir = (beach + 180) % 360;
    const diff = Number.isFinite(dir) ? angleDiff(dir, offshoreDir) : 180;
    const offshore = diff <= 70;
    if (speed <= 6 || offshore || quality.includes("clean") || quality.includes("offshore")) return "#24c06f";
    if (speed <= 13 && !quality.includes("bumpy")) return "#f4c542";
    return "#f4b740";
  }

  function angleDiff(a, b) {
    return Math.abs((a - b + 180) % 360 - 180);
  }

  function renderFiveDayForecast(rows) {
    if (!rows.length) return `<div class="metric-sub">No 5-day values in this forecast.</div>`;
    const groups = [];
    const byDay = new Map();
    for (const row of rows) {
      const key = dayKey(row.time);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(row);
    }
    for (const [key, values] of byDay.entries()) {
      if (groups.length >= 5) break;
      const use = values.filter(v => {
        const h = localHour(v.time);
        return [5, 8, 11, 14, 17, 20].some(target => Math.abs(h - target) <= 1);
      }).slice(0, 6);
      groups.push({ key, rows: use.length ? use : values.slice(0, 6) });
    }
    return `<div class="five-day-grid">${groups.map(g => `<div class="day-column"><h3>${shortDay(g.rows[0]?.time || g.key)}</h3>${g.rows.map(r => {
      const high = Number(r.surf_max_ft || 0);
      return `<div class="day-hour" style="--hour-color:${waveColor(high)}"><span>${fmtTime(r.time).replace(":00", "")}</span><strong>${r.surf_min_ft}-${r.surf_max_ft}</strong><em>${r.wind_speed_kt ?? "—"} kt</em></div>`;
    }).join("")}</div>`).join("")}</div>`;
  }

  function syncRegionChips() {
    document.querySelectorAll(".chip[data-region]").forEach(btn => btn.classList.toggle("is-active", btn.dataset.region === state.region));
    if (state.config.auto_scroll_region_chips === true) {
      const active = document.querySelector(`.chip[data-region="${state.region}"]`);
      const scroller = $("regionScroller");
      if (active && scroller) {
        const target = active.offsetLeft - scroller.clientWidth / 2 + active.clientWidth / 2;
        scroller.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
      }
    }
  }

  function bindControls() {
    document.querySelectorAll(".chip[data-region]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        btn.blur();
        preservePagePosition(() => {
          state.region = btn.dataset.region;
          syncRegionChips();
          state.search = $("spotSearch").value = "";
          renderSpotList();
          drawMarkers({ fit: true });
          const first = filteredSpots().find(s => forecastFor(s.id)) || filteredSpots()[0];
          if (first) selectSpot(first.id, false, false);
        });
      });
    });
    $("spotSearch").addEventListener("input", e => preservePagePosition(() => { state.search = e.target.value; renderSpotList(); drawMarkers({ fit: true }); }));
    $("waveLayerToggle")?.addEventListener("change", e => setWaveLayerVisible(e.target.checked));
    $("windLayerToggle")?.addEventListener("change", e => setWindLayerVisible(e.target.checked));
    $("windPlayPause")?.addEventListener("click", () => {
      state.windPlaying = !state.windPlaying;
      $("windPlayPause").textContent = state.windPlaying ? "Pause wind" : "Play wind";
      if (state.windPlaying) startWindAnimation(); else stopWindAnimation();
    });
    $("wavePlayPause")?.addEventListener("click", () => {
      state.wavePlaying = !state.wavePlaying;
      $("wavePlayPause").textContent = state.wavePlaying ? "Pause" : "Play";
      if (state.wavePlaying) startWaveAnimation(); else stopWaveAnimation();
    });
    $("markerColorMode")?.addEventListener("change", e => {
      state.config.marker_color_mode = e.target.value;
      refreshMarkerIcons();
    });
  }

  function setupInstallPrompt() {
    const btn = $("installButton");
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault();
      state.deferredInstall = e;
      if (btn) btn.hidden = false;
    });
    btn?.addEventListener("click", async () => {
      if (!state.deferredInstall) {
        alert("On iPhone/iPad: tap Share, then Add to Home Screen.");
        return;
      }
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      btn.hidden = true;
    });
    window.addEventListener("appinstalled", () => { if (btn) btn.hidden = true; state.deferredInstall = null; });
  }

  function showUpdateToast(worker) {
    state.waitingWorker = worker;
    const toast = $("updateToast");
    if (toast) toast.hidden = false;
  }

  function setupServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./service-worker.js").then(reg => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateToast(worker);
        });
      });
      $("updateButton")?.addEventListener("click", () => { if (state.waitingWorker) state.waitingWorker.postMessage({ type: "SKIP_WAITING" }); });
      $("dismissUpdate")?.addEventListener("click", () => { $("updateToast").hidden = true; });
    }).catch(console.warn);
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }

  async function loadSupabasePublicData() {
    const supaCfg = state.config.supabase || {};
    if (!supaCfg.enabled || !supaCfg.url || !supaCfg.anon_key || !window.supabase) return {};
    try {
      state.supabaseClient = window.supabase.createClient(supaCfg.url, supaCfg.anon_key);
      const [settingsRes, spotsRes] = await Promise.all([
        state.supabaseClient.from("site_settings").select("value").eq("key", "public").maybeSingle(),
        state.supabaseClient.from("surf_spots").select("*").eq("active", true).order("display_order", { ascending: true })
      ]);
      const out = {};
      if (!settingsRes.error && settingsRes.data?.value) out.config = settingsRes.data.value;
      if (!spotsRes.error && Array.isArray(spotsRes.data) && spotsRes.data.length) out.spots = spotsRes.data.map(rowToSpot);
      return out;
    } catch (err) {
      console.warn("Supabase public data unavailable; using static JSON.", err);
      return {};
    }
  }

  function rowToSpot(row) {
    return {
      id: row.id,
      name: row.name,
      region: row.region || "California",
      lat: Number(row.lat),
      lon: Number(row.lon),
      active: row.active !== false,
      beach_orientation_deg: row.beach_orientation_deg,
      bathymetry: row.bathymetry || { slope_5_20m: null, canyon_multiplier: 1, reef_multiplier: 1, shadowing_multiplier: 1 },
      exposure_by_direction: row.exposure_by_direction || {},
      public_data: row.public_data || {},
      notes: row.notes || "Supabase spot"
    };
  }

  async function boot() {
    try {
      setupInstallPrompt();
      setupServiceWorker();
      await loadConfig();
      const dataBase = state.config.data_base_url || "./data";
      const [spots, latest, waveGrid, windGrid] = await Promise.all([
        fetchJson(dataBase, "spots.json"),
        fetchJson(dataBase, "latest_forecasts.json"),
        fetchJson(dataBase, "wave_grid_24h.json", { optional: true }),
        fetchJson(dataBase, "wind_grid_latest.json", { optional: true })
      ]);
      const supa = await loadSupabasePublicData();
      state.spots = (supa.spots || spots).sort((a, b) => Number(a.lat) - Number(b.lat));
      if (supa.config) { state.config = mergeDeep(state.config, supa.config); applyConfig(state.config); }
      state.forecasts = latest.forecasts || {};
      state.latest = latest;
      state.waveGrid = waveGrid;
      state.windGrid = windGrid;
      $("globalStatus").textContent = waveGrid && windGrid ? "wave + wind layers ready" : waveGrid ? "wave model ready" : windGrid ? "wind model ready" : "model ready";
      $("modelRefresh").textContent = `model refresh: ${fmtDateTime(latest.generated_at)}`;
      $("waveLayerToggle").checked = state.config.wave_layer_enabled !== false;
      if ($("windLayerToggle")) $("windLayerToggle").checked = state.config.wind_layer_enabled !== false;
      $("markerColorMode").value = state.config.marker_color_mode || "rating";
      bindControls();
      syncRegionChips();
      initMap();
      updateWaveFrameLabel();
      updateWindFrameLabel();
      renderSpotList();
      const first = filteredSpots().find(s => forecastFor(s.id)) || filteredSpots()[0] || activeSpots()[0];
      if (first) selectSpot(first.id, false, false);
    } catch (err) {
      console.error(err);
      $("globalStatus").textContent = "Data failed to load";
      $("forecastPanel").innerHTML = `<div class="empty-state">Could not load data. Check that public/data/spots.json, latest_forecasts.json, wave_grid_24h.json, and wind_grid_latest.json exist.</div>`;
    }
  }

  boot();
})();
