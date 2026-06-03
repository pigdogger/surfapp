/* California Surf Light public app
   This file intentionally uses plain JavaScript. No build step required. */
(() => {
  const DEFAULT_CONFIG = {
    data_base_url: "./data",
    theme: {
      bg: "#071622",
      panel: "#0e2434",
      accent: "#1bb8d4",
      accent2: "#ff7f50"
    },
    marker_size: 13,
    typography_scale: 1,
    layout: "full",
    show_cards: {
      swell: true,
      wind: true,
      tide: true,
      sun: true,
      confidence: true,
      model: true,
      hourly: true,
      warnings: true
    },
    show_swell_arrows: true,
    show_wind_arrows: true,
    show_bathymetry: true
  };

  const state = {
    config: structuredClone(DEFAULT_CONFIG),
    spots: [],
    forecasts: {},
    selectedId: null,
    region: "all",
    search: "",
    map: null,
    markerLayer: null,
    bathyLayer: null,
    markers: new Map()
  };

  const $ = (id) => document.getElementById(id);

  function mergeDeep(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    if (!override || typeof override !== "object") return out;
    for (const [key, value] of Object.entries(override)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = mergeDeep(out[key] || {}, value);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async function fetchJson(baseUrl, name, fallback = null) {
    const clean = baseUrl.replace(/\/$/, "");
    const url = `${clean}/${name}?_=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${name} ${res.status}`);
    return res.json();
  }

  async function loadConfig() {
    let config = structuredClone(DEFAULT_CONFIG);
    try {
      const fromFile = await fetchJson("./data", "site_config.json");
      config = mergeDeep(config, fromFile);
    } catch (_) {
      // The app works without site_config.json.
    }
    try {
      const fromAdmin = JSON.parse(localStorage.getItem("surfAppAdminConfig") || "null");
      if (fromAdmin) config = mergeDeep(config, fromAdmin);
    } catch (_) {}
    state.config = config;
    applyConfig(config);
  }

  function applyConfig(config) {
    const root = document.documentElement;
    root.style.setProperty("--bg", config.theme?.bg || DEFAULT_CONFIG.theme.bg);
    root.style.setProperty("--panel", config.theme?.panel || DEFAULT_CONFIG.theme.panel);
    root.style.setProperty("--accent", config.theme?.accent || DEFAULT_CONFIG.theme.accent);
    root.style.setProperty("--accent-2", config.theme?.accent2 || DEFAULT_CONFIG.theme.accent2);
    root.style.setProperty("--marker-size", `${config.marker_size || 13}px`);
    root.style.setProperty("--base-font-scale", config.typography_scale || 1);
    const toggle = $("bathyToggle");
    if (toggle) toggle.checked = config.show_bathymetry !== false;
  }

  function forecastFor(spotId) {
    return state.forecasts[spotId] || null;
  }

  function allSpots() {
    return [...state.spots, ...(state.config.added_spots || [])].sort((a, b) => a.lat - b.lat);
  }

  function activeSpots() {
    const hidden = new Set(state.config.hidden_spot_ids || []);
    return allSpots().filter(s => s.active !== false && !hidden.has(s.id));
  }

  function filteredSpots() {
    const q = state.search.trim().toLowerCase();
    return activeSpots().filter(s => {
      const regionOk = state.region === "all" || s.region === state.region;
      const qOk = !q || s.name.toLowerCase().includes(q) || (s.region || "").toLowerCase().includes(q);
      return regionOk && qOk;
    });
  }

  function initMap() {
    if (!window.L) {
      $("map").innerHTML = `<div class="empty-state">Map library did not load. The spot list still works.</div>`;
      return;
    }
    state.map = L.map("map", { zoomControl: true, scrollWheelZoom: true }).setView([36.6, -121.7], 6);

    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Esri Ocean Basemap",
      maxZoom: 13
    }).addTo(state.map);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Esri",
      maxZoom: 13
    }).addTo(state.map);

    state.markerLayer = L.layerGroup().addTo(state.map);
    state.bathyLayer = L.layerGroup().addTo(state.map);
    drawBathymetryOverlay();
    drawMarkers();
  }

  function markerHtml(spotId) {
    const cls = spotId === state.selectedId ? "spot-marker active" : "spot-marker";
    return `<div class="${cls}"></div>`;
  }

  function drawMarkers() {
    if (!state.map) return;
    state.markerLayer.clearLayers();
    state.markers.clear();
    const visible = filteredSpots();
    visible.forEach(spot => {
      const icon = L.divIcon({
        className: "",
        html: markerHtml(spot.id),
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      const marker = L.marker([spot.lat, spot.lon], { icon, title: spot.name });
      marker.on("click", () => selectSpot(spot.id, true));
      marker.addTo(state.markerLayer);
      state.markers.set(spot.id, marker);
    });
    if (visible.length) {
      const bounds = L.latLngBounds(visible.map(s => [s.lat, s.lon]));
      state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 9 });
    }
  }

  function refreshMarkerIcons() {
    state.markers.forEach((marker, spotId) => {
      marker.setIcon(L.divIcon({ className: "", html: markerHtml(spotId), iconSize: [24, 24], iconAnchor: [12, 12] }));
    });
  }

  function drawBathymetryOverlay() {
    if (!state.map || !state.bathyLayer) return;
    state.bathyLayer.clearLayers();
    if (!$("bathyToggle")?.checked) return;

    // Lightweight visual contour overlay. It uses the spot coastline itself as a guide.
    // Real bathymetry coefficients are precomputed in spots.json; this layer is for UI context.
    const coast = activeSpots().map(s => [s.lat, s.lon]).sort((a, b) => a[0] - b[0]);
    const offsets = [0.08, 0.16, 0.27, 0.42];
    offsets.forEach((offset, i) => {
      const line = coast.map(([lat, lon]) => [lat, lon - offset - i * 0.015]);
      L.polyline(line, { className: "bathy-line", interactive: false }).addTo(state.bathyLayer);
    });
  }

  function renderSpotList() {
    const list = $("spotList");
    const spots = filteredSpots();
    list.innerHTML = spots.map(spot => {
      const fc = forecastFor(spot.id);
      const height = fc?.surf_height_ft?.human || "—";
      const rating = fc?.rating || "loading";
      return `<button class="spot-row ${spot.id === state.selectedId ? "is-active" : ""}" data-id="${spot.id}">
        <span><strong>${escapeHtml(spot.name)}</strong><small>${escapeHtml(spot.region || "California")} · ${escapeHtml(rating)}</small></span>
        <span class="height-badge">${escapeHtml(height)}</span>
      </button>`;
    }).join("") || `<div class="empty-state">No spots match this filter.</div>`;

    list.querySelectorAll(".spot-row").forEach(btn => {
      btn.addEventListener("click", () => selectSpot(btn.dataset.id, true));
    });
  }

  function selectSpot(spotId, panMap = false) {
    state.selectedId = spotId;
    renderSpotList();
    refreshMarkerIcons();
    renderForecast();
    if (panMap && state.map) {
      const spot = allSpots().find(s => s.id === spotId);
      if (spot) state.map.setView([spot.lat, spot.lon], Math.max(state.map.getZoom(), 9), { animate: true });
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  function ratingClass(rating) {
    return String(rating || "unknown").toLowerCase().replace(/[^a-z]+/g, "-");
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "2-digit"
      }).format(new Date(iso));
    } catch (_) {
      return iso;
    }
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(new Date(iso));
    } catch (_) {
      return iso;
    }
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
    if (!spot) {
      panel.innerHTML = `<div class="empty-state">Select a spot from the map or list.</div>`;
      return;
    }
    const fc = forecastFor(spot.id);
    if (!fc) {
      panel.innerHTML = `<div class="empty-state">No forecast found for ${escapeHtml(spot.name)}.</div>`;
      return;
    }
    const show = state.config.show_cards || DEFAULT_CONFIG.show_cards;
    const ps = fc.primary_swell || {};
    const ss = fc.secondary_swell || {};
    const wind = fc.wind || {};
    const tide = fc.tide || {};
    const sun = fc.sun || {};
    const notes = fc.model_notes || {};

    const cards = [];
    if (show.swell !== false) {
      cards.push(card("Primary swell", `
        <div class="arrow-row">${arrowSvg(ps.direction_deg, state.config.show_swell_arrows !== false)}<span>${ps.height_ft ?? "—"} ft @ ${ps.period_s ?? "—"}s</span></div>
      `, `${ps.direction_compass || "—"} ${ps.direction_deg ?? "—"}° · ${escapeHtml(ps.station_name || ps.source || "public wave source")}`));
      cards.push(card("Secondary swell", `
        <div class="arrow-row">${arrowSvg(ss.direction_deg, state.config.show_swell_arrows !== false)}<span>${ss.height_ft ?? "—"} ft @ ${ss.period_s ?? "—"}s</span></div>
      `, `${ss.direction_compass || "—"} ${ss.direction_deg ?? "—"}°`));
    }
    if (show.wind !== false) {
      cards.push(card("Wind", `
        <div class="arrow-row">${arrowSvg(wind.direction_deg, state.config.show_wind_arrows !== false)}<span>${wind.direction_compass || "—"} ${wind.speed_kt ?? "—"} kt</span></div>
      `, `Gust ${wind.gust_kt ?? "—"} kt · ${escapeHtml(wind.quality || "unknown")} · ${escapeHtml(wind.source || "fallback")}`));
    }
    if (show.tide !== false) {
      cards.push(card("Tide", `${tide.level_ft ?? "—"} ft`, `${escapeHtml(tide.trend || "unknown")} · ${escapeHtml(tide.station_name || "NOAA CO-OPS")}`));
    }
    if (show.sun !== false) {
      cards.push(card("Sun", `${fmtTime(sun.sunrise_utc)} / ${fmtTime(sun.sunset_utc)}`, "sunrise / sunset · Pacific time"));
    }
    if (show.confidence !== false) {
      cards.push(card("Confidence", `${Math.round((fc.confidence || 0) * 100)}%`, `${escapeHtml(fc.best_window || "—")} · ${escapeHtml(fc.rating || "unknown")}`));
    }
    if (show.model !== false) {
      cards.push(card("Why this call", escapeHtml(notes.callout || "—"), `Exposure ${notes.transform?.directional_exposure ?? "—"} · bathy gain ${notes.transform?.bathymetry_gain ?? "—"}`, "full"));
    }
    if (show.hourly !== false) {
      cards.push(`<article class="info-card full"><div class="kicker">24-hour sketch</div>${renderHourly(fc.hourly || [])}</article>`);
    }
    if (show.warnings !== false && (fc.warnings || []).length) {
      cards.push(`<div class="warning-list"><strong>Data warnings:</strong><br>${(fc.warnings || []).slice(0, 7).map(escapeHtml).join("<br>")}</div>`);
    }

    panel.innerHTML = `
      <div class="forecast-head">
        <div class="forecast-title">
          <h2>${escapeHtml(spot.name)}</h2>
          <p>${escapeHtml(spot.region || "California")} · updated ${fmtDateTime(fc.last_updated)}</p>
        </div>
        <div class="big-height">
          <strong>${escapeHtml(fc.surf_height_ft?.human || "—")}</strong>
          <span class="rating ${ratingClass(fc.rating)}">${escapeHtml(fc.rating || "unknown")}</span>
        </div>
      </div>
      <div class="card-grid">${cards.join("")}</div>
    `;
  }

  function renderHourly(rows) {
    if (!rows.length) return `<div class="metric-sub">No hourly values in this forecast.</div>`;
    const maxH = Math.max(2, ...rows.map(r => Number(r.surf_max_ft || 0)));
    return `<div class="hourly">${rows.map(r => {
      const width = Math.max(4, (Number(r.surf_max_ft || 0) / maxH) * 100);
      return `<div class="hour-row">
        <span>${fmtTime(r.time)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
        <strong>${r.surf_min_ft}-${r.surf_max_ft}</strong>
        <span class="hide-small">${r.tide_level_ft} ft</span>
      </div>`;
    }).join("")}</div>`;
  }

  function bindControls() {
    document.querySelectorAll(".chip[data-region]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".chip[data-region]").forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        state.region = btn.dataset.region;
        renderSpotList();
        drawMarkers();
        drawBathymetryOverlay();
      });
    });
    $("spotSearch").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderSpotList();
      drawMarkers();
    });
    $("bathyToggle").addEventListener("change", drawBathymetryOverlay);
  }

  async function boot() {
    try {
      await loadConfig();
      const dataBase = state.config.data_base_url || "./data";
      const [spots, latest] = await Promise.all([
        fetchJson(dataBase, "spots.json"),
        fetchJson(dataBase, "latest_forecasts.json")
      ]);
      state.spots = spots.sort((a, b) => a.lat - b.lat);
      state.forecasts = latest.forecasts || {};
      $("globalStatus").textContent = `${state.spots.length} spots · ${fmtDateTime(latest.generated_at)}`;
      bindControls();
      initMap();
      renderSpotList();
      const first = filteredSpots().find(s => forecastFor(s.id)) || filteredSpots()[0];
      if (first) selectSpot(first.id, false);
    } catch (err) {
      console.error(err);
      $("globalStatus").textContent = "Data failed to load";
      $("forecastPanel").innerHTML = `<div class="empty-state">Could not load data. Check that public/data/spots.json and public/data/latest_forecasts.json exist.</div>`;
    }
  }

  boot();
})();
