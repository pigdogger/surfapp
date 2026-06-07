/* CaliSurf Light public app · west coast model V2.6 · hourly wind arrows, native settings, desktop edge layout · no build step. */
(() => {
  const DEFAULT_CONFIG = {
    data_base_url: "https://raw.githubusercontent.com/pigdogger/surfapp/main/public/data",
    theme: { bg: "#071622", panel: "#0e2434", accent: "#1bb8d4", accent2: "#ff7f50" },
    gradients: {
      wind_speed: { min: 0, max: 24, low: "#8ee8ff", mid: "#f4c542", high: "#ef4444" },
      spot_rating: { poor: "#e05b52", fair: "#f4c542", good: "#1ecb78", flat: "#8da2af" },
      wave_height: { min: 0, max: 18, low: "#1eb6d0", mid: "#22c55e", high: "#f97316" }
    },
    text: {
      model_label: "WEST COAST MODEL V1",
      app_title: "CaliSurf Light",
      refresh_prefix: "model refresh:",
      install_label: "Install app",
      search_placeholder: "Search surf spots…"
    },
    typography: {
      family: "Raleway, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      title_weight: 300,
      body_weight: 500,
      spot_name_weight: 550,
      spot_meta_weight: 600,
      letter_spacing: 0.02,
      title_color: "#ffffff",
      label_color: "#8edceb",
      spot_name_color: "#ffffff",
      spot_meta_color: "#a6bfcc"
    },
    marker_size: 6,
    marker_color_mode: "rating",
    typography_scale: 0.81,
    corner_radius: 8,
    edge_buffer: 39,
    mobile_detail_scale: 0.55,
    layout: "full",
    default_region: "san-diego",
    wave_layer_enabled: false,
    wave_layer_opacity: 0.1,
    wave_animation_ms: 1150,
    show_wave_direction_arrows: false,
    wind_layer_enabled: true,
    wind_layer_opacity: 0.75,
    wind_particle_density: 2.5,
    wind_particle_size: 1.0,
    wind_particle_length: 2.15,
    wind_particle_speed: 2.5,
    wind_particle_shape: "spark",
    map_tint_opacity: 0.36,
    wave_arrow_size: 1.7,
    wave_arrow_color: "#4268ff",
    wave_arrow_opacity: 0.2,
    wave_arrow_stroke: 0.5,
    wave_nearshore_overlap: 0.018,
    auto_center_nearest_beaches: true,
    auto_scroll_selected_list: false,
    auto_scroll_region_chips: false,
    supabase: { enabled: true, url: "https://hzyskrurgtwceperzcqb.supabase.co", anon_key: "sb_publishable_mBqm_4Or0NLo0pkk9toq0Q_-0nHMQpX" },
    hourly_wind_enabled: true,
    hourly_wind_start_hour: 5,
    hourly_wind_end_hour: 21,
    hourly_wind_frame_ms: 1450,
    hourly_wind_arrow_min_px: 4,
    hourly_wind_arrow_max_px: 26,
    hourly_wind_density: 1.0,
    show_cards: { swell: true, wind: true, tide: true, sun: true, confidence: true, model: true, hourly: true, five_day: true, warnings: true },
    show_swell_arrows: true,
    show_wind_arrows: true,
    hidden_spot_ids: [],
    pinned_spot_ids: [],
    added_spots: []
  };

  const REGION_DEFS = {
    "all": { label: "All CA", center: [36.2, -121.2], zoom: 6, match: () => true },
    "san-diego": { label: "San Diego", center: [32.92, -117.29], zoom: 11, match: s => Number(s.lat) < 33.35 },
    "orange-county": { label: "Orange County", center: [33.61, -117.88], zoom: 11, match: s => Number(s.lat) >= 33.35 && Number(s.lat) < 33.90 },
    "los-angeles": { label: "Los Angeles", center: [34.02, -118.52], zoom: 10, match: s => Number(s.lat) >= 33.90 && Number(s.lat) < 34.35 },
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
    windTimer: null,
    windTimelineIndex: 0,
    windTimelineActiveIndex: 0,
    windTimelineSlots: [],
    wavePlaying: true,
    windPlaying: true,
    selectedId: null,
    region: "san-diego",
    search: "",
    map: null,
    markerLayer: null,
    waveLayer: null,
    windLayer: null,
    mapTintLayer: null,
    windParticles: [],
    windAnchorCache: null,
    waveRasterCache: null,
    coastPointCache: null,
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
      // V2.6: site_config is treated as native boot config. Avoid a second raw-GitHub
      // config fetch before first paint; live admin overrides are read from Supabase below.
    } catch (_) {}
    try {
      const fromAdmin = JSON.parse(localStorage.getItem("surfAppAdminConfig") || "null");
      // Browser-only fallback settings from old admin builds must never disable
      // a real Supabase connection. They may still be useful when Supabase is
      // absent, but once site_config has a public Supabase URL/key, the database
      // is the source of truth for aesthetics/spots.
      if (fromAdmin && !(config.supabase?.enabled && config.supabase?.url && config.supabase?.anon_key)) {
        config = mergeDeep(config, fromAdmin);
      }
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
    root.style.setProperty("--map-tint-opacity", String(Math.max(0, Math.min(1, Number(config.map_tint_opacity ?? 0.18)))));
    const ty = config.typography || {};
    root.style.setProperty("--font-family-app", ty.family || DEFAULT_CONFIG.typography.family);
    root.style.setProperty("--font-title-weight", Number(ty.title_weight ?? 800));
    root.style.setProperty("--font-body-weight", Number(ty.body_weight ?? 600));
    root.style.setProperty("--font-spot-name-weight", Number(ty.spot_name_weight ?? 800));
    root.style.setProperty("--font-spot-meta-weight", Number(ty.spot_meta_weight ?? 600));
    root.style.setProperty("--letter-spacing-app", `${Number(ty.letter_spacing ?? 0)}em`);
    root.style.setProperty("--title-color", ty.title_color || "#ffffff");
    root.style.setProperty("--label-color", ty.label_color || "#8edceb");
    root.style.setProperty("--spot-name-color", ty.spot_name_color || "#ffffff");
    root.style.setProperty("--spot-meta-color", ty.spot_meta_color || "#a6bfcc");
    document.body.classList.toggle("compact-layout", config.layout === "compact");
    updateConfiguredText();
    state.mapTintLayer?.redraw?.();
  }

  function updateConfiguredText() {
    const t = state.config.text || {};
    const eyebrow = document.querySelector(".brand-block .eyebrow");
    const title = document.querySelector(".brand-block h1");
    const install = $("installButton");
    const search = $("spotSearch");
    if (eyebrow) { eyebrow.textContent = t.model_label ?? DEFAULT_CONFIG.text.model_label; eyebrow.hidden = !String(eyebrow.textContent || "").trim(); }
    if (title) { title.textContent = t.app_title ?? DEFAULT_CONFIG.text.app_title; title.hidden = !String(title.textContent || "").trim(); }
    if (install) install.textContent = t.install_label || DEFAULT_CONFIG.text.install_label;
    if (search) search.placeholder = t.search_placeholder || DEFAULT_CONFIG.text.search_placeholder;
  }

  function allSpots() {
    return [...state.spots, ...(state.config.added_spots || [])].sort((a, b) => Number(b.lat) - Number(a.lat));
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
    initMapTintLayer();
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

  function gradientConfig(name) {
    const g = state.config.gradients?.[name] || DEFAULT_CONFIG.gradients?.[name] || {};
    return { ...g };
  }

  function gradientStops(name, fallback) {
    const g = gradientConfig(name);
    const min = Number.isFinite(Number(g.min)) ? Number(g.min) : fallback[0][0];
    const max = Number.isFinite(Number(g.max)) ? Number(g.max) : fallback[fallback.length - 1][0];
    const midVal = Number.isFinite(Number(g.mid_value)) ? Number(g.mid_value) : (min + max) / 2;
    return [[min, g.low || fallback[0][1]], [midVal, g.mid || fallback[Math.floor(fallback.length / 2)][1]], [max, g.high || fallback[fallback.length - 1][1]]];
  }

  function waveColor(ft) {
    return colorForValue(Number(ft || 0), gradientStops("wave_height", [[0, "#1eb6d0"], [6, "#22c55e"], [18, "#f97316"]]));
  }

  function windSpeedColor(speed) {
    return colorForValue(Number(speed || 0), gradientStops("wind_speed", [[0, "#8ee8ff"], [12, "#f4c542"], [24, "#ef4444"]]));
  }

  function scoreColor(score) {
    const sr = gradientConfig("spot_rating");
    return colorForValue(Number(score || 0), [[0, sr.poor || "#c43b4d"], [0.50, sr.fair || "#f4c542"], [1, sr.good || "#1ecb78"]]);
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
    const sr = gradientConfig("spot_rating");
    if (rating.includes("good")) return sr.good || "#1ecb78";
    if (rating.includes("fair")) return sr.fair || "#f4c542";
    if (rating.includes("poor")) return sr.poor || "#e05b52";
    if (rating.includes("flat")) return sr.flat || "#8da2af";
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
    const def = REGION_DEFS[state.region] || REGION_DEFS["san-diego"];
    // V2.6: use fixed region centers/zooms instead of fitting every matching spot.
    // This keeps the initial/default view more zoomed-in and prevents the map from
    // backing out too far when a region has a long north/south surf-spot chain.
    state.map.setView(def.center, def.zoom, { animate: true });
  }

  function initMapTintLayer() {
    if (!state.map || !window.L) return;
    state.map.createPane("mapTintPane");
    const pane = state.map.getPane("mapTintPane");
    pane.style.zIndex = 350;
    pane.style.pointerEvents = "none";
    const TintLayer = L.Layer.extend({
      onAdd(map) {
        this._map = map;
        this._el = L.DomUtil.create("div", "map-tint-layer leaflet-layer");
        pane.appendChild(this._el);
        map.on("move zoom resize", this._reset, this);
        this._reset();
      },
      onRemove(map) {
        map.off("move zoom resize", this._reset, this);
        if (this._el?.parentNode) this._el.parentNode.removeChild(this._el);
      },
      _reset() {
        const size = this._map.getSize();
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._el, topLeft);
        this._el.style.width = `${size.x}px`;
        this._el.style.height = `${size.y}px`;
        this.redraw();
      },
      redraw() {
        if (!this._el) return;
        const opacity = Math.max(0, Math.min(1, Number(state.config.map_tint_opacity ?? 0.18)));
        this._el.style.background = `rgba(0, 10, 18, ${opacity})`;
      }
    });
    state.mapTintLayer = new TintLayer();
    state.mapTintLayer.addTo(state.map);
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
    const opacity = Math.max(0, Math.min(0.90, Number(state.config.wave_layer_opacity ?? 0.26)));
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
        if (!isPacificWater(ll.lat, ll.lng, 3.9, Number(state.config.wave_nearshore_overlap ?? 0.04))) continue;
        const wave = waveValueAt(frame, ll.lat, ll.lng);
        if (!wave || wave.direction_deg == null) continue;
        // Arrows stay pinned to their grid root; only direction/size change with the frame.
        const mult = Math.max(0.45, Math.min(2.4, Number(state.config.wave_arrow_size ?? 1.0)));
        drawWaveArrow(ctx, x, y, wave.direction_deg, Math.max(15, Math.min(30, 10 + Number(wave.height_ft || 0) * 2.5)) * mult);
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
    const cell = window.innerWidth < 760 ? 3 : 4;
    const scaledCellX = Math.ceil(cell * scaleX) + 3;
    const scaledCellY = Math.ceil(cell * scaleY) + 3;

    for (let y = 0; y < canvas.height; y += cell) {
      for (let x = 0; x < canvas.width; x += cell) {
        const ll = map.containerPointToLatLng([x + cell * .5, y + cell * .5]);
        if (!isPacificWater(ll.lat, ll.lng, 4.2, Number(state.config.wave_nearshore_overlap ?? 0.018))) continue;
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
      bctx.filter = window.innerWidth < 760 ? "blur(3px)" : "blur(4px)";
      bctx.drawImage(out, 0, 0);
      bctx.filter = "none";
      bctx.globalCompositeOperation = "destination-in";
      drawOceanMask(bctx, blur.width, blur.height, map, scaleX, scaleY, Number(state.config.wave_nearshore_overlap ?? 0.010));
      bctx.globalCompositeOperation = "source-over";
      return blur;
    }
    return out;
  }

  function drawOceanMask(ctx, width, height, map, scaleX = 1, scaleY = 1, coastOffsetDeg = 0.0) {
    if (!ctx || !map) return;
    const bounds = map.getBounds();
    const south = bounds.getSouth() - 0.5;
    const north = bounds.getNorth() + 0.5;
    const samples = 140;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, height);
    for (let i = 0; i <= samples; i++) {
      const lat = south + (north - south) * (i / samples);
      const lon = approxCoastLon(lat) + coastOffsetDeg;
      const pt = map.latLngToContainerPoint([lat, lon]);
      ctx.lineTo(pt.x * scaleX, pt.y * scaleY);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.fill();
  }

  function isPacificWater(lat, lon, offshoreDeg = 4.0, landAllowanceDeg = 0.012) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 30.2 || lat > 42.8) return false;
    const coast = approxCoastLon(lat);
    // Paint very slightly under the coastline, then mask to the same coast curve after blur.
    // This avoids a gap between color and shoreline while keeping the visible layer ocean-side.
    return lon <= coast + landAllowanceDeg && lon >= coast - offshoreDeg;
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
    const arrowColor = state.config.wave_arrow_color || "#ecffff";
    const arrowOpacity = Math.max(0.05, Math.min(1, Number(state.config.wave_arrow_opacity ?? .96)));
    const stroke = Math.max(.5, Math.min(7, Number(state.config.wave_arrow_stroke ?? 2.6)));

    ctx.save();
    ctx.lineWidth += stroke;
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
    ctx.globalAlpha = arrowOpacity;
    ctx.lineWidth = Math.max(1, ctx.lineWidth - 0.4);
    ctx.strokeStyle = arrowColor;
    ctx.fillStyle = arrowColor;
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
      state.wavePlaying = true;
      startWaveAnimation();
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

  function coastlineControlPoints() {
    const key = `${state.spots.length}|${(state.config.hidden_spot_ids || []).length}|${(state.config.added_spots || []).length}`;
    if (state.coastPointCache?.key === key) return state.coastPointCache.points;
    const spots = activeSpots();
    const fallback = [
      [32.50, -117.20], [33.20, -117.60], [34.00, -118.40], [34.60, -120.00],
      [35.40, -121.10], [36.40, -121.90], [37.60, -122.60], [38.60, -123.10],
      [40.00, -124.10], [41.60, -124.20], [42.20, -124.20]
    ];
    const pts = spots
      .map(s => [Number(s.lat), Number(s.lon)])
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= 30.2 && p[0] <= 42.8)
      .sort((a, b) => a[0] - b[0]);
    const controls = pts.length > 20 ? pts : fallback;
    state.coastPointCache = { key, points: controls };
    return controls;
  }

  function approxCoastLon(lat) {
    const curve = coastlineControlPoints();
    lat = Number(lat);
    if (!Number.isFinite(lat)) return -120;
    if (lat <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (lat <= b[0]) {
        const t = (lat - a[0]) / (b[0] - a[0] || 1);
        // Lightly smooth toward the hand-drawn coastline so one odd surf-spot coordinate
        // cannot create a sudden hard notch in the visual ocean mask.
        const raw = a[1] + (b[1] - a[1]) * t;
        return raw;
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const frame = currentWindFrame();
    if (!frame || !Array.isArray(frame.points) || !frame.points.length) return;
    const opacity = Math.max(.08, Math.min(1, Number(state.config.wind_layer_opacity ?? .75)));
    const density = Math.max(.45, Math.min(2.6, Number(state.config.hourly_wind_density ?? state.config.wind_particle_density ?? 1)));
    const spacing = (window.innerWidth < 760 ? 48 : 58) / Math.sqrt(density);
    const minLen = Math.max(2, Math.min(15, Number(state.config.hourly_wind_arrow_min_px ?? 4)));
    const maxLen = Math.max(minLen + 2, Math.min(46, Number(state.config.hourly_wind_arrow_max_px ?? 26)));
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 2;
    for (let y = spacing * .55; y < canvas.height; y += spacing) {
      for (let x = spacing * .55; x < canvas.width; x += spacing) {
        const ll = map.containerPointToLatLng([x, y]);
        if (!isNearWindCorridor(ll.lat, ll.lng)) continue;
        const wind = windVectorAt(ll.lat, ll.lng);
        if (!wind || wind.direction_deg == null) continue;
        drawHourlyWindGlyph(ctx, x, y, wind);
      }
    }
    ctx.restore();
  }

  function drawHourlyWindGlyph(ctx, x, y, wind) {
    const speed = Math.max(0, Number(wind.speed_kt || 0));
    const color = windSpeedColor(speed);
    if (speed < 2) {
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(color, .90);
      ctx.arc(x, y, window.innerWidth < 760 ? 1.7 : 2.0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Wind direction is where wind comes from; draw motion toward where the air travels.
    const travelDeg = (Number(wind.direction_deg) + 180) % 360;
    const rad = (travelDeg - 90) * Math.PI / 180;
    const g = gradientConfig("wind_speed");
    const min = Number.isFinite(Number(g.min)) ? Number(g.min) : 0;
    const max = Number.isFinite(Number(g.max)) ? Number(g.max) : 24;
    const t = Math.max(0, Math.min(1, (speed - min) / (max - min || 1)));
    const minLen = Math.max(2, Math.min(15, Number(state.config.hourly_wind_arrow_min_px ?? 4)));
    const maxLen = Math.max(minLen + 2, Math.min(46, Number(state.config.hourly_wind_arrow_max_px ?? 26)));
    const len = (minLen + (maxLen - minLen) * Math.sqrt(t)) * Math.max(.35, Math.min(4, Number(state.config.wind_particle_length ?? 1)));
    const lw = Math.max(.45, Math.min(5.5, (.75 + t * 1.6) * Math.max(.25, Math.min(4, Number(state.config.wind_particle_size ?? 1)))));
    const sx = x - Math.cos(rad) * len * .42;
    const sy = y - Math.sin(rad) * len * .42;
    const ex = x + Math.cos(rad) * len * .58;
    const ey = y + Math.sin(rad) * len * .58;
    ctx.strokeStyle = hexToRgba(color, .96);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const shape = String(state.config.wind_particle_shape || "spark");
    if (shape !== "dash") {
      const head = Math.max(3, Math.min(7, len * .24));
      const angle = Math.PI * .78;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(rad - angle) * head, ey - Math.sin(rad - angle) * head);
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(rad + angle) * head, ey - Math.sin(rad + angle) * head);
      ctx.stroke();
    }
  }

  function closestWindFrameIndex(timeIso) {
    const frames = state.windGrid?.frames || [];
    if (!frames.length || !timeIso) return state.windFrameIndex || 0;
    const target = new Date(timeIso).getTime();
    let best = 0, bestD = Infinity;
    frames.forEach((f, i) => {
      const d = Math.abs(new Date(f.time).getTime() - target);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function rebuildWindTimelineSlots() {
    const spot = allSpots().find(s => s.id === state.selectedId);
    const fc = spot ? forecastFor(spot.id) : null;
    const rows = fc?.hourly || [];
    const startHour = Math.max(0, Math.min(23, Number(state.config.hourly_wind_start_hour ?? 5)));
    const endHour = Math.max(startHour, Math.min(23, Number(state.config.hourly_wind_end_hour ?? 21)));
    if (!rows.length) {
      state.windTimelineSlots = [];
      state.windTimelineIndex = 0;
      state.windTimelineActiveIndex = 0;
      return;
    }
    const base = pacificMidnightFromIso(rows[0].time);
    const slots = [];
    for (let hour = startHour; hour <= endHour; hour += 1) {
      const target = new Date(base.getTime() + hour * 3600_000);
      const row = nearestHourly(rows, target);
      if (row) slots.push({ hour, row, time: row.time });
    }
    state.windTimelineSlots = slots;
    state.windTimelineIndex = Math.max(0, Math.min(state.windTimelineIndex, Math.max(0, slots.length - 1)));
    const slot = slots[state.windTimelineIndex];
    if (slot) state.windFrameIndex = closestWindFrameIndex(slot.time);
  }

  function startWindAnimation() {
    stopWindAnimation();
    if (!state.windPlaying) return;
    rebuildWindTimelineSlots();
    const tick = () => {
      const slots = state.windTimelineSlots || [];
      if (!slots.length) { renderMapTimeline(); state.windLayer?.redraw?.(); return; }
      state.windTimelineActiveIndex = state.windTimelineIndex % slots.length;
      const slot = slots[state.windTimelineActiveIndex];
      state.windFrameIndex = closestWindFrameIndex(slot.time);
      renderMapTimeline();
      state.windLayer?.redraw?.();
      state.windTimelineIndex = (state.windTimelineIndex + 1) % slots.length;
    };
    tick();
    state.windTimer = setInterval(tick, Math.max(650, Number(state.config.hourly_wind_frame_ms ?? 1450)));
  }

  function stopWindAnimation() {
    if (state.windRaf) cancelAnimationFrame(state.windRaf);
    state.windRaf = 0;
    if (state.windTimer) clearInterval(state.windTimer);
    state.windTimer = null;
  }

  function setWindLayerVisible(on) {
    state.config.wind_layer_enabled = on;
    if (!state.map || !state.windLayer) return;
    if (on) {
      if (!state.map.hasLayer(state.windLayer)) state.windLayer.addTo(state.map);
      state.windPlaying = true;
      startWindAnimation();
    } else {
      if (state.map.hasLayer(state.windLayer)) state.map.removeLayer(state.windLayer);
      stopWindAnimation();
      renderMapTimeline();
    }
  }

  function renderMapTimeline() {
    const el = $("mapTimeline");
    if (!el) return;
    if (state.config.wind_layer_enabled === false) { el.hidden = true; el.innerHTML = ""; return; }
    if (!state.windTimelineSlots?.length) rebuildWindTimelineSlots();
    const slots = state.windTimelineSlots || [];
    if (!slots.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const activeIndex = Math.max(0, Math.min(slots.length - 1, Number(state.windTimelineActiveIndex || 0)));
    const active = slots[activeIndex] || slots[0];
    const tides = slots.map(s => Number(s.row?.tide_level_ft));
    const tideMin = Math.min(...tides.filter(Number.isFinite));
    const tideMax = Math.max(...tides.filter(Number.isFinite));
    const tidePath = slots.map((s, i) => {
      const x = slots.length <= 1 ? 0 : (i / (slots.length - 1) * 100);
      const tv = Number(s.row?.tide_level_ft);
      const y = Number.isFinite(tv) && Number.isFinite(tideMin) && Number.isFinite(tideMax) && tideMax !== tideMin ? 34 - ((tv - tideMin) / (tideMax - tideMin) * 24) : 22;
      return `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(" ");
    const sun = (forecastFor(state.selectedId)?.sun) || {};
    const sunriseH = decimalPacificHour(sun.sunrise_utc);
    const sunsetH = decimalPacificHour(sun.sunset_utc);
    const startH = slots[0].hour, endH = slots[slots.length - 1].hour;
    const pctForHour = h => Math.max(0, Math.min(100, ((h - startH) / (endH - startH || 1)) * 100));
    const dayStart = Number.isFinite(sunriseH) ? pctForHour(sunriseH) : 12;
    const dayEnd = Number.isFinite(sunsetH) ? pctForHour(sunsetH) : 86;
    const activePct = slots.length <= 1 ? 0 : activeIndex / (slots.length - 1) * 100;
    const hourLabel = fmtTime(active.time).replace(":00", "");
    const activeWave = `${cleanFt(active.row?.surf_min_ft)}-${cleanFt(active.row?.surf_max_ft)}ft`;
    const activeWind = `${active.row?.wind_speed_kt ?? "—"}kt`;
    el.innerHTML = `
      <div class="timeline-meta"><b>${hourLabel}</b><span>${activeWave}</span><span>${activeWind}</span><span>${cleanFt(active.row?.tide_level_ft)}ft tide</span></div>
      <div class="timeline-track">
        <div class="timeline-night pre" style="left:0;width:${dayStart}%"></div>
        <div class="timeline-day" style="left:${dayStart}%;width:${Math.max(0, dayEnd - dayStart)}%"></div>
        <div class="timeline-night post" style="left:${dayEnd}%;width:${Math.max(0, 100 - dayEnd)}%"></div>
        <svg class="timeline-tide" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path d="${tidePath}"/></svg>
        ${Number.isFinite(sunriseH) ? `<i class="sun-dot" style="left:${pctForHour(sunriseH)}%"><span>${fmtTime(sun.sunrise_utc).replace(":00","")}</span></i>` : ""}
        ${Number.isFinite(sunsetH) ? `<i class="sun-dot dusk" style="left:${pctForHour(sunsetH)}%"><span>${fmtTime(sun.sunset_utc).replace(":00","")}</span></i>` : ""}
        <div class="timeline-cursor" style="left:${activePct}%"></div>
      </div>
      <div class="timeline-hours">${slots.map((s, i) => `<span class="${i === activeIndex ? "active" : ""}">${fmtTime(s.time).replace(":00","")}</span>`).join("")}</div>`;
  }

  function decimalPacificHour(iso) {
    if (!iso) return NaN;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).reduce((a, p) => (a[p.type] = p.value, a), {});
      return Number(parts.hour) + Number(parts.minute || 0) / 60;
    } catch (_) { return NaN; }
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
      const fc = forecastFor(spot.id);
      const height = fc ? (dailyRangeFor(fc) || fc?.surf_height_ft?.human || "—") : "—";
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
      const height = fc ? (dailyRangeFor(fc) || fc?.surf_height_ft?.human || "—") : "—";
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
    state.windTimelineIndex = 0;
    state.windTimelineActiveIndex = 0;
    rebuildWindTimelineSlots();
    if (state.config.wind_layer_enabled !== false) startWindAnimation();
    else renderMapTimeline();
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

  function arrowSvg(directionDeg, enabled = true, color = null) {
    if (!enabled || directionDeg === null || directionDeg === undefined) return "";
    const rot = Number(directionDeg) || 0;
    const style = color ? ` style="--arrow-color:${color}"` : "";
    return `<span class="dir-arrow"${style} title="${rot}°"><svg viewBox="0 0 24 24" style="transform:rotate(${rot}deg)"><path d="M12 2 L17 15 L12 12 L7 15 Z" fill="currentColor"></path><circle cx="12" cy="12" r="2" fill="#0b2030"></circle></svg></span>`;
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
    if (show.wind !== false) cards.push(card("Wind", `<div class="arrow-row">${arrowSvg(wind.direction_deg, state.config.show_wind_arrows !== false, windSpeedColor(wind.speed_kt))}<span>${wind.direction_compass || "—"} ${wind.speed_kt ?? "—"} kt</span></div>`, `Gust ${wind.gust_kt ?? "—"} kt · ${escapeHtml(wind.quality || "unknown")} · ${escapeHtml(wind.source || "model")}`));
    if (show.tide !== false) cards.push(card("Tide", `${tide.level_ft ?? "—"} ft`, `${escapeHtml(tide.trend || "unknown")} · ${escapeHtml(tide.station_name || "NOAA CO-OPS")}`));
    if (show.sun !== false) cards.push(card("Sun", `${fmtTime(sun.sunrise_utc)} / ${fmtTime(sun.sunset_utc)}`, "sunrise / sunset · Pacific time"));
    if (show.confidence !== false) cards.push(card("Confidence", `${Math.round((fc.confidence || 0) * 100)}%`, `${escapeHtml(fc.best_window || "—")} · ${escapeHtml(fc.rating || "unknown")}`));
    if (show.model !== false) cards.push(card("Why this call", escapeHtml(notes.callout || "—"), `Exposure ${notes.transform?.directional_exposure ?? "—"} · bathy gain ${notes.transform?.bathymetry_gain ?? "—"}`, "full"));
    if (show.hourly !== false) cards.push(`<article class="info-card full"><div class="kicker">48 hour snapshots</div>${renderThirtyNineHourSnapshots(fc.hourly || [], spot)}</article>`);
    if (show.five_day !== false) cards.push(`<article class="info-card full"><div class="kicker">5 day forecast</div>${renderFiveDayForecast(fc.hourly || [], spot)}</article>`);
    if (show.warnings !== false && (fc.warnings || []).length) cards.push(`<div class="warning-list"><strong>Data warnings:</strong><br>${(fc.warnings || []).slice(0, 7).map(escapeHtml).join("<br>")}</div>`);
    const dayRange = dailyRangeFor(fc);
    panel.innerHTML = `
      <div class="forecast-head">
        <div class="forecast-title"><h2>${escapeHtml(spot.name)}</h2><p>${escapeHtml(spot.region || "California")} · updated ${fmtDateTime(fc.last_updated)}</p></div>
        <div class="big-height"><small>daily range</small><strong>${escapeHtml(dayRange || fc.surf_height_ft?.human || "—")}</strong><span class="rating ${ratingClass(fc.rating)}">${escapeHtml(fc.rating || "unknown")}</span></div>
      </div>
      <div class="card-grid">${cards.join("")}</div>`;
  }

  function cleanFt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 2) / 2).replace(/\.0$/, "");
  }

  function dailyRangeFor(fc) {
    const rows = fc?.hourly || [];
    if (!rows.length) return fc?.surf_height_ft?.human || "";
    const key = dayKey(fc.last_updated || rows[0]?.time);
    const dayRows = rows.filter(r => dayKey(r.time) === key && localHour(r.time) >= 6 && localHour(r.time) <= 19);
    const usable = dayRows.length ? dayRows : rows.slice(0, 8);
    const lows = usable.map(r => Number(r.surf_min_ft)).filter(Number.isFinite);
    const highs = usable.map(r => Number(r.surf_max_ft)).filter(Number.isFinite);
    if (!lows.length || !highs.length) return fc?.surf_height_ft?.human || "";
    return `${cleanFt(Math.min(...lows))}-${cleanFt(Math.max(...highs))} ft`;
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
    for (let h = 0; h <= 48; h += 3) {
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

  function renderFiveDayForecast(rows, spot) {
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
      const wc = windConditionColor(r, spot);
      return `<div class="day-hour" style="--hour-color:${waveColor(high)};--wind-color:${wc}"><span>${fmtTime(r.time).replace(":00", "")}</span><strong>${r.surf_min_ft}-${r.surf_max_ft}</strong><em>${r.wind_speed_kt ?? "—"} kt</em></div>`;
    }).join("")}</div>`).join("")}</div>`;
  }

  function renderGradientLegend() {
    const el = $("mapGradientLegend");
    if (!el) return;
    const mode = state.config.marker_color_mode || "rating";
    let label = "Spot quality";
    let low = gradientConfig("spot_rating").poor || "#e05b52";
    let mid = gradientConfig("spot_rating").fair || "#f4c542";
    let high = gradientConfig("spot_rating").good || "#1ecb78";
    let minText = "poor", maxText = "good";
    if (mode === "wave_size") {
      const g = gradientConfig("wave_height");
      low = g.low || "#1eb6d0"; mid = g.mid || "#22c55e"; high = g.high || "#f97316";
      label = "Wave size"; minText = `${g.min ?? 0}ft`; maxText = `${g.max ?? 18}ft`;
    } else if (["morning", "afternoon", "evening"].includes(mode)) {
      label = mode.replace(/^./, c => c.toUpperCase()) + " window";
      minText = "worse"; maxText = "best";
    }
    el.innerHTML = `<span>${label}</span><i style="background:linear-gradient(180deg,${high},${mid},${low})"></i><b>${maxText}</b><b>${minText}</b>`;
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
    $("markerColorMode")?.addEventListener("change", e => {
      state.config.marker_color_mode = e.target.value;
      refreshMarkerIcons();
      renderSpotList();
      renderGradientLegend();
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
      // Fast first paint: use native/static JSON immediately. Supabase settings/spots
      // are applied non-blocking below, so the app does not wait on a database roundtrip.
      state.spots = spots.sort((a, b) => Number(b.lat) - Number(a.lat));
      state.forecasts = latest.forecasts || {};
      state.latest = latest;
      state.waveGrid = waveGrid;
      state.windGrid = windGrid;
      const statusEl = $("globalStatus");
      if (statusEl) { statusEl.textContent = ""; statusEl.hidden = true; }
      $("modelRefresh").textContent = `${state.config.text?.refresh_prefix || "model refresh:"} ${fmtDateTime(latest.generated_at)}`;
      $("waveLayerToggle").checked = state.config.wave_layer_enabled === true;
      if ($("windLayerToggle")) $("windLayerToggle").checked = state.config.wind_layer_enabled !== false;
      $("markerColorMode").value = state.config.marker_color_mode || "rating";
      bindControls();
      syncRegionChips();
      initMap();
      updateWaveFrameLabel();
      updateWindFrameLabel();
      renderGradientLegend();
      renderSpotList();
      const first = filteredSpots().find(s => forecastFor(s.id)) || filteredSpots()[0] || activeSpots()[0];
      if (first) selectSpot(first.id, false, false);
      maybeAutoCenterOnLocation();

      loadSupabasePublicData().then(supa => {
        if (!supa || (!supa.config && !supa.spots)) return;
        if (supa.config) { state.config = mergeDeep(state.config, supa.config); applyConfig(state.config); }
        if (supa.spots) state.spots = supa.spots.sort((a, b) => Number(b.lat) - Number(a.lat));
        syncRegionChips();
        if ($("waveLayerToggle")) $("waveLayerToggle").checked = state.config.wave_layer_enabled === true;
        if ($("windLayerToggle")) $("windLayerToggle").checked = state.config.wind_layer_enabled !== false;
        if ($("markerColorMode")) $("markerColorMode").value = state.config.marker_color_mode || "rating";
        drawMarkers({ fit: false });
        renderGradientLegend();
        renderSpotList();
        renderForecast();
        startWindAnimation();
      }).catch(err => console.warn("Supabase override unavailable", err));
    } catch (err) {
      console.error(err);
      if ($("globalStatus")) $("globalStatus").textContent = "Data failed to load";
      $("forecastPanel").innerHTML = `<div class="empty-state">Could not load data. Check that public/data/spots.json, latest_forecasts.json, wave_grid_24h.json, and wind_grid_latest.json exist.</div>`;
    }
  }

  boot();
})();
