/* CaliSurf Light public app · west coast model V2.3 · calmer wind field · sticky mobile map · no build step. */
(() => {
  const DEFAULT_CONFIG = {
    data_base_url: "https://raw.githubusercontent.com/pigdogger/surfapp/main/public/data",
    theme: { bg: "#071622", panel: "#0e2434", accent: "#1bb8d4", accent2: "#ff7f50" },
    marker_size: 7,
    marker_color_mode: "rating",
    typography_scale: 0.88,
    corner_radius: 8,
    edge_buffer: 16,
    mobile_detail_scale: 0.64,
    layout: "full",
    default_region: "san-diego",
    wave_layer_enabled: false,
    wave_layer_opacity: 0.18,
    wave_animation_ms: 1150,
    show_wave_direction_arrows: true,
    wind_layer_enabled: true,
    wind_layer_opacity: 0.86,
    wind_particle_density: 1.05,
    auto_center_nearest_beaches: true,
    auto_scroll_selected_list: false,
    auto_scroll_region_chips: false,
    supabase: { enabled: false, url: "", anon_key: "" },
    show_cards: { swell: true, wind: true, tide: true, sun: true, confidence: true, model: true, hourly: true, five_day: true, warnings: true },
    show_swell_arrows: true,
    show_wind_arrows: true,
    hidden_spot_ids: [],
    pinned_spot_ids: [],
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
    windAnchorCache: null,
    waveRasterCache: null,
    userLocation: null,
    userPinnedSpotIds: [],
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
    try {
      const localConfig = await fetchJson("./data", "site_config.json");
      config = mergeDeep(config, localConfig);
      // Forecast-only GitHub Action commits use [skip netlify], so pull the raw GitHub
      // config too. This lets Supabase URL/anon-key and aesthetic settings update
      // without a Netlify rebuild.
      const remoteBase = localConfig?.data_base_url || config.data_base_url;
      if (remoteBase && !String(remoteBase).startsWith("./")) {
        try { config = mergeDeep(config, await fetchJson(remoteBase, "site_config.json")); } catch (_) {}
      }
    } catch (_) {}
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
    const pins = pinnedIdSet();
    const base = activeSpots().filter(s => {
      const qOk = !q || s.name.toLowerCase().includes(q) || (s.region || "").toLowerCase().includes(q);
      return !pins.has(s.id) && regionMatch(s) && qOk;
    });
    // If a map click selects a non-pinned spot outside the active region, keep it visible at
    // the top of the list so the map selection and list selection stay synced.
    if (!q && state.selectedId && !pins.has(state.selectedId) && !base.some(s => s.id === state.selectedId)) {
      const selected = activeSpots().find(s => s.id === state.selectedId);
      if (selected) return [selected, ...base];
    }
    return base;
  }

  function mapSpots() {
    // Always show every active spot on the map. Region selection only dims spots outside the selected region.
    return activeSpots();
  }

  function loadUserPins() {
    try {
      const raw = JSON.parse(localStorage.getItem("calisurfPinnedSpotIds") || "[]");
      state.userPinnedSpotIds = Array.isArray(raw) ? raw.filter(Boolean) : [];
    } catch (_) { state.userPinnedSpotIds = []; }
  }

  function saveUserPins() {
    localStorage.setItem("calisurfPinnedSpotIds", JSON.stringify([...new Set(state.userPinnedSpotIds || [])]));
  }

  function pinnedIdSet() {
    return new Set([...(state.config.pinned_spot_ids || []), ...(state.userPinnedSpotIds || [])]);
  }

  function orderedPinnedIds() {
    return [...new Set([...(state.config.pinned_spot_ids || []), ...(state.userPinnedSpotIds || [])])];
  }

  function isPinned(spotId) { return pinnedIdSet().has(spotId); }

  function pinnedSpots() {
    const byId = new Map(activeSpots().map(s => [s.id, s]));
    return orderedPinnedIds().map(id => byId.get(id)).filter(Boolean);
  }

  function toggleUserPin(spotId) {
    const sitePinned = new Set(state.config.pinned_spot_ids || []);
    const userSet = new Set(state.userPinnedSpotIds || []);
    if (userSet.has(spotId)) userSet.delete(spotId);
    else if (!sitePinned.has(spotId)) userSet.add(spotId);
    else alert("This spot is pinned site-wide from the admin page.");
    state.userPinnedSpotIds = [...userSet];
    saveUserPins();
    renderSpotList();
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
      marker.on("click", () => preservePagePosition(() => selectSpot(spot.id, true, true)));
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
    const frame = currentWaveFrame();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame || !Array.isArray(frame.points) || !frame.points.length) return;
    const opacity = Math.max(0, Math.min(0.78, Number(state.config.wave_layer_opacity ?? 0.26)));
    const phase = (performance.now() / 1000) % 1000;

    // V2.1: render the wave layer as a continuous sampled raster, not point blobs.
    // The layer is masked to the Pacific side of the coastline approximation so it
    // does not paint across land.
    const key = [
      state.waveFrameIndex,
      canvas.width,
      canvas.height,
      Math.round(map.getZoom() * 100),
      Math.round(map.getCenter().lat * 100),
      Math.round(map.getCenter().lng * 100),
      Math.round(opacity * 100)
    ].join("|");

    if (!state.waveRasterCache || state.waveRasterCache.key !== key) {
      state.waveRasterCache = { key, canvas: buildWaveRaster(frame, canvas, map, opacity) };
    }
    if (state.waveRasterCache?.canvas) {
      ctx.drawImage(state.waveRasterCache.canvas, 0, 0, canvas.width, canvas.height);
    }

    if (state.config.show_wave_direction_arrows === false) return;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.lineWidth = window.innerWidth < 760 ? 2.2 : 2.5;
    ctx.shadowColor = "rgba(0,0,0,.80)";
    ctx.shadowBlur = 3.5;
    ctx.lineCap = "round";
    const step = window.innerWidth < 760 ? 78 : 84;
    for (let y = step * 0.55; y < canvas.height; y += step) {
      for (let x = step * 0.55; x < canvas.width; x += step) {
        const ll = map.containerPointToLatLng([x, y]);
        if (!isPacificWater(ll.lat, ll.lng, 3.9, 0.04)) continue;
        const wave = waveValueAt(frame, ll.lat, ll.lng);
        if (!wave || wave.direction_deg == null) continue;
        // Arrows stay pinned to their grid root; only direction/size change with the frame.
        drawWaveArrow(ctx, x, y, wave.direction_deg, Math.max(15, Math.min(26, 10 + Number(wave.height_ft || 0) * 2.5)));
      }
    }
    ctx.restore();
  }

  function buildWaveRaster(frame, canvas, map, opacity) {
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.floor(canvas.width / 2));
    out.height = Math.max(1, Math.floor(canvas.height / 2));
    const rctx = out.getContext("2d");
    if (!rctx) return out;
    const scaleX = out.width / canvas.width;
    const scaleY = out.height / canvas.height;
    const cell = window.innerWidth < 760 ? 4 : 5;
    const scaledCellX = Math.ceil(cell * scaleX) + 2;
    const scaledCellY = Math.ceil(cell * scaleY) + 2;

    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        const ll = map.containerPointToLatLng([x + cell * .5, y + cell * .5]);
        if (!isPacificWater(ll.lat, ll.lng, 4.0, 0.035)) continue;
        const wave = waveValueAt(frame, ll.lat, ll.lng);
        if (!wave) continue;
        rctx.fillStyle = hexToRgba(waveColor(wave.height_ft), opacity);
        rctx.fillRect(Math.floor(x * scaleX), Math.floor(y * scaleY), scaledCellX, scaledCellY);
      }
    }

    // Light blur removes pixel seams while preserving coastline masking better than
    // the previous point/circle painter.
    const blur = document.createElement("canvas");
    blur.width = out.width;
    blur.height = out.height;
    const bctx = blur.getContext("2d");
    if (bctx) {
      bctx.filter = window.innerWidth < 760 ? "blur(5px)" : "blur(6px)";
      bctx.drawImage(out, 0, 0);
      return blur;
    }
    return out;
  }

  function isPacificWater(lat, lon, offshoreDeg = 4.0, landAllowanceDeg = 0.03) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 30.2 || lat > 42.8) return false;
    const coast = approxCoastLon(lat);
    return lon <= coast - landAllowanceDeg && lon >= coast - offshoreDeg;
  }

  function waveValueAt(frame, lat, lon) {
    const pts = frame?._preparedPoints || (frame._preparedPoints = (frame.points || []).map(p => ({
      lat: Number(p.lat), lon: Number(p.lon), height_ft: Number(p.height_ft || 0), direction_deg: p.direction_deg == null ? null : Number(p.direction_deg)
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.height_ft)));
    if (!pts?.length) return null;
    let h = 0, u = 0, v = 0, wsum = 0;
    let nearestD = Infinity;
    for (const p of pts) {
      const dLat = (p.lat - lat);
      const dLon = (p.lon - lon) * Math.cos((lat || p.lat) * Math.PI / 180);
      const d2 = dLat * dLat + dLon * dLon;
      if (d2 < nearestD) nearestD = d2;
      // Small radius keeps land-side interpolation from jumping across headlands.
      if (d2 > 1.35) continue;
      const w = 1 / Math.max(0.012, d2);
      h += p.height_ft * w;
      if (p.direction_deg != null) {
        const r = p.direction_deg * Math.PI / 180;
        u += Math.cos(r) * w;
        v += Math.sin(r) * w;
      }
      wsum += w;
    }
    if (!wsum || nearestD > 1.35) return null;
    const dir = Math.atan2(v, u) * 180 / Math.PI;
    return { height_ft: h / wsum, direction_deg: Number.isFinite(dir) ? (dir + 360) % 360 : null };
  }

  function estimateGridSpacing(points) {
    const lats = [...new Set(points.map(p => Number(p.lat)).filter(Number.isFinite))].sort((a, b) => a - b);
    const lons = [...new Set(points.map(p => Number(p.lon)).filter(Number.isFinite))].sort((a, b) => a - b);
    const latStep = medianStep(lats) || 1;
    const lonStep = medianStep(lons) || 1;
    return { lat: latStep, lon: lonStep };
  }

  function medianStep(values) {
    const steps = [];
    for (let i = 1; i < values.length; i++) {
      const d = Math.abs(values[i] - values[i - 1]);
      if (d > 0.0001) steps.push(d);
    }
    if (!steps.length) return null;
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)];
  }

  function drawWaveArrow(ctx, x, y, fromDeg, len) {
    // Wave direction is where waves come from. Draw the motion toward shore/opposite direction.
    const rad = ((Number(fromDeg) + 180) - 90) * Math.PI / 180;
    const x2 = x + Math.cos(rad) * len;
    const y2 = y + Math.sin(rad) * len;
    const head = Math.max(5.5, len * .28);

    ctx.save();
    ctx.lineWidth += 2.8;
    ctx.strokeStyle = "rgba(3,12,18,.86)";
    ctx.fillStyle = "rgba(3,12,18,.86)";
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(rad - 0.55) * head, y2 - Math.sin(rad - 0.55) * head);
    ctx.lineTo(x2 - Math.cos(rad + 0.55) * head, y2 - Math.sin(rad + 0.55) * head);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(236,255,255,.96)";
    ctx.fillStyle = "rgba(236,255,255,.96)";
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(rad - 0.55) * head, y2 - Math.sin(rad - 0.55) * head);
    ctx.lineTo(x2 - Math.cos(rad + 0.55) * head, y2 - Math.sin(rad + 0.55) * head);
    ctx.closePath(); ctx.fill();
    ctx.restore();
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
    const count = Math.max(120, Math.min(mobile ? 650 : 1350, Math.round((canvas.width * canvas.height) / (mobile ? 1180 : 980) * density)));
    state.windParticles = Array.from({ length: count }, () => newWindParticle(canvas));
  }

  function visibleWindAnchors(canvas, map) {
    const anchors = windAnchors();
    if (!anchors.length || !map) return [];
    return anchors.filter(p => {
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      if (!isNearWindCorridor(lat, lon)) return false;
      const pt = map.latLngToContainerPoint([lat, lon]);
      return pt.x > -120 && pt.y > -120 && pt.x < canvas.width + 120 && pt.y < canvas.height + 120;
    });
  }

  function approxCoastLon(lat) {
    // Lightweight California coastline approximation for display masking only.
    const curve = [
      [32.5, -117.2], [33.2, -117.6], [34.0, -118.4], [34.6, -120.0],
      [35.4, -121.1], [36.4, -121.9], [37.6, -122.6], [38.6, -123.1],
      [40.0, -124.1], [41.6, -124.2], [42.2, -124.2]
    ];
    if (lat <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (lat <= b[0]) {
        const t = (lat - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return curve[curve.length - 1][1];
  }

  function isNearPacificCoast(lat, lon) {
    const coast = approxCoastLon(Number(lat));
    return lon >= coast - 4.0 && lon <= coast + 0.08;
  }

  function isNearWindCorridor(lat, lon) {
    const coast = approxCoastLon(Number(lat));
    // V2.3: show the larger coastal weather pattern like Windy/MyRadar: far offshore
    // and well inland, but still bounded around California instead of the whole continent.
    return lon >= coast - 5.4 && lon <= coast + 2.45 && lat >= 30.25 && lat <= 42.8;
  }

  function windAnchors() {
    const key = `${state.windFrameIndex}|${Object.keys(state.forecasts || {}).length}`;
    if (state.windAnchorCache?.key === key) return state.windAnchorCache.pts;
    const frame = currentWindFrame();
    const pts = [];

    // Model grid anchors, restricted to the coastal strip.
    for (const p of (frame?.points || [])) {
      if (isNearWindCorridor(Number(p.lat), Number(p.lon))) {
        pts.push({ lat: Number(p.lat), lon: Number(p.lon), speed_kt: Number(p.speed_kt || 0), direction_deg: Number(p.direction_deg), source: "grid", weight: 0.80 });
      }
    }

    // Spot-level forecasts are more local than the coarse visual grid, so they get
    // higher weight. This makes the wind display change near actual beaches.
    for (const spot of activeSpots()) {
      const fc = forecastFor(spot.id);
      const w = fc?.wind || {};
      const speed = Number(w.speed_kt);
      const dir = Number(w.direction_deg);
      if (Number.isFinite(speed) && Number.isFinite(dir)) {
        pts.push({ lat: Number(spot.lat), lon: Number(spot.lon), speed_kt: speed, direction_deg: dir, source: "spot", weight: 1.25 });
      }
    }
    const clean = pts.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.speed_kt) && Number.isFinite(p.direction_deg));
    state.windAnchorCache = { key, pts: clean };
    return clean;
  }

  function windVectorAt(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !isNearWindCorridor(lat, lon)) return null;
    const pts = windAnchors();
    if (!pts.length) return null;
    const nearest = [];
    for (const p of pts) {
      if (!isNearWindCorridor(Number(p.lat), Number(p.lon))) continue;
      const dLat = Number(p.lat) - lat;
      const dLon = (Number(p.lon) - lon) * Math.cos(lat * Math.PI / 180);
      const d2 = dLat * dLat + dLon * dLon;
      // Broader radius shows weather-pattern continuity while spot anchors still add local bias near beaches.
      if (d2 > (p.source === "spot" ? 1.20 : 2.80)) continue;
      nearest.push({ p, d: d2 });
    }
    nearest.sort((a, b) => a.d - b.d);
    if (!nearest.length) return null;

    let u = 0, v = 0, wsum = 0;
    for (const item of nearest.slice(0, 8)) {
      const p = item.p;
      const speed = Math.max(0, Number(p.speed_kt || 0));
      const dir = Number(p.direction_deg);
      if (!Number.isFinite(speed) || !Number.isFinite(dir)) continue;
      const rad = (270 - dir) * Math.PI / 180;
      const w = Number(p.weight || 1) / Math.max(0.018, item.d);
      u += Math.cos(rad) * speed * w;
      v += Math.sin(rad) * speed * w;
      wsum += w;
    }
    if (!wsum) return null;
    const uu = u / wsum, vv = v / wsum;
    const speed = Math.hypot(uu, vv);
    const dir = (270 - Math.atan2(vv, uu) * 180 / Math.PI + 360) % 360;
    return { speed_kt: speed, direction_deg: dir };
  }

  function newWindParticle(canvas) {
    const anchors = visibleWindAnchors(canvas, state.map);
    if (anchors.length && state.map) {
      const a = anchors[Math.floor(Math.random() * anchors.length)];
      const jitterLat = (Math.random() - .5) * .46;
      const jitterLon = (Math.random() - .5) * .86;
      const pt = state.map.latLngToContainerPoint([Number(a.lat) + jitterLat, Number(a.lon) + jitterLon]);
      return { x: pt.x, y: pt.y, age: Math.random() * 54, maxAge: 34 + Math.random() * 44 };
    }
    return { x: Math.random() * canvas.width, y: Math.random() * canvas.height, age: Math.random() * 45, maxAge: 40 + Math.random() * 45 };
  }

  function drawWindLayerCanvas(ctx, canvas, map) {
    if (!ctx || !canvas || !map) return;
    const frame = currentWindFrame();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,.10)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    if (!frame || !Array.isArray(frame.points) || !frame.points.length) return;
    resetWindParticles();
    const opacity = Math.max(.12, Math.min(.90, Number(state.config.wind_layer_opacity ?? .62)));
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineWidth = window.innerWidth < 760 ? 0.95 : 0.85;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(0,0,0,.82)";
    ctx.shadowBlur = 4;
    for (const p of state.windParticles) {
      if (p.age++ > p.maxAge || p.x < -10 || p.y < -10 || p.x > canvas.width + 10 || p.y > canvas.height + 10) Object.assign(p, newWindParticle(canvas));
      const ll = map.containerPointToLatLng([p.x, p.y]);
      if (!isNearWindCorridor(ll.lat, ll.lng)) { Object.assign(p, newWindParticle(canvas)); continue; }
      const wind = windVectorAt(ll.lat, ll.lng);
      if (!wind || wind.direction_deg == null) { Object.assign(p, newWindParticle(canvas)); continue; }
      const speed = Math.max(1, Number(wind.speed_kt || 4));
      const motionDeg = (Number(wind.direction_deg) + 180) % 360;
      const rad = (motionDeg - 90) * Math.PI / 180;
      const step = Math.max(0.20, Math.min(1.65, speed * 0.045 * (window.innerWidth < 760 ? .82 : .95)));
      const nx = p.x + Math.cos(rad) * step;
      const ny = p.y + Math.sin(rad) * step;
      ctx.strokeStyle = speed <= 6 ? "rgba(155,255,235,.72)" : speed <= 13 ? "rgba(232,208,255,.68)" : "rgba(255,174,210,.70)";
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

  function renderPinnedSpotList() {
    const tray = $("pinnedSpotTray");
    if (!tray) return;
    const pins = pinnedSpots();
    if (!pins.length) {
      tray.hidden = true;
      tray.innerHTML = "";
      document.querySelector(".side-panel")?.classList.remove("has-pins");
      return;
    }
    tray.hidden = false;
    document.querySelector(".side-panel")?.classList.add("has-pins");
    tray.innerHTML = `<div class="pinned-label">Pinned</div><div class="pinned-strip">${pins.map(spot => {
      const height = forecastFor(spot.id)?.surf_height_ft?.human || "—";
      const dotColor = markerColorFor(spot.id);
      const sitePinned = new Set(state.config.pinned_spot_ids || []).has(spot.id);
      return `<div class="pinned-card ${spot.id === state.selectedId ? "is-active" : ""}" role="button" tabindex="0" data-id="${escapeHtml(spot.id)}" title="${escapeHtml(spot.name)}">
        <i class="spot-color-dot" style="--dot-color:${dotColor}"></i><strong>${escapeHtml(spot.name)}</strong><em>${escapeHtml(height)}</em>${sitePinned ? `<span class="pin-source">site</span>` : `<button class="pin-remove" type="button" data-unpin="${escapeHtml(spot.id)}" aria-label="Unpin ${escapeHtml(spot.name)}">×</button>`}
      </div>`;
    }).join("")}</div>`;
    tray.querySelectorAll(".pinned-card").forEach(card => {
      card.addEventListener("click", e => { e.preventDefault(); card.blur(); preservePagePosition(() => selectSpot(card.dataset.id, true, false)); });
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); preservePagePosition(() => selectSpot(card.dataset.id, true, false)); } });
    });
    tray.querySelectorAll(".pin-remove").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); btn.blur(); preservePagePosition(() => toggleUserPin(btn.dataset.unpin));
    }));
  }

  function renderSpotList() {
    renderPinnedSpotList();
    const list = $("spotList");
    const spots = filteredSpots();
    list.innerHTML = spots.map(spot => {
      const fc = forecastFor(spot.id);
      const height = fc?.surf_height_ft?.human || "—";
      const rating = fc?.rating || "loading";
      const dotColor = markerColorFor(spot.id);
      const pinned = isPinned(spot.id);
      return `<div class="spot-row ${spot.id === state.selectedId ? "is-active" : ""}" role="button" tabindex="0" data-id="${escapeHtml(spot.id)}">
        <span class="spot-row-main"><i class="spot-color-dot" style="--dot-color:${dotColor}"></i><span><strong>${escapeHtml(spot.name)}</strong><small>${escapeHtml(spot.region || "California")} · ${escapeHtml(rating)}</small></span></span>
        <span class="row-actions"><span class="height-badge">${escapeHtml(height)}</span><button class="pin-toggle ${pinned ? "is-pinned" : ""}" type="button" data-pin="${escapeHtml(spot.id)}" aria-label="${pinned ? "Pinned" : "Pin"} ${escapeHtml(spot.name)}" title="${pinned ? "Pinned" : "Pin spot"}">${pinned ? "★" : "☆"}</button></span>
      </div>`;
    }).join("") || `<div class="empty-state">No spots match this filter.</div>`;
    list.querySelectorAll(".spot-row").forEach(row => {
      row.addEventListener("click", e => { e.preventDefault(); row.blur(); preservePagePosition(() => selectSpot(row.dataset.id, true, false)); });
      row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); preservePagePosition(() => selectSpot(row.dataset.id, true, false)); } });
    });
    list.querySelectorAll(".pin-toggle").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); btn.blur(); preservePagePosition(() => toggleUserPin(btn.dataset.pin));
    }));
  }

  function scrollSelectedSpotIntoView(force = false) {
    if (!force && state.config.auto_scroll_selected_list !== true) return;
    const row = document.querySelector(`.spot-row[data-id="${CSS.escape(state.selectedId || "")}"]`);
    const list = $("spotList");
    if (row && list) {
      const target = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2;
      list.scrollTo({ top: Math.max(0, target), behavior: "auto" });
    }
  }

  function selectSpot(spotId, panMap = false, scrollList = false) {
    state.selectedId = spotId;
    renderSpotList();
    refreshMarkerIcons();
    renderForecast();
    if (scrollList || state.config.auto_scroll_selected_list === true) setTimeout(() => scrollSelectedSpotIntoView(!!scrollList), 40);
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
      renderSpotList();
    });
    $("nearMeButton")?.addEventListener("click", e => {
      e.preventDefault();
      centerOnUserLocation(true);
    });
    $("mapMinimizeButton")?.addEventListener("click", e => {
      e.preventDefault();
      const card = document.querySelector(".map-card");
      const collapsed = !card?.classList.contains("is-map-minimized");
      card?.classList.toggle("is-map-minimized", collapsed);
      $("mapMinimizeButton").textContent = collapsed ? "+" : "−";
      $("mapMinimizeButton").setAttribute("aria-label", collapsed ? "Expand map" : "Minimize map");
      setTimeout(() => state.map?.invalidateSize?.(), 80);
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

  function distanceKm(aLat, aLon, bLat, bLon) {
    const R = 6371;
    const dLat = (bLat - aLat) * Math.PI / 180;
    const dLon = (bLon - aLon) * Math.PI / 180;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const q = s1 * s1 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * s2 * s2;
    return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(Math.max(0, 1 - q)));
  }

  function nearestForecastSpotTo(lat, lon) {
    return activeSpots()
      .filter(s => forecastFor(s.id))
      .map(s => ({ spot: s, km: distanceKm(lat, lon, Number(s.lat), Number(s.lon)) }))
      .sort((a, b) => a.km - b.km)[0]?.spot || null;
  }

  function centerOnUserLocation(forcePrompt = false) {
    const btn = $("nearMeButton");
    if (!navigator.geolocation) {
      if (btn) btn.textContent = "Location unavailable";
      return;
    }
    if (btn) btn.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      state.userLocation = { lat, lon };
      const nearest = nearestForecastSpotTo(lat, lon);
      if (nearest) {
        // Region follows nearest spot, but the page itself never scrolls.
        const regionKey = Object.entries(REGION_DEFS).find(([key, def]) => key !== "all" && def.match(nearest))?.[0];
        preservePagePosition(() => {
          if (regionKey) state.region = regionKey;
          syncRegionChips();
          renderSpotList();
          drawMarkers({ fit: true });
          selectSpot(nearest.id, true, true);
        });
        if (btn) btn.textContent = "Near me";
      } else {
        if (btn) btn.textContent = "Near me";
      }
    }, err => {
      if (btn) btn.textContent = "Near me";
      if (forcePrompt) alert("Location was not available. Enable location access to center on your nearest beaches.");
      console.warn("Geolocation unavailable", err);
    }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 10 * 60 * 1000 });
  }

  function maybeAutoCenterOnLocation() {
    if (state.config.auto_center_nearest_beaches === false || !navigator.geolocation) return;
    // Do not surprise new users with a permission dialog; auto-center only when
    // location has already been granted. The Near me button always prompts.
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: "geolocation" }).then(status => {
        if (status.state === "granted") centerOnUserLocation(false);
      }).catch(() => {});
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
      loadUserPins();
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
      const statusEl = $("globalStatus");
      if (statusEl) { statusEl.textContent = ""; statusEl.hidden = true; }
      $("modelRefresh").textContent = `model refresh: ${fmtDateTime(latest.generated_at)}`;
      $("waveLayerToggle").checked = state.config.wave_layer_enabled === true;
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
      maybeAutoCenterOnLocation();
    } catch (err) {
      console.error(err);
      if ($("globalStatus")) $("globalStatus").textContent = "Data failed to load";
      $("forecastPanel").innerHTML = `<div class="empty-state">Could not load data. Check that public/data/spots.json, latest_forecasts.json, wave_grid_24h.json, and wind_grid_latest.json exist.</div>`;
    }
  }

  boot();
})();
