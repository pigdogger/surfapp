#!/usr/bin/env python3
"""CaliSurf Light · west coast model V1 forecast pipeline.

Runs in GitHub Actions and writes public/data/latest_forecasts.json.
Uses live public model/observation sources when online:
- Open-Meteo Marine API wave model guidance
- Open-Meteo Weather API wind guidance
- NDBC/CDIP realtime buoy observations
- NOAA CO-OPS tide predictions
"""
from __future__ import annotations

import argparse, datetime as dt, json, math, os, random
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
import requests

ROOT = Path(__file__).resolve().parents[1]
SPOTS_PATH = ROOT / "public" / "data" / "spots.json"
OUT_PATH = ROOT / "public" / "data" / "latest_forecasts.json"
UTC = dt.timezone.utc
M_TO_FT = 3.28084
MPS_TO_KT = 1.94384
FORECAST_HOURS = int(os.environ.get("SURF_FORECAST_HOURS", "30"))
BATCH_SIZE = int(os.environ.get("OPEN_METEO_BATCH_SIZE", "35"))
NDBC_BASE = "https://www.ndbc.noaa.gov/data/realtime2"
COOPS_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
MARINE_API = "https://marine-api.open-meteo.com/v1/marine"
WEATHER_API = "https://api.open-meteo.com/v1/forecast"

NDBC_CACHE: Dict[Tuple[str, str], Tuple[Optional[Dict[str, str]], str]] = {}
TIDE_CACHE: Dict[Tuple[str, str], Tuple[List[Dict[str, Any]], List[str]]] = {}
MARINE: Dict[str, Dict[str, Any]] = {}
WIND: Dict[str, Dict[str, Any]] = {}
MODEL_WARNINGS: List[str] = []


def now_utc() -> dt.datetime:
    return dt.datetime.now(tz=UTC).replace(microsecond=0)

def to_iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")

def parse_iso(value: str) -> dt.datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    x = dt.datetime.fromisoformat(value)
    return (x if x.tzinfo else x.replace(tzinfo=UTC)).astimezone(UTC)

def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))

def safe_float(v: Any) -> Optional[float]:
    try:
        if v is None: return None
        s = str(v).strip()
        if s in {"", "MM", "M", "NA", "null", "None", "99", "99.0", "999", "999.0", "9999", "9999.0"}: return None
        f = float(s)
        return f if math.isfinite(f) and abs(f) < 999 else None
    except Exception:
        return None

def angle_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)

def compass(deg: Optional[float]) -> str:
    if deg is None: return "—"
    dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
    return dirs[int((float(deg)+11.25)/22.5)%16]

def weighted_dir(items: Sequence[Tuple[Optional[float], float]]) -> Optional[int]:
    x = y = 0.0
    for deg, w in items:
        if deg is None or w <= 0: continue
        r = math.radians(float(deg)); x += math.sin(r)*w; y += math.cos(r)*w
    if abs(x)+abs(y) < 1e-9: return None
    return round((math.degrees(math.atan2(x, y)) + 360) % 360)

def safe_get(url: str, *, params: Optional[dict] = None, timeout: int = 28) -> requests.Response:
    r = requests.get(url, params=params, timeout=timeout, headers={"User-Agent": "CaliSurf-Light/1.0"})
    r.raise_for_status(); return r

def chunked(xs: Sequence[dict], n: int) -> Iterable[List[dict]]:
    for i in range(0, len(xs), n): yield list(xs[i:i+n])

# --- NDBC/CDIP realtime observations ---
def parse_ndbc(text: str) -> List[Dict[str, str]]:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) < 3: return []
    header = lines[0].lstrip("#").split(); out = []
    for line in lines[2:]:
        parts = line.split()
        if len(parts) >= len(header): out.append(dict(zip(header, parts)))
    return out

def row_time(row: Dict[str, str]) -> dt.datetime:
    try:
        y = int(row.get("YYYY", row.get("YY", "1900")))
        if y < 100: y += 2000 if y < 80 else 1900
        return dt.datetime(y, int(row["MM"]), int(row["DD"]), int(row.get("hh", row.get("HH", 0))), int(row.get("mm", 0)), tzinfo=UTC)
    except Exception:
        return dt.datetime(1900,1,1,tzinfo=UTC)

def fetch_ndbc(station: str, suffix: str) -> Tuple[Optional[Dict[str, str]], str]:
    key = (station, suffix)
    if key in NDBC_CACHE:
        row, status = NDBC_CACHE[key]; return row, status + ":cached"
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1":
        NDBC_CACHE[key] = (None, f"{station}.{suffix}:offline"); return NDBC_CACHE[key]
    try:
        rows = parse_ndbc(safe_get(f"{NDBC_BASE}/{station}.{suffix}", timeout=16).text)
        if not rows: result = (None, f"{station}.{suffix}:empty")
        else: result = (sorted(rows, key=row_time, reverse=True)[0], f"{station}.{suffix}:ok")
    except Exception as exc:
        result = (None, f"{station}.{suffix}:failed:{type(exc).__name__}")
    NDBC_CACHE[key] = result; return result

def buoy_obs(spot: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    statuses: List[str] = []
    for st in spot.get("public_data", {}).get("buoy_candidates", [])[:5]:
        sid = st["id"]; spec, ss = fetch_ndbc(sid, "spec"); txt, ts = fetch_ndbc(sid, "txt")
        statuses += [ss, ts]; wave = {}; wind = {}
        if spec:
            h = safe_float(spec.get("WVHT")) or safe_float(spec.get("SwH"))
            p = safe_float(spec.get("SwP")) or safe_float(spec.get("DPD")) or safe_float(spec.get("APD"))
            d = safe_float(spec.get("SwD")) or safe_float(spec.get("MWD"))
            sh, sp, sd = safe_float(spec.get("WWH")), safe_float(spec.get("WWP")), safe_float(spec.get("WWD"))
            if h and p:
                wave = {"source":"NDBC/CDIP realtime spec","station_id":sid,"station_name":st.get("name",sid),"height_ft":round(h*M_TO_FT,2),"period_s":round(p,1),"direction_deg":round(d) if d is not None else None,"secondary_height_ft":round(sh*M_TO_FT,2) if sh else None,"secondary_period_s":round(sp,1) if sp else None,"secondary_direction_deg":round(sd) if sd is not None else None}
        if txt:
            wd, ws, gs = safe_float(txt.get("WDIR")), safe_float(txt.get("WSPD")), safe_float(txt.get("GST"))
            if not wave:
                h, p, d = safe_float(txt.get("WVHT")), safe_float(txt.get("DPD")) or safe_float(txt.get("APD")), safe_float(txt.get("MWD"))
                if h and p: wave = {"source":"NDBC realtime txt","station_id":sid,"station_name":st.get("name",sid),"height_ft":round(h*M_TO_FT,2),"period_s":round(p,1),"direction_deg":round(d) if d is not None else None}
            if ws is not None:
                wind = {"source":"NDBC realtime txt","station_id":sid,"station_name":st.get("name",sid),"speed_kt":round(ws*MPS_TO_KT,1),"gust_kt":round(gs*MPS_TO_KT,1) if gs is not None else None,"direction_deg":round(wd) if wd is not None else None}
        if wave or wind: return {"wave": wave, "wind": wind}, statuses
    return {"wave": {}, "wind": {}}, statuses or ["buoy:no_candidates"]

# --- Open-Meteo batched forecast models ---
def rows_from_payload(item: Dict[str, Any], mode: str) -> List[Dict[str, Any]]:
    h = item.get("hourly") or {}; times = h.get("time") or []; rows = []
    def val(name, i):
        arr = h.get(name); return safe_float(arr[i]) if isinstance(arr, list) and i < len(arr) else None
    for i, t in enumerate(times):
        try:
            if mode == "marine":
                rows.append({"time":parse_iso(t),"wave_height_ft":val("wave_height",i),"wave_period_s":val("wave_period",i),"wave_peak_period_s":val("wave_peak_period",i),"wave_direction_deg":val("wave_direction",i),"swell_height_ft":val("swell_wave_height",i),"swell_period_s":val("swell_wave_period",i),"swell_direction_deg":val("swell_wave_direction",i),"secondary_height_ft":val("secondary_swell_wave_height",i),"secondary_period_s":val("secondary_swell_wave_period",i),"secondary_direction_deg":val("secondary_swell_wave_direction",i),"wind_wave_height_ft":val("wind_wave_height",i),"wind_wave_period_s":val("wind_wave_period",i),"wind_wave_direction_deg":val("wind_wave_direction",i)})
            else:
                rows.append({"time":parse_iso(t),"speed_kt":val("wind_speed_10m",i),"gust_kt":val("wind_gusts_10m",i),"direction_deg":val("wind_direction_10m",i)})
        except Exception: pass
    return rows

def nearest(rows: Sequence[Dict[str, Any]], target: dt.datetime) -> Optional[Dict[str, Any]]:
    return min(rows, key=lambda r: abs((r["time"]-target).total_seconds())) if rows else None

def fetch_models(spots: Sequence[Dict[str, Any]]) -> None:
    MARINE.clear(); WIND.clear(); MODEL_WARNINGS.clear()
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1": MODEL_WARNINGS.append("openmeteo:offline"); return
    for batch in chunked(list(spots), BATCH_SIZE):
        lats = ",".join(f"{float(s['lat']):.5f}" for s in batch); lons = ",".join(f"{float(s['lon']):.5f}" for s in batch)
        try:
            data = safe_get(MARINE_API, params={"latitude":lats,"longitude":lons,"hourly":"wave_height,wave_direction,wave_period,wave_peak_period,swell_wave_height,swell_wave_direction,swell_wave_period,secondary_swell_wave_height,secondary_swell_wave_direction,secondary_swell_wave_period,wind_wave_height,wind_wave_direction,wind_wave_period","forecast_hours":str(FORECAST_HOURS+1),"length_unit":"imperial","timezone":"GMT","cell_selection":"sea"}, timeout=40).json()
            items = data if isinstance(data, list) else [data]
            for spot, item in zip(batch, items):
                rows = rows_from_payload(item, "marine")
                if rows: MARINE[spot["id"]] = {"source":"Open-Meteo Marine API best-match wave model","rows":rows,"status":"openmeteo_marine:ok"}
        except Exception as exc: MODEL_WARNINGS.append(f"openmeteo_marine:failed:{type(exc).__name__}")
        try:
            data = safe_get(WEATHER_API, params={"latitude":lats,"longitude":lons,"hourly":"wind_speed_10m,wind_direction_10m,wind_gusts_10m","forecast_hours":str(FORECAST_HOURS+1),"wind_speed_unit":"kn","timezone":"GMT"}, timeout=40).json()
            items = data if isinstance(data, list) else [data]
            for spot, item in zip(batch, items):
                rows = rows_from_payload(item, "wind")
                if rows: WIND[spot["id"]] = {"source":"Open-Meteo Weather Forecast API best-match wind model","rows":rows,"status":"openmeteo_wind:ok"}
        except Exception as exc: MODEL_WARNINGS.append(f"openmeteo_wind:failed:{type(exc).__name__}")

def marine_wave(row: Optional[Dict[str, Any]], source: str) -> Optional[Dict[str, Any]]:
    if not row: return None
    h = row.get("swell_height_ft") or row.get("wave_height_ft"); p = row.get("swell_period_s") or row.get("wave_period_s") or row.get("wave_peak_period_s"); d = row.get("swell_direction_deg") or row.get("wave_direction_deg")
    if h is None or p is None: return None
    return {"source":source,"station_id":None,"station_name":"Open-Meteo marine grid","height_ft":round(float(h),2),"period_s":round(float(p),1),"direction_deg":round(float(d)) if d is not None else None}

def secondary(row: Optional[Dict[str, Any]], obs: Dict[str, Any]) -> Dict[str, Any]:
    if row:
        for h,p,d,src in [(row.get("secondary_height_ft"),row.get("secondary_period_s"),row.get("secondary_direction_deg"),"Open-Meteo secondary swell"),(row.get("wind_wave_height_ft"),row.get("wind_wave_period_s"),row.get("wind_wave_direction_deg"),"Open-Meteo wind-wave component")]:
            if h is not None and p is not None: return {"height_ft":round(float(h),2),"period_s":round(float(p),1),"direction_deg":round(float(d)) if d is not None else None,"direction_compass":compass(d),"source":src}
    if obs.get("secondary_height_ft") and obs.get("secondary_period_s"):
        d = obs.get("secondary_direction_deg"); return {"height_ft":obs["secondary_height_ft"],"period_s":obs["secondary_period_s"],"direction_deg":d,"direction_compass":compass(d),"source":"NDBC/CDIP secondary component"}
    return {"height_ft":None,"period_s":None,"direction_deg":None,"direction_compass":"—","source":"none available"}

def blend_wave(obs: Dict[str, Any], model: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if obs and model:
        oh, mh = float(obs.get("height_ft") or model["height_ft"]), float(model.get("height_ft") or obs["height_ft"])
        op, mp = float(obs.get("period_s") or model["period_s"]), float(model.get("period_s") or obs["period_s"])
        return {"source":"CDIP/NDBC observation blended with Open-Meteo marine forecast","station_id":obs.get("station_id"),"station_name":obs.get("station_name"),"height_ft":round(.6*oh+.4*mh,2),"period_s":round(.6*op+.4*mp,1),"direction_deg":weighted_dir([(obs.get("direction_deg"),.62),(model.get("direction_deg"),.38)]),"observed_height_ft":round(oh,2),"model_height_ft":round(mh,2)}
    return dict(model or obs or {})

def wind_at(spot_id: str, obs: Dict[str, Any], target: dt.datetime, use_obs: bool) -> Tuple[Dict[str, Any], str]:
    model = WIND.get(spot_id); row = nearest(model.get("rows", []), target) if model else None
    if row and row.get("speed_kt") is not None:
        w = {"source":model.get("source"),"station_id":None,"station_name":"Open-Meteo weather grid","speed_kt":round(float(row.get("speed_kt") or 0),1),"gust_kt":round(float(row.get("gust_kt") or (float(row.get("speed_kt") or 0)+4)),1),"direction_deg":round(float(row.get("direction_deg"))) if row.get("direction_deg") is not None else None}
        if obs and use_obs:
            od, md = obs.get("direction_deg"), w.get("direction_deg")
            w.update({"source":"NDBC observation blended with Open-Meteo wind forecast","station_id":obs.get("station_id"),"station_name":obs.get("station_name"),"speed_kt":round(.45*float(obs.get("speed_kt") or w["speed_kt"])+.55*w["speed_kt"],1),"gust_kt":round(.45*float(obs.get("gust_kt") or w["gust_kt"])+.55*w["gust_kt"],1),"direction_deg":weighted_dir([(od,.45),(md,.55)])})
        return w, "wind:model_ok"
    if obs: return dict(obs), "wind:observed_only"
    return fallback_wind(target), "wind:fallback_climatology"

# --- tide, sun, transform ---
def coops_time(x: dt.datetime) -> str: return x.strftime("%Y%m%d %H:%M")
def parse_coops(x: str) -> dt.datetime: return dt.datetime.strptime(x, "%Y-%m-%d %H:%M").replace(tzinfo=UTC)
def tide_series(spot: Dict[str, Any], t: dt.datetime) -> Tuple[List[Dict[str,Any]], List[str]]:
    st = spot.get("public_data",{}).get("nearest_tide_station",{}); sid = st.get("id")
    if not sid: return [], ["tide:no_station"]
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1": return [], [f"tide:{sid}:offline"]
    key=(sid,t.strftime("%Y%m%d"))
    if key in TIDE_CACHE:
        s, sts = TIDE_CACHE[key]; return s, [x+":cached" for x in sts]
    try:
        data=safe_get(COOPS_API, params={"product":"predictions","application":"calisurf_light","begin_date":coops_time(t-dt.timedelta(hours=6)),"end_date":coops_time(t+dt.timedelta(hours=FORECAST_HOURS+2)),"datum":"MLLW","station":sid,"time_zone":"gmt","units":"english","interval":"h","format":"json"}, timeout=24).json()
        rows=[{"time":parse_coops(r["t"]),"level_ft":float(r["v"])} for r in data.get("predictions",[])]
        res=(rows,[f"tide:{sid}:ok" if rows else f"tide:{sid}:empty"])
    except Exception as exc: res=([],[f"tide:{sid}:failed:{type(exc).__name__}"])
    TIDE_CACHE[key]=res; return res

def fallback_tide(spot: Dict[str, Any], t: dt.datetime) -> List[Dict[str,Any]]:
    phase=(sum(map(ord, spot["id"]))%360)/180*math.pi; out=[]; start=t-dt.timedelta(hours=6)
    for h in range(FORECAST_HOURS+9):
        x=start+dt.timedelta(hours=h); out.append({"time":x,"level_ft":round(2.8+2.1*math.sin((x.timestamp()/3600/12.42)*2*math.pi+phase),2)})
    return out

def interp_tide(series: List[Dict[str,Any]], t: dt.datetime) -> Tuple[float,str]:
    series=sorted(series,key=lambda r:r["time"])
    if not series: return 0,"unknown"
    for i in range(1,len(series)):
        a,b=series[i-1],series[i]
        if a["time"] <= t <= b["time"]:
            f=(t-a["time"]).total_seconds()/((b["time"]-a["time"]).total_seconds() or 1)
            level=float(a["level_ft"])+f*(float(b["level_ft"])-float(a["level_ft"]))
            return round(level,2), "rising" if b["level_ft"]>a["level_ft"] else "falling"
    return float(series[-1]["level_ft"]), "unknown"

def sun_time(date: dt.datetime, lat: float, lon: float, rise: bool) -> Optional[dt.datetime]:
    zen=90.833; n=int(date.strftime("%j")); lng=lon/15; tt=n+(((6 if rise else 18)-lng)/24)
    m=.9856*tt-3.289; l=(m+1.916*math.sin(math.radians(m))+.020*math.sin(math.radians(2*m))+282.634)%360
    ra=math.degrees(math.atan(.91764*math.tan(math.radians(l))))%360; ra=(ra+(math.floor(l/90)*90-math.floor(ra/90)*90))/15
    sd=.39782*math.sin(math.radians(l)); cd=math.cos(math.asin(sd)); ch=(math.cos(math.radians(zen))-sd*math.sin(math.radians(lat)))/(cd*math.cos(math.radians(lat)))
    if ch>1 or ch<-1: return None
    h=(360-math.degrees(math.acos(ch)) if rise else math.degrees(math.acos(ch)))/15
    uh=(h+ra-.06571*tt-6.622-lng)%24
    return dt.datetime(date.year,date.month,date.day,tzinfo=UTC)+dt.timedelta(hours=uh)

def fallback_wave(spot: Dict[str,Any], t: dt.datetime) -> Dict[str,Any]:
    doy=t.timetuple().tm_yday; winter=(math.cos(2*math.pi*(doy-15)/365.25)+1)/2; rnd=random.Random(f"{spot['id']}-{t.date()}")
    h=1.4+2*winter+rnd.uniform(-.2,.4); d=285+rnd.uniform(-18,18) if winter>.5 else 200+rnd.uniform(-15,15); p=11+rnd.uniform(-1.5,3.5) if winter>.5 else 14+rnd.uniform(-2,2)
    return {"source":"fallback seasonal climatology","height_ft":round(max(.4,h),2),"period_s":round(p,1),"direction_deg":round(d),"station_name":"seasonal fallback"}

def fallback_wind(t: dt.datetime) -> Dict[str,Any]:
    sea=1 if (t.hour>=17 or t.hour<=3) else 0; sp=5+3*sea
    return {"source":"fallback coastal wind climatology","speed_kt":sp,"gust_kt":sp+4,"direction_deg":270,"station_name":"fallback"}

def exposure(spot: Dict[str,Any], deg: float) -> float:
    table=spot.get("exposure_by_direction") or {}; keys=[float(k) for k in table] or [270]
    key=str(int(min(keys,key=lambda x: angle_diff(deg,x)))); return float(table.get(key,.8))

def surf_from_wave(spot: Dict[str,Any], wave: Dict[str,Any], tide: float) -> Tuple[float,Dict[str,Any]]:
    h=float(wave.get("height_ft") or 2); p=float(wave.get("period_s") or 10); d=float(wave.get("direction_deg") if wave.get("direction_deg") is not None else spot.get("beach_orientation_deg") or 270)
    bathy=spot.get("bathymetry") or {}; bathy_gain=float(bathy.get("canyon_multiplier",1) or 1)*float(bathy.get("reef_multiplier",1) or 1)*float(bathy.get("shadowing_multiplier",1) or 1)
    slope=float(bathy.get("slope_5_20m",.035) or .035); slope_gain=clamp(.92+(slope-.03)*3.3,.86,1.16); period_bonus=.72+clamp((p-6)/18,0,.85)
    tide_mod=.86 if tide<-0.5 or tide>7 else (.94 if tide<.5 or tide>5.8 else (1.05 if 1<=tide<=4.8 else 1.0))
    surf=clamp(h*exposure(spot,d)*bathy_gain*slope_gain*period_bonus*tide_mod,.2,30)
    return round(surf,2), {"input_height_ft":round(h,2),"input_period_s":round(p,1),"input_direction_deg":round(d,1),"directional_exposure":round(exposure(spot,d),2),"bathymetry_gain":round(bathy_gain*slope_gain,2),"period_bonus":round(period_bonus,2),"tide_modifier":round(tide_mod,2)}

def wind_quality(spot: Dict[str,Any], wind: Dict[str,Any]) -> Tuple[str,float]:
    sp=float(wind.get("speed_kt") or 0); d=float(wind.get("direction_deg") if wind.get("direction_deg") is not None else 270); shore=float(spot.get("beach_orientation_deg") or 260)
    score=.65 + (.25 if angle_diff(d,(shore+180)%360)<55 else 0) - (.30 if angle_diff(d,shore)<55 else 0) - (.15 if sp>12 else 0) - (.2 if sp>20 else 0)
    score=clamp(score,.05,.98); return ("clean" if score>=.78 else "fair" if score>=.55 else "bumpy" if score>=.35 else "poor"), round(score,2)

def confidence(statuses: Iterable[str]) -> float:
    text="|".join(statuses); score=.3
    score += .23 if "openmeteo_marine:ok" in text else 0; score += .14 if ".spec:ok" in text or ".txt:ok" in text else 0; score += .18 if "openmeteo_wind:ok" in text or "wind:model_ok" in text else 0; score += .12 if "tide:" in text and ":ok" in text else 0; score += .05 if "bathymetry:empirical_v2" in text else 0
    score -= .12 if "fallback" in text else 0; score -= .1 if "failed" in text else 0
    return round(clamp(score,.15,.96),2)

def rating(mid: float, wind_score: float, conf: float) -> str:
    if mid < 1: return "flat"
    s=.45*clamp(mid/6,0,1)+.40*wind_score+.15*conf
    return "good" if s>=.75 else "fair-good" if s>=.58 else "fair" if s>=.42 else "poor"

def forecast_spot(spot: Dict[str,Any], gen: dt.datetime) -> Dict[str,Any]:
    statuses=["bathymetry:empirical_v2"]
    fetched, bs=buoy_obs(spot); statuses+=bs; obs_wave=fetched.get("wave") or {}; obs_wind=fetched.get("wind") or {}
    mm=MARINE.get(spot["id"]); wm=WIND.get(spot["id"]); statuses.append(mm.get("status") if mm else "openmeteo_marine:unavailable"); statuses.append(wm.get("status") if wm else "openmeteo_wind:unavailable")
    mrow=nearest(mm.get("rows",[]), gen) if mm else None; mwave=marine_wave(mrow, mm.get("source") if mm else "Open-Meteo marine model") if mrow else None
    wave=blend_wave(obs_wave, mwave) or fallback_wave(spot, gen); statuses.append("wave:fallback_climatology") if wave.get("source"," ").startswith("fallback") else None
    wind, ws=wind_at(spot["id"], obs_wind, gen, True); statuses.append(ws)
    ts, tstat=tide_series(spot, gen); statuses+=tstat
    if not ts: ts=fallback_tide(spot, gen); statuses.append("tide:fallback_sinusoid")
    tide_now, tide_trend=interp_tide(ts, gen)
    current_mid, transform=surf_from_wave(spot,wave,tide_now)
    scale=1.0
    if obs_wave and mwave and mwave.get("height_ft"): scale=clamp(float(obs_wave.get("height_ft") or 1)/float(mwave.get("height_ft") or 1),.65,1.55)
    hourly=[]
    for hr in range(0,FORECAST_HOURS+1,3):
        tt=gen+dt.timedelta(hours=hr); lev,tr=interp_tide(ts,tt); mr=nearest(mm.get("rows",[]),tt) if mm else None; hw=marine_wave(mr,mm.get("source") if mm else "") if mr else wave
        if hw and mr: hw["height_ft"]=round(float(hw["height_ft"])*scale,2)
        mid,_=surf_from_wave(spot,hw or wave,lev); hwnd,_=wind_at(spot["id"], obs_wind if hr==0 else {}, tt, hr==0)
        hourly.append({"time":to_iso(tt),"surf_min_ft":round(max(0,math.floor(mid*.78*2)/2),1),"surf_max_ft":round(max(.5,math.ceil(mid*1.25*2)/2),1),"wind_speed_kt":hwnd.get("speed_kt"),"wind_direction_deg":hwnd.get("direction_deg"),"wind_quality":wind_quality(spot,hwnd)[0],"tide_level_ft":round(lev,2),"tide_trend":tr})
    low, high = hourly[0]["surf_min_ft"], hourly[0]["surf_max_ft"]
    wlabel, wscore=wind_quality(spot,wind); conf=confidence(statuses); rate=rating((low+high)/2,wscore,conf)
    sr=sun_time(gen,float(spot["lat"]),float(spot["lon"]),True); ss=sun_time(gen,float(spot["lat"]),float(spot["lon"]),False)
    return {"spot_id":spot["id"],"name":spot["name"],"region":spot.get("region"),"lat":spot["lat"],"lon":spot["lon"],"last_updated":to_iso(gen),"surf_height_ft":{"min":low,"max":high,"human":f"{low:g}-{high:g} ft"},"rating":rate,"confidence":conf,"best_window":"Dawn to mid-morning" if (wind.get("speed_kt") or 99)<=8 else "Early, before wind","primary_swell":{"height_ft":wave.get("height_ft"),"period_s":wave.get("period_s"),"direction_deg":wave.get("direction_deg"),"direction_compass":compass(wave.get("direction_deg")),"source":wave.get("source"),"station_id":wave.get("station_id"),"station_name":wave.get("station_name"),"observed_height_ft":wave.get("observed_height_ft"),"model_height_ft":wave.get("model_height_ft")},"secondary_swell":secondary(mrow,obs_wave),"wind":{"speed_kt":wind.get("speed_kt"),"gust_kt":wind.get("gust_kt"),"direction_deg":wind.get("direction_deg"),"direction_compass":compass(wind.get("direction_deg")),"quality":wlabel,"source":wind.get("source")},"tide":{"station_id":spot.get("public_data",{}).get("nearest_tide_station",{}).get("id"),"station_name":spot.get("public_data",{}).get("nearest_tide_station",{}).get("name"),"level_ft":round(tide_now,2),"trend":tide_trend},"sun":{"sunrise_utc":to_iso(sr) if sr else None,"sunset_utc":to_iso(ss) if ss else None,"sunrise_label":sr.strftime("%H:%M UTC") if sr else "—","sunset_label":ss.strftime("%H:%M UTC") if ss else "—"},"model_notes":{"callout":f"{compass(wave.get('direction_deg'))} swell @ {wave.get('period_s')}s; {wlabel} {compass(wind.get('direction_deg'))} wind; tide {tide_now:.1f} ft {tide_trend}.","transform":transform,"beach_orientation_deg":spot.get("beach_orientation_deg"),"source_station":wave.get("station_name") or wind.get("station_name"),"model_version":"west coast model V1"},"hourly":hourly,"data_status":statuses,"warnings":[s for s in statuses if any(x in s for x in ["failed","fallback","unavailable","offline"])]}

def main() -> None:
    ap=argparse.ArgumentParser(); ap.add_argument("--spots",type=Path,default=SPOTS_PATH); ap.add_argument("--out",type=Path,default=OUT_PATH); ap.add_argument("--limit",type=int,default=0); args=ap.parse_args()
    spots=json.loads(args.spots.read_text()); active=[s for s in spots if s.get("active",True)]
    if args.limit: active=active[:args.limit]
    gen=now_utc(); print(f"Fetching model guidance for {len(active)} spots..."); fetch_models(active)
    forecasts={}; warnings=list(MODEL_WARNINGS)
    for i,spot in enumerate(active,1):
        print(f"[{i}/{len(active)}] {spot['name']}")
        try: fc=forecast_spot(spot,gen)
        except Exception as exc:
            status=f"spot_pipeline_failed:{type(exc).__name__}:{exc}"; warnings.append(status); wave=fallback_wave(spot,gen); fc={"spot_id":spot["id"],"name":spot["name"],"region":spot.get("region"),"lat":spot["lat"],"lon":spot["lon"],"last_updated":to_iso(gen),"surf_height_ft":{"min":1,"max":2,"human":"1-2 ft"},"rating":"unknown","confidence":.15,"primary_swell":wave,"secondary_swell":None,"wind":fallback_wind(gen),"tide":{},"sun":{},"model_notes":{"callout":"Fallback forecast only."},"hourly":[],"data_status":[status],"warnings":[status]}
        forecasts[spot["id"]]=fc; warnings+=fc.get("warnings",[])
    payload={"generated_at":to_iso(gen),"valid_for_hours":FORECAST_HOURS,"model":"calisurf-west-coast-model-v1","display_name":"CaliSurf Light","subtitle":"west coast model V1","units":{"height":"ft","wind":"kt","tide":"ft MLLW"},"sources":{"waves_forecast":"Open-Meteo Marine API best-match wave model guidance","waves_observed":"NDBC realtime flat files and CDIP stations mirrored through NDBC when available","wind_forecast":"Open-Meteo Weather Forecast API best-match 10 m wind guidance","tides":"NOAA CO-OPS predictions","bathymetry":"empirical California shelf/canyon/reef exposure coefficients in spots.json; NCEI CRM/ETOPO raster sampler remains the next precision upgrade"},"data_status":{"forecast_count":len(forecasts),"warning_count":len(warnings),"warnings_sample":warnings[:80],"openmeteo_marine_spots":len(MARINE),"openmeteo_wind_spots":len(WIND)},"forecasts":forecasts}
    args.out.parent.mkdir(parents=True,exist_ok=True); args.out.write_text(json.dumps(payload,indent=2)+"\n"); print(f"Wrote {len(forecasts)} forecasts to {args.out}")
if __name__ == "__main__": main()
