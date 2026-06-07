/* CaliSurf Light admin console · Supabase-direct · v2.6 hourly wind/map timeline controls. */
(() => {
  const FALLBACK_ADMIN_EMAIL = "admin@calisurf.com";
  const FALLBACK_ADMIN_PASSWORD = "bonitaindo26";

  const DEFAULT_CONFIG = {
    data_base_url: "https://raw.githubusercontent.com/pigdogger/surfapp/main/public/data",
    theme: { bg: "#071622", panel: "#0e2434", accent: "#1bb8d4", accent2: "#ff7f50" },
    gradients: {
      wind_speed: { min: 0, max: 24, low: "#8ee8ff", mid: "#f4c542", high: "#ef4444" },
      spot_rating: { poor: "#e05b52", fair: "#f4c542", good: "#1ecb78", flat: "#8da2af" },
      wave_height: { min: 0, max: 18, low: "#1eb6d0", mid: "#22c55e", high: "#f97316" }
    },
    text: { model_label: "WEST COAST MODEL V1", app_title: "CaliSurf Light", refresh_prefix: "model refresh:", install_label: "Install app", search_placeholder: "Search surf spots…" },
    typography: { family: "Raleway, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", title_weight: 300, body_weight: 500, spot_name_weight: 550, spot_meta_weight: 600, letter_spacing: 0.02, title_color: "#ffffff", label_color: "#8edceb", spot_name_color: "#ffffff", spot_meta_color: "#a6bfcc" },
    marker_size: 6,
    marker_color_mode: "rating",
    typography_scale: 0.81,
    corner_radius: 8,
    edge_buffer: 39,
    mobile_detail_scale: 0.55,
    wave_layer_enabled: false,
    wave_layer_opacity: 0.1,
    show_wave_direction_arrows: false,
    wind_layer_enabled: true,
    wind_layer_opacity: 0.75,
    wind_particle_density: 2.5,
    wind_particle_size: 1.0,
    wind_particle_length: 2.15,
    wind_particle_speed: 2.5,
    wind_particle_opacity: 1.0,
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
    default_region: "san-diego",
    layout: "full",
    show_cards: { swell: true, wind: true, tide: true, sun: true, confidence: true, model: true, hourly: true, five_day: true, warnings: true },
    show_swell_arrows: true,
    show_wind_arrows: true,
    hidden_spot_ids: [],
    pinned_spot_ids: [],
    added_spots: [],
    supabase: { enabled: true, url: "https://hzyskrurgtwceperzcqb.supabase.co", anon_key: "sb_publishable_mBqm_4Or0NLo0pkk9toq0Q_-0nHMQpX" }, hourly_wind_enabled: true, hourly_wind_start_hour: 5, hourly_wind_end_hour: 21, hourly_wind_frame_ms: 1450, hourly_wind_arrow_min_px: 4, hourly_wind_arrow_max_px: 26, hourly_wind_density: 1.0
  };

  const state = { config: structuredClone(DEFAULT_CONFIG), spots: [], filter: "", supabase: null, session: null, supabaseReady: false, _loaded: false };
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

  async function fetchJson(name, base = "./data") {
    const clean = String(base || "./data").replace(/\/$/, "");
    const res = await fetch(`${clean}/${name}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(name);
    return res.json();
  }

  async function loadSiteConfig() {
    let cfg = structuredClone(DEFAULT_CONFIG);
    try {
      const local = await fetchJson("site_config.json");
      cfg = mergeDeep(cfg, local);
      const remoteBase = local?.data_base_url || cfg.data_base_url;
      if (remoteBase && !String(remoteBase).startsWith("./")) {
        try { cfg = mergeDeep(cfg, await fetchJson("site_config.json", remoteBase)); } catch (_) {}
      }
    } catch (_) {}
    return cfg;
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

  function setAdminMode(text, kind = "ok") {
    const el = $("adminModeLine");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("admin-status-ok", kind === "ok");
    el.classList.toggle("admin-status-warn", kind !== "ok");
  }

  async function initSupabaseFromConfig() {
    const cfg = state.config.supabase || {};
    state.supabaseReady = false;
    state.supabase = null;
    if (!cfg.enabled || !cfg.url || !cfg.anon_key || !window.supabase) {
      setAdminMode("Local fallback mode. Supabase is not enabled in site_config yet; run the workflow with SUPABASE_ANON_KEY or paste the publishable key into site_config.json once.", "warn");
      return;
    }
    state.supabase = window.supabase.createClient(cfg.url, cfg.anon_key);
    const { data } = await state.supabase.auth.getSession();
    state.session = data?.session || null;
    state.supabaseReady = true;
    setAdminMode("Supabase mode: admin changes publish to public settings/spots.", "ok");
  }

  async function attemptLogin() {
    const email = $("loginEmail").value.trim().toLowerCase();
    const password = $("loginPassword").value;
    $("loginError").textContent = "";
    if (state.supabaseReady && state.supabase) {
      const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) { $("loginError").textContent = error.message || "Supabase login failed."; return; }
      state.session = data.session;
      const { data: profile, error: profileError } = await state.supabase.from("admin_profiles").select("role, active").eq("id", data.user.id).maybeSingle();
      if (profileError || !profile?.active || profile.role !== "admin") {
        await state.supabase.auth.signOut();
        $("loginError").textContent = "This account is not an active CaliSurf admin.";
        return;
      }
      setUnlocked(true);
      state._loaded = false;
      await initAdmin();
      return;
    }
    if (email === FALLBACK_ADMIN_EMAIL && password === FALLBACK_ADMIN_PASSWORD) {
      sessionStorage.setItem("calisurfAdminLoggedIn", "1");
      setUnlocked(true);
      await initAdmin();
    } else {
      $("loginError").textContent = "Wrong email or password.";
    }
  }

  async function logout() {
    sessionStorage.removeItem("calisurfAdminLoggedIn");
    if (state.supabase) await state.supabase.auth.signOut();
    state.session = null;
    state._loaded = false;
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
    if ($("spotPoorColor")) $("spotPoorColor").value = c.gradients?.spot_rating?.poor || "#e05b52";
    if ($("spotFairColor")) $("spotFairColor").value = c.gradients?.spot_rating?.fair || "#f4c542";
    if ($("spotGoodColor")) $("spotGoodColor").value = c.gradients?.spot_rating?.good || "#1ecb78";
    if ($("windLowColor")) $("windLowColor").value = c.gradients?.wind_speed?.low || "#8ee8ff";
    if ($("windMidColor")) $("windMidColor").value = c.gradients?.wind_speed?.mid || "#f4c542";
    if ($("windHighColor")) $("windHighColor").value = c.gradients?.wind_speed?.high || "#ef4444";
    if ($("windMinSpeed")) $("windMinSpeed").value = c.gradients?.wind_speed?.min ?? 0;
    if ($("windMaxSpeed")) $("windMaxSpeed").value = c.gradients?.wind_speed?.max ?? 24;
    if ($("waveLowColor")) $("waveLowColor").value = c.gradients?.wave_height?.low || "#1eb6d0";
    if ($("waveMidColor")) $("waveMidColor").value = c.gradients?.wave_height?.mid || "#22c55e";
    if ($("waveHighColor")) $("waveHighColor").value = c.gradients?.wave_height?.high || "#f97316";
    if ($("modelLabelText")) $("modelLabelText").value = c.text?.model_label ?? "WEST COAST MODEL V1";
    if ($("appTitleText")) $("appTitleText").value = c.text?.app_title ?? "CaliSurf Light";
    if ($("refreshPrefixText")) $("refreshPrefixText").value = c.text?.refresh_prefix ?? "model refresh:";
    if ($("searchPlaceholderText")) $("searchPlaceholderText").value = c.text?.search_placeholder ?? "Search surf spots…";
    if ($("fontFamily")) $("fontFamily").value = c.typography?.family || DEFAULT_CONFIG.typography.family;
    if ($("titleWeight")) $("titleWeight").value = c.typography?.title_weight ?? 800;
    if ($("bodyWeight")) $("bodyWeight").value = c.typography?.body_weight ?? 600;
    if ($("spotNameWeight")) $("spotNameWeight").value = c.typography?.spot_name_weight ?? 800;
    if ($("spotMetaWeight")) $("spotMetaWeight").value = c.typography?.spot_meta_weight ?? 600;
    if ($("letterSpacing")) $("letterSpacing").value = c.typography?.letter_spacing ?? 0;
    if ($("titleColor")) $("titleColor").value = c.typography?.title_color || "#ffffff";
    if ($("labelColor")) $("labelColor").value = c.typography?.label_color || "#8edceb";
    if ($("spotNameColor")) $("spotNameColor").value = c.typography?.spot_name_color || "#ffffff";
    if ($("spotMetaColor")) $("spotMetaColor").value = c.typography?.spot_meta_color || "#a6bfcc";
    $("fontScale").value = c.typography_scale;
    $("cornerRadius").value = c.corner_radius ?? 8;
    $("edgeBuffer").value = c.edge_buffer ?? 22;
    $("mobileDetailScale").value = c.mobile_detail_scale ?? 0.54;
    if ($("autoCenterNearest")) $("autoCenterNearest").checked = c.auto_center_nearest_beaches !== false;
    $("waveLayerEnabled").checked = c.wave_layer_enabled === true;
    $("waveLayerOpacity").value = c.wave_layer_opacity ?? 0.18;
    $("showWaveDirectionArrows").checked = c.show_wave_direction_arrows !== false;
    $("windLayerEnabled").checked = c.wind_layer_enabled !== false;
    $("windLayerOpacity").value = c.wind_layer_opacity ?? 0.62;
    $("windParticleDensity").value = c.wind_particle_density ?? 1.05;
    if ($("windParticleSize")) $("windParticleSize").value = c.wind_particle_size ?? 1.0;
    if ($("windParticleLength")) $("windParticleLength").value = c.wind_particle_length ?? 1.0;
    if ($("windParticleSpeed")) $("windParticleSpeed").value = c.wind_particle_speed ?? 1.0;
    if ($("windParticleOpacity")) $("windParticleOpacity").value = c.wind_particle_opacity ?? 1.0;
    if ($("windParticleShape")) $("windParticleShape").value = c.wind_particle_shape || "line";
    if ($("hourlyWindFrameMs")) $("hourlyWindFrameMs").value = c.hourly_wind_frame_ms ?? 1450;
    if ($("hourlyWindDensity")) $("hourlyWindDensity").value = c.hourly_wind_density ?? 1.0;
    if ($("hourlyWindMinPx")) $("hourlyWindMinPx").value = c.hourly_wind_arrow_min_px ?? 4;
    if ($("hourlyWindMaxPx")) $("hourlyWindMaxPx").value = c.hourly_wind_arrow_max_px ?? 26;
    if ($("mapTintOpacity")) $("mapTintOpacity").value = c.map_tint_opacity ?? 0.18;
    if ($("waveArrowSize")) $("waveArrowSize").value = c.wave_arrow_size ?? 1.0;
    if ($("waveArrowColor")) $("waveArrowColor").value = c.wave_arrow_color || "#ecffff";
    if ($("waveArrowOpacity")) $("waveArrowOpacity").value = c.wave_arrow_opacity ?? 0.96;
    if ($("waveArrowStroke")) $("waveArrowStroke").value = c.wave_arrow_stroke ?? 2.6;
    if ($("waveNearshoreOverlap")) $("waveNearshoreOverlap").value = c.wave_nearshore_overlap ?? 0.018;
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
      gradients: {
        spot_rating: { poor: $("spotPoorColor")?.value || "#e05b52", fair: $("spotFairColor")?.value || "#f4c542", good: $("spotGoodColor")?.value || "#1ecb78", flat: state.config.gradients?.spot_rating?.flat || "#8da2af" },
        wind_speed: { min: Number($("windMinSpeed")?.value ?? 0), max: Number($("windMaxSpeed")?.value ?? 24), low: $("windLowColor")?.value || "#8ee8ff", mid: $("windMidColor")?.value || "#f4c542", high: $("windHighColor")?.value || "#ef4444" },
        wave_height: { min: state.config.gradients?.wave_height?.min ?? 0, max: state.config.gradients?.wave_height?.max ?? 18, low: $("waveLowColor")?.value || "#1eb6d0", mid: $("waveMidColor")?.value || "#22c55e", high: $("waveHighColor")?.value || "#f97316" }
      },
      text: {
        model_label: $("modelLabelText")?.value ?? state.config.text?.model_label,
        app_title: $("appTitleText")?.value ?? state.config.text?.app_title,
        refresh_prefix: $("refreshPrefixText")?.value ?? state.config.text?.refresh_prefix,
        install_label: state.config.text?.install_label || "Install app",
        search_placeholder: $("searchPlaceholderText")?.value ?? state.config.text?.search_placeholder
      },
      typography: {
        family: $("fontFamily")?.value || DEFAULT_CONFIG.typography.family,
        title_weight: Number($("titleWeight")?.value ?? 800),
        body_weight: Number($("bodyWeight")?.value ?? 600),
        spot_name_weight: Number($("spotNameWeight")?.value ?? 800),
        spot_meta_weight: Number($("spotMetaWeight")?.value ?? 600),
        letter_spacing: Number($("letterSpacing")?.value ?? 0),
        title_color: $("titleColor")?.value || "#ffffff",
        label_color: $("labelColor")?.value || "#8edceb",
        spot_name_color: $("spotNameColor")?.value || "#ffffff",
        spot_meta_color: $("spotMetaColor")?.value || "#a6bfcc"
      },
      marker_size: Number($("markerSize").value),
      marker_color_mode: $("markerColorMode").value,
      typography_scale: Number($("fontScale").value),
      corner_radius: Number($("cornerRadius").value),
      edge_buffer: Number($("edgeBuffer").value),
      mobile_detail_scale: Number($("mobileDetailScale").value),
      wave_layer_enabled: $("waveLayerEnabled").checked,
      wave_layer_opacity: Number($("waveLayerOpacity").value),
      show_wave_direction_arrows: $("showWaveDirectionArrows").checked,
      wind_layer_enabled: $("windLayerEnabled").checked,
      wind_layer_opacity: Number($("windLayerOpacity").value),
      wind_particle_density: Number($("windParticleDensity").value),
      wind_particle_size: Number($("windParticleSize")?.value ?? 1.0),
      wind_particle_length: Number($("windParticleLength")?.value ?? 1.0),
      wind_particle_speed: Number($("windParticleSpeed")?.value ?? 1.0),
      wind_particle_opacity: Number($("windParticleOpacity")?.value ?? 1.0),
      wind_particle_shape: $("windParticleShape")?.value || "line",
      hourly_wind_enabled: true,
      hourly_wind_frame_ms: Number($("hourlyWindFrameMs")?.value ?? 1450),
      hourly_wind_density: Number($("hourlyWindDensity")?.value ?? 1.0),
      hourly_wind_arrow_min_px: Number($("hourlyWindMinPx")?.value ?? 4),
      hourly_wind_arrow_max_px: Number($("hourlyWindMaxPx")?.value ?? 26),
      map_tint_opacity: Number($("mapTintOpacity")?.value ?? 0.18),
      wave_arrow_size: Number($("waveArrowSize")?.value ?? 1.0),
      wave_arrow_color: $("waveArrowColor")?.value || "#ecffff",
      wave_arrow_opacity: Number($("waveArrowOpacity")?.value ?? 0.96),
      wave_arrow_stroke: Number($("waveArrowStroke")?.value ?? 2.6),
      wave_nearshore_overlap: Number($("waveNearshoreOverlap")?.value ?? 0.018),
      auto_center_nearest_beaches: $("autoCenterNearest")?.checked !== false,
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

  async function save() {
    readConfigFromForm();
    if (state.supabaseReady && state.supabase && state.session) {
      const { error } = await state.supabase.from("site_settings").upsert({ key: "public", value: state.config, updated_at: new Date().toISOString() });
      if (error) { alert("Supabase save failed: " + error.message); return; }
      alert("Saved to Supabase. Refresh the public app; it will load these settings from the site_settings table.");
      return;
    }
    localStorage.setItem("surfAppAdminConfig", JSON.stringify(state.config, null, 2));
    alert("Saved to this browser only. Configure Supabase for public live changes.");
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

  function previewConfig() { $("configPreview").textContent = JSON.stringify(state.config, null, 2); }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }

  function spotToRow(spot) {
    return {
      id: spot.id, name: spot.name, region: spot.region || "California", lat: Number(spot.lat), lon: Number(spot.lon), active: spot.active !== false,
      display_order: spot.display_order ?? null, beach_orientation_deg: spot.beach_orientation_deg ?? null,
      bathymetry: spot.bathymetry || {}, exposure_by_direction: spot.exposure_by_direction || {}, public_data: spot.public_data || {}, notes: spot.notes || "Admin-managed spot",
      updated_at: new Date().toISOString()
    };
  }

  async function loadSupabaseSpots() {
    if (!state.supabaseReady || !state.supabase || !state.session) return null;
    const { data, error } = await state.supabase.from("surf_spots").select("*").order("display_order", { ascending: true });
    if (error) { console.warn(error); return null; }
    return data || [];
  }

  async function saveSpotToSupabase(spot) {
    const { error } = await state.supabase.from("surf_spots").upsert(spotToRow(spot));
    if (error) throw error;
  }

  async function setSpotActiveSupabase(id, active) {
    const { error } = await state.supabase.from("surf_spots").update({ active, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
  }

  function renderSpotList() {
    const q = state.filter.trim().toLowerCase();
    const hidden = new Set(state.config.hidden_spot_ids || []);
    const added = state.config.added_spots || [];
    const all = [...state.spots, ...added].filter(s => !q || s.name.toLowerCase().includes(q) || (s.region || "").toLowerCase().includes(q));
    $("adminSpotList").innerHTML = all.map(s => {
      const isVisible = state.supabaseReady ? s.active !== false : !hidden.has(s.id);
      const pinned = new Set(state.config.pinned_spot_ids || []).has(s.id);
      return `<div class="admin-spot" data-id="${escapeHtml(s.id)}">
        <div class="admin-spot-edit">
          <input data-field="name" value="${escapeHtml(s.name)}" title="Spot name" />
          <input data-field="region" value="${escapeHtml(s.region || "California")}" title="Region" />
          <input data-field="lat" type="number" step="0.000001" value="${Number(s.lat).toFixed(6)}" title="Latitude" />
          <input data-field="lon" type="number" step="0.000001" value="${Number(s.lon).toFixed(6)}" title="Longitude" />
          <button class="ghost-btn" data-save="${escapeHtml(s.id)}">Save</button>
        </div>
        <div class="admin-spot-flags">
          <label><input type="checkbox" data-visible="${escapeHtml(s.id)}" ${isVisible ? "checked" : ""}> visible</label>
          <label><input type="checkbox" data-pinned="${escapeHtml(s.id)}" ${pinned ? "checked" : ""}> pinned</label>
        </div>
      </div>`;
    }).join("") || `<p class="notice">No matching spots.</p>`;
    document.querySelectorAll("#adminSpotList [data-visible]").forEach(cb => cb.addEventListener("change", async () => {
      const id = cb.dataset.visible;
      if (state.supabaseReady && state.supabase && state.session) {
        try { await setSpotActiveSupabase(id, cb.checked); } catch (err) { alert("Supabase update failed: " + err.message); }
        const spot = state.spots.find(s => s.id === id); if (spot) spot.active = cb.checked;
      } else {
        const set = new Set(state.config.hidden_spot_ids || []); if (cb.checked) set.delete(id); else set.add(id); state.config.hidden_spot_ids = [...set];
      }
      previewConfig();
    }));
    document.querySelectorAll("#adminSpotList [data-pinned]").forEach(cb => cb.addEventListener("change", () => {
      const set = new Set(state.config.pinned_spot_ids || []);
      if (cb.checked) set.add(cb.dataset.pinned); else set.delete(cb.dataset.pinned);
      state.config.pinned_spot_ids = [...set];
      previewConfig();
    }));
    document.querySelectorAll("#adminSpotList [data-save]").forEach(btn => btn.addEventListener("click", async () => {
      const wrap = btn.closest(".admin-spot");
      const id = btn.dataset.save;
      const original = [...state.spots, ...(state.config.added_spots || [])].find(s => s.id === id) || { id };
      const get = f => wrap.querySelector(`[data-field="${f}"]`)?.value;
      const spot = { ...original, id, name: get("name").trim(), region: get("region").trim() || "California", lat: Number(get("lat")), lon: Number(get("lon")), active: wrap.querySelector("[data-visible]").checked };
      if (!spot.name || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lon)) { alert("Name, lat, and lon are required."); return; }
      await persistSpot(spot);
    }));
  }

  async function persistSpot(spot) {
    if (state.supabaseReady && state.supabase && state.session) {
      try {
        await saveSpotToSupabase(spot);
        const idx = state.spots.findIndex(s => s.id === spot.id);
        if (idx >= 0) state.spots[idx] = spot; else state.spots.push(spot);
        renderSpotList(); alert("Spot saved to Supabase.");
      } catch (err) { alert("Supabase spot save failed: " + err.message); }
      return;
    }
    const arr = state.config.added_spots || [];
    const idx = arr.findIndex(s => s.id === spot.id);
    if (idx >= 0) arr[idx] = spot; else arr.push(spot);
    state.config.added_spots = arr;
    renderSpotList(); previewConfig(); alert("Spot saved as a browser-only override.");
  }

  async function addSpot() {
    const name = $("newName").value.trim(), lat = Number($("newLat").value), lon = Number($("newLon").value);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) { alert("Name, latitude, and longitude are required."); return; }
    const orientation = Number($("newOrientation").value || 260), exposure = Number($("newExposure").value || 1.0);
    await persistSpot({ id: slugify(name), name, region: $("newRegion").value.trim() || "Custom", lat, lon, active: true, beach_orientation_deg: orientation, bathymetry: { slope_5_20m: 0.035, canyon_multiplier: 1.0, reef_multiplier: 1.0, shadowing_multiplier: 1.0, source: "admin" }, exposure_by_direction: exposureTable(exposure), public_data: { nearest_tide_station: null, buoy_candidates: [] }, notes: "Added from admin console." });
  }

  async function initAdmin() {
    if (state._loaded) return;
    state._loaded = true;
    try {
      const fileConfig = await loadSiteConfig();
      const dataBase = fileConfig.data_base_url || "./data";
      const [spots] = await Promise.all([fetchJson("spots.json", dataBase).catch(() => fetchJson("spots.json"))]);
      state.config = mergeDeep(DEFAULT_CONFIG, fileConfig);
      await initSupabaseFromConfig();
      let supabaseSpots = null, supabaseSettings = null;
      if (state.supabaseReady && state.session) {
        const [settingsRes, spotRows] = await Promise.all([state.supabase.from("site_settings").select("value").eq("key", "public").maybeSingle(), loadSupabaseSpots()]);
        if (!settingsRes.error && settingsRes.data?.value) supabaseSettings = settingsRes.data.value;
        if (spotRows?.length) supabaseSpots = spotRows;
      }
      state.spots = (supabaseSpots || spots).sort((a, b) => Number(a.lat) - Number(b.lat));
      state.config = mergeDeep(state.config, supabaseSettings || {});
      if (!state.supabaseReady) { try { const local = JSON.parse(localStorage.getItem("surfAppAdminConfig") || "null"); if (local) state.config = mergeDeep(state.config, local); } catch (_) {} }
      applyConfigToForm(); renderSpotList();
    } catch (err) { console.error(err); $("configPreview").textContent = "Could not load spots/config. Check public/data files."; }
  }

  async function prepareLogin() {
    try { const fileConfig = await loadSiteConfig(); state.config = mergeDeep(DEFAULT_CONFIG, fileConfig); await initSupabaseFromConfig(); if (state.supabaseReady && state.session) { setUnlocked(true); await initAdmin(); return; } } catch (err) { console.warn(err); }
    if (sessionStorage.getItem("calisurfAdminLoggedIn") === "1") { setUnlocked(true); await initAdmin(); } else setUnlocked(false);
  }

  function bind() {
    $("loginButton").addEventListener("click", attemptLogin);
    $("loginPassword").addEventListener("keydown", e => { if (e.key === "Enter") attemptLogin(); });
    $("logoutButton").addEventListener("click", logout);
    ["bgColor", "panelColor", "accentColor", "accent2Color", "markerSize", "markerColorMode", "spotPoorColor", "spotFairColor", "spotGoodColor", "windLowColor", "windMidColor", "windHighColor", "windMinSpeed", "windMaxSpeed", "waveLowColor", "waveMidColor", "waveHighColor", "modelLabelText", "appTitleText", "refreshPrefixText", "searchPlaceholderText", "fontFamily", "titleWeight", "bodyWeight", "spotNameWeight", "spotMetaWeight", "letterSpacing", "titleColor", "labelColor", "spotNameColor", "spotMetaColor", "fontScale", "cornerRadius", "edgeBuffer", "mobileDetailScale", "autoCenterNearest", "waveLayerEnabled", "waveLayerOpacity", "showWaveDirectionArrows", "windLayerEnabled", "windLayerOpacity", "windParticleDensity", "windParticleSize", "windParticleLength", "windParticleSpeed", "windParticleOpacity", "windParticleShape", "hourlyWindFrameMs", "hourlyWindDensity", "hourlyWindMinPx", "hourlyWindMaxPx", "mapTintOpacity", "waveArrowSize", "waveArrowColor", "waveArrowOpacity", "waveArrowStroke", "waveNearshoreOverlap", "defaultRegion", "layoutMode", "cardSwell", "cardWind", "cardTide", "cardSun", "cardConfidence", "cardModel", "cardHourly", "cardFiveDay", "cardWarnings", "showSwellArrows", "showWindArrows"].forEach(id => { $(id)?.addEventListener("input", readConfigFromForm); $(id)?.addEventListener("change", readConfigFromForm); });
    $("saveConfig").addEventListener("click", save);
    $("downloadConfig").addEventListener("click", () => { readConfigFromForm(); download("site_config.json", JSON.stringify(state.config, null, 2)); });
    $("resetConfig").addEventListener("click", () => { state.config = structuredClone(DEFAULT_CONFIG); localStorage.removeItem("surfAppAdminConfig"); applyConfigToForm(); renderSpotList(); });
    $("addSpot").addEventListener("click", addSpot);
    $("downloadSpots").addEventListener("click", () => download("spots_override.json", JSON.stringify(state.config.added_spots || [], null, 2)));
    $("spotFilter").addEventListener("input", e => { state.filter = e.target.value; renderSpotList(); });
  }

  bind();
  prepareLogin();
})();
