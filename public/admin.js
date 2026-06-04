/* Local-only admin controls for CaliSurf Light. */
(() => {
  const ADMIN_EMAIL = "admin@calisurf.com";
  const ADMIN_PASSWORD = "bonitaindo26";

  const DEFAULT_CONFIG = {
    data_base_url: "./data",
    theme: { bg: "#071622", panel: "#0e2434", accent: "#1bb8d4", accent2: "#ff7f50" },
    marker_size: 7,
    marker_color_mode: "rating",
    typography_scale: 1,
    corner_radius: 8,
    edge_buffer: 22,
    wave_layer_enabled: true,
    wave_layer_opacity: 0.44,
    show_wave_direction_arrows: true,
    default_region: "san-diego",
    layout: "full",
    show_cards: { swell: true, wind: true, tide: true, sun: true, confidence: true, model: true, hourly: true, five_day: true, warnings: true },
    show_swell_arrows: true,
    show_wind_arrows: true,
    hidden_spot_ids: [],
    added_spots: []
  };

  const state = { config: structuredClone(DEFAULT_CONFIG), spots: [], filter: "" };
  const $ = id => document.getElementById(id);

  function mergeDeep(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    if (!override || typeof override !== "object") return out;
    for (const [key, value] of Object.entries(override)) {
      if (value && typeof value === "object" && !Array.isArray(value)) out[key] = mergeDeep(out[key] || {}, value);
      else out[key] = value;
    }
    return out;
  }

  async function fetchJson(name) {
    const res = await fetch(`./data/${name}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(name);
    return res.json();
  }

  function slugify(value) {
    return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "spot";
  }

  function exposureTable(value) {
    const v = Number(value || 1.0);
    const out = {};
    for (let d = 0; d < 360; d += 15) out[String(d)] = Math.max(0.05, Math.min(1.65, v));
    return out;
  }

  function setUnlocked(unlocked) {
    $("loginWrap").classList.toggle("unlocked", unlocked);
    $("adminShell").classList.toggle("locked", !unlocked);
  }

  function attemptLogin() {
    const email = $("loginEmail").value.trim().toLowerCase();
    const password = $("loginPassword").value;
    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      sessionStorage.setItem("calisurfAdminLoggedIn", "1");
      setUnlocked(true);
      initAdmin();
    } else {
      $("loginError").textContent = "Wrong email or password.";
    }
  }

  function logout() {
    sessionStorage.removeItem("calisurfAdminLoggedIn");
    setUnlocked(false);
  }

  function applyConfigToForm() {
    const c = state.config;
    $("bgColor").value = c.theme.bg;
    $("panelColor").value = c.theme.panel;
    $("accentColor").value = c.theme.accent;
    $("accent2Color").value = c.theme.accent2;
    $("markerSize").value = c.marker_size;
    $("markerColorMode").value = c.marker_color_mode || "rating";
    $("fontScale").value = c.typography_scale;
    $("cornerRadius").value = c.corner_radius ?? 8;
    $("edgeBuffer").value = c.edge_buffer ?? 22;
    $("waveLayerEnabled").checked = c.wave_layer_enabled !== false;
    $("waveLayerOpacity").value = c.wave_layer_opacity ?? 0.44;
    $("showWaveDirectionArrows").checked = c.show_wave_direction_arrows !== false;
    $("defaultRegion").value = c.default_region || "san-diego";
    $("layoutMode").value = c.layout;
    $("cardSwell").checked = c.show_cards.swell !== false;
    $("cardWind").checked = c.show_cards.wind !== false;
    $("cardTide").checked = c.show_cards.tide !== false;
    $("cardSun").checked = c.show_cards.sun !== false;
    $("cardConfidence").checked = c.show_cards.confidence !== false;
    $("cardModel").checked = c.show_cards.model !== false;
    $("cardHourly").checked = c.show_cards.hourly !== false;
    $("cardFiveDay").checked = c.show_cards.five_day !== false;
    $("cardWarnings").checked = c.show_cards.warnings !== false;
    $("showSwellArrows").checked = c.show_swell_arrows !== false;
    $("showWindArrows").checked = c.show_wind_arrows !== false;
    previewConfig();
  }

  function readConfigFromForm() {
    state.config = mergeDeep(state.config, {
      theme: { bg: $("bgColor").value, panel: $("panelColor").value, accent: $("accentColor").value, accent2: $("accent2Color").value },
      marker_size: Number($("markerSize").value),
      marker_color_mode: $("markerColorMode").value,
      typography_scale: Number($("fontScale").value),
      corner_radius: Number($("cornerRadius").value),
      edge_buffer: Number($("edgeBuffer").value),
      wave_layer_enabled: $("waveLayerEnabled").checked,
      wave_layer_opacity: Number($("waveLayerOpacity").value),
      show_wave_direction_arrows: $("showWaveDirectionArrows").checked,
      default_region: $("defaultRegion").value,
      layout: $("layoutMode").value,
      show_cards: {
        swell: $("cardSwell").checked,
        wind: $("cardWind").checked,
        tide: $("cardTide").checked,
        sun: $("cardSun").checked,
        confidence: $("cardConfidence").checked,
        model: $("cardModel").checked,
        hourly: $("cardHourly").checked,
        five_day: $("cardFiveDay").checked,
        warnings: $("cardWarnings").checked
      },
      show_swell_arrows: $("showSwellArrows").checked,
      show_wind_arrows: $("showWindArrows").checked
    });
    previewConfig();
  }

  function save() {
    readConfigFromForm();
    localStorage.setItem("surfAppAdminConfig", JSON.stringify(state.config, null, 2));
    alert("Saved to this browser. Open the public page in this same browser to see it.");
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function previewConfig() {
    $("configPreview").textContent = JSON.stringify(state.config, null, 2);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  function renderSpotList() {
    const q = state.filter.trim().toLowerCase();
    const hidden = new Set(state.config.hidden_spot_ids || []);
    const added = state.config.added_spots || [];
    const all = [...state.spots, ...added].filter(s => !q || s.name.toLowerCase().includes(q) || (s.region || "").toLowerCase().includes(q));
    $("adminSpotList").innerHTML = all.map(s => {
      const isHidden = hidden.has(s.id);
      return `<div class="admin-spot">
        <span><strong>${escapeHtml(s.name)}</strong><br><small>${escapeHtml(s.region || "California")} · ${Number(s.lat).toFixed(4)}, ${Number(s.lon).toFixed(4)}</small></span>
        <label><input type="checkbox" data-id="${s.id}" ${isHidden ? "" : "checked"}> visible</label>
      </div>`;
    }).join("") || `<p class="notice">No matching spots.</p>`;
    document.querySelectorAll("#adminSpotList input[type=checkbox]").forEach(cb => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.id;
        const set = new Set(state.config.hidden_spot_ids || []);
        if (cb.checked) set.delete(id); else set.add(id);
        state.config.hidden_spot_ids = [...set];
        previewConfig();
      });
    });
  }

  function addSpot() {
    const name = $("newName").value.trim();
    const lat = Number($("newLat").value);
    const lon = Number($("newLon").value);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert("Name, latitude, and longitude are required.");
      return;
    }
    const orientation = Number($("newOrientation").value || 260);
    const exposure = Number($("newExposure").value || 1.0);
    const id = slugify(name);
    const spot = {
      id,
      name,
      region: $("newRegion").value.trim() || "Custom",
      lat,
      lon,
      active: true,
      beach_orientation_deg: orientation,
      bathymetry: { slope_5_20m: 0.035, canyon_multiplier: 1.0, reef_multiplier: 1.0, shadowing_multiplier: 1.0, source: "admin_local" },
      exposure_by_direction: exposureTable(exposure),
      public_data: { nearest_tide_station: null, buoy_candidates: [] },
      notes: "Added from local admin console."
    };
    const arr = state.config.added_spots || [];
    const idx = arr.findIndex(s => s.id === id);
    if (idx >= 0) arr[idx] = spot; else arr.push(spot);
    state.config.added_spots = arr;
    renderSpotList();
    previewConfig();
  }

  async function initAdmin() {
    if (state._loaded) return;
    state._loaded = true;
    try {
      const [spots, fileConfig] = await Promise.all([fetchJson("spots.json"), fetchJson("site_config.json").catch(() => ({}))]);
      state.spots = spots.sort((a, b) => Number(a.lat) - Number(b.lat));
      state.config = mergeDeep(DEFAULT_CONFIG, fileConfig);
      try {
        const local = JSON.parse(localStorage.getItem("surfAppAdminConfig") || "null");
        if (local) state.config = mergeDeep(state.config, local);
      } catch (_) {}
      applyConfigToForm();
      renderSpotList();
    } catch (err) {
      console.error(err);
      $("configPreview").textContent = "Could not load spots/config. Check public/data files.";
    }
  }

  function bind() {
    $("loginButton").addEventListener("click", attemptLogin);
    $("loginPassword").addEventListener("keydown", e => { if (e.key === "Enter") attemptLogin(); });
    $("logoutButton").addEventListener("click", logout);
    ["bgColor", "panelColor", "accentColor", "accent2Color", "markerSize", "markerColorMode", "fontScale", "cornerRadius", "edgeBuffer", "waveLayerEnabled", "waveLayerOpacity", "showWaveDirectionArrows", "defaultRegion", "layoutMode", "cardSwell", "cardWind", "cardTide", "cardSun", "cardConfidence", "cardModel", "cardHourly", "cardFiveDay", "cardWarnings", "showSwellArrows", "showWindArrows"].forEach(id => {
      $(id).addEventListener("input", readConfigFromForm);
      $(id).addEventListener("change", readConfigFromForm);
    });
    $("saveConfig").addEventListener("click", save);
    $("downloadConfig").addEventListener("click", () => { readConfigFromForm(); download("site_config.json", JSON.stringify(state.config, null, 2)); });
    $("resetConfig").addEventListener("click", () => { state.config = structuredClone(DEFAULT_CONFIG); localStorage.removeItem("surfAppAdminConfig"); applyConfigToForm(); renderSpotList(); });
    $("addSpot").addEventListener("click", addSpot);
    $("downloadSpots").addEventListener("click", () => download("spots_override.json", JSON.stringify(state.config.added_spots || [], null, 2)));
    $("spotFilter").addEventListener("input", e => { state.filter = e.target.value; renderSpotList(); });
  }

  bind();
  if (sessionStorage.getItem("calisurfAdminLoggedIn") === "1") {
    setUnlocked(true);
    initAdmin();
  } else {
    setUnlocked(false);
  }
})();
