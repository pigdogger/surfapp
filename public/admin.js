/* Local-only admin controls for Stage 1. */
(() => {
  const DEFAULT_CONFIG = {
    data_base_url: "./data",
    theme: { bg: "#071622", panel: "#0e2434", accent: "#1bb8d4", accent2: "#ff7f50" },
    marker_size: 13,
    typography_scale: 1,
    layout: "full",
    show_cards: { swell: true, wind: true, tide: true, sun: true, confidence: true, model: true, hourly: true, warnings: true },
    show_swell_arrows: true,
    show_wind_arrows: true,
    show_bathymetry: true,
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

  function applyConfigToForm() {
    const c = state.config;
    $("bgColor").value = c.theme.bg;
    $("panelColor").value = c.theme.panel;
    $("accentColor").value = c.theme.accent;
    $("accent2Color").value = c.theme.accent2;
    $("markerSize").value = c.marker_size;
    $("fontScale").value = c.typography_scale;
    $("layoutMode").value = c.layout;
    $("cardSwell").checked = c.show_cards.swell !== false;
    $("cardWind").checked = c.show_cards.wind !== false;
    $("cardTide").checked = c.show_cards.tide !== false;
    $("cardSun").checked = c.show_cards.sun !== false;
    $("cardConfidence").checked = c.show_cards.confidence !== false;
    $("cardModel").checked = c.show_cards.model !== false;
    $("cardHourly").checked = c.show_cards.hourly !== false;
    $("cardWarnings").checked = c.show_cards.warnings !== false;
    $("showSwellArrows").checked = c.show_swell_arrows !== false;
    $("showWindArrows").checked = c.show_wind_arrows !== false;
    $("showBathymetry").checked = c.show_bathymetry !== false;
    previewConfig();
  }

  function readConfigFromForm() {
    state.config = mergeDeep(state.config, {
      theme: {
        bg: $("bgColor").value,
        panel: $("panelColor").value,
        accent: $("accentColor").value,
        accent2: $("accent2Color").value
      },
      marker_size: Number($("markerSize").value),
      typography_scale: Number($("fontScale").value),
      layout: $("layoutMode").value,
      show_cards: {
        swell: $("cardSwell").checked,
        wind: $("cardWind").checked,
        tide: $("cardTide").checked,
        sun: $("cardSun").checked,
        confidence: $("cardConfidence").checked,
        model: $("cardModel").checked,
        hourly: $("cardHourly").checked,
        warnings: $("cardWarnings").checked
      },
      show_swell_arrows: $("showSwellArrows").checked,
      show_wind_arrows: $("showWindArrows").checked,
      show_bathymetry: $("showBathymetry").checked
    });
    previewConfig();
  }

  function save() {
    readConfigFromForm();
    localStorage.setItem("surfAppAdminConfig", JSON.stringify(state.config, null, 2));
    alert("Saved to this browser. Open index.html in the same browser to see it.");
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
        localStorage.setItem("surfAppAdminConfig", JSON.stringify(state.config, null, 2));
        previewConfig();
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  function addSpot() {
    readConfigFromForm();
    const name = $("newName").value.trim();
    const lat = Number($("newLat").value);
    const lon = Number($("newLon").value);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert("Name, latitude, and longitude are required.");
      return;
    }
    const orientation = Number($("newOrientation").value || 260);
    const exp = Number($("newExposure").value || 1.0);
    const spot = {
      id: slugify(name),
      name,
      lat,
      lon,
      region: $("newRegion").value.trim() || "Custom",
      active: true,
      beach_orientation_deg: Number.isFinite(orientation) ? orientation : 260,
      bathymetry: { slope_5_20m: null, canyon_multiplier: 1.0, reef_multiplier: 1.0, shadowing_multiplier: 1.0, source: "admin_local" },
      exposure_by_direction: exposureTable(exp),
      public_data: { nearest_tide_station: null, buoy_candidates: [] },
      notes: "Added locally in admin page."
    };
    state.config.added_spots = [...(state.config.added_spots || []).filter(s => s.id !== spot.id), spot];
    localStorage.setItem("surfAppAdminConfig", JSON.stringify(state.config, null, 2));
    renderSpotList();
    previewConfig();
    alert("Added locally. To make it permanent, add it to the CSV or spots.json and commit.");
  }

  function bind() {
    document.querySelectorAll("input, select").forEach(el => {
      if (!el.closest("#adminSpotList")) el.addEventListener("input", readConfigFromForm);
    });
    $("saveConfig").addEventListener("click", save);
    $("downloadConfig").addEventListener("click", () => { readConfigFromForm(); download("site_config.json", JSON.stringify(state.config, null, 2) + "\n"); });
    $("resetConfig").addEventListener("click", () => {
      localStorage.removeItem("surfAppAdminConfig");
      state.config = structuredClone(DEFAULT_CONFIG);
      applyConfigToForm();
      renderSpotList();
    });
    $("addSpot").addEventListener("click", addSpot);
    $("downloadSpots").addEventListener("click", () => download("spots_override.json", JSON.stringify(state.config.added_spots || [], null, 2) + "\n"));
    $("spotFilter").addEventListener("input", e => { state.filter = e.target.value; renderSpotList(); });
  }

  async function boot() {
    try {
      const fileConfig = await fetchJson("site_config.json").catch(() => ({}));
      const localConfig = JSON.parse(localStorage.getItem("surfAppAdminConfig") || "null") || {};
      state.config = mergeDeep(mergeDeep(DEFAULT_CONFIG, fileConfig), localConfig);
      state.spots = await fetchJson("spots.json");
    } catch (err) {
      console.error(err);
      state.spots = [];
    }
    applyConfigToForm();
    renderSpotList();
    bind();
  }

  boot();
})();
