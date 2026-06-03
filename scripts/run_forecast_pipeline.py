#!/usr/bin/env python3
"""
run_forecast_pipeline.py

Daily Stage 1 surf forecast pipeline.

This script is designed to run in GitHub Actions at ~2 AM Pacific. It reads
public/data/spots.json, fetches lightweight public marine data when available,
applies simple spot exposure rules, and writes public/data/latest_forecasts.json.

Important design choice:
- The browser does not fetch NOAA/CDIP/NDBC directly.
- The browser only downloads this one JSON file, which keeps the widget fast.

Data sources used in Stage 1:
- NDBC realtime files for buoy wave/wind observations.
- CDIP stations that are mirrored through NDBC station IDs when available.
- NOAA CO-OPS API for tide predictions.
- Optional GFS-Wave hook is included, but full GRIB parsing is intentionally
  off by default to keep this beginner version easy to run. Turn it on later
  with ENABLE_GFSWAVE=1 after adding cfgrib/eccodes handling.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

ROOT = Path(__file__).resolve().parents[1]
SPOTS_PATH = ROOT / "public" / "data" / "spots.json"
OUT_PATH = ROOT / "public" / "data" / "latest_forecasts.json"

M_TO_FT = 3.28084
MPS_TO_KT = 1.94384
UTC = dt.timezone.utc

NDBC_BASE = "https://www.ndbc.noaa.gov/data/realtime2"
COOPS_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"

# Simple in-process caches keep the daily run polite: many surf spots share the
# same buoy and tide stations, so each station file should be fetched only once.
NDBC_CACHE: Dict[Tuple[str, str], Tuple[Optional[Dict[str, str]], str]] = {}
TIDE_CACHE: Dict[Tuple[str, str], Tuple[List[Dict[str, Any]], List[str]]] = {}


def now_utc() -> dt.datetime:
    return dt.datetime.now(tz=UTC).replace(microsecond=0)


def to_iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def angle_diff_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def nearest_direction_bin(direction: float, exposure_table: Dict[str, float]) -> str:
    bins = [float(k) for k in exposure_table.keys()]
    if not bins:
        return "270"
    best = min(bins, key=lambda b: angle_diff_deg(direction, b))
    return str(int(best))


def compass_from_deg(deg: Optional[float]) -> str:
    if deg is None or not math.isfinite(float(deg)):
        return "—"
    dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return dirs[int((float(deg) + 11.25) / 22.5) % 16]


def safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        s = str(value).strip()
        if s in {"", "MM", "99", "99.0", "999", "999.0", "9999", "9999.0"}:
            return None
        v = float(s)
        if abs(v) >= 999:
            return None
        return v
    except Exception:
        return None


def safe_get(url: str, *, params: Optional[dict] = None, timeout: int = 16) -> requests.Response:
    headers = {"User-Agent": "california-surf-light/0.1 (educational open-data widget)"}
    r = requests.get(url, params=params, timeout=timeout, headers=headers)
    r.raise_for_status()
    return r


def parse_ndbc_table(text: str) -> List[Dict[str, str]]:
    """Parse an NDBC flat-file table into rows. Latest row is usually first."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 3:
        return []
    header = lines[0].lstrip("#").split()
    rows: List[Dict[str, str]] = []
    for line in lines[2:]:
        parts = line.split()
        if len(parts) < len(header):
            continue
        rows.append(dict(zip(header, parts)))
    return rows


def row_time_utc(row: Dict[str, str]) -> Optional[dt.datetime]:
    try:
        year_key = "YY" if "YY" in row else "YYYY"
        year = int(row[year_key])
        if year < 100:
            year += 2000 if year < 80 else 1900
        month = int(row["MM"])
        day = int(row["DD"])
        hour = int(row.get("hh", row.get("HH", 0)))
        minute = int(row.get("mm", 0))
        return dt.datetime(year, month, day, hour, minute, tzinfo=UTC)
    except Exception:
        return None


def fetch_ndbc_latest(station_id: str, suffix: str) -> Tuple[Optional[Dict[str, str]], str]:
    cache_key = (station_id, suffix)
    if cache_key in NDBC_CACHE:
        row, status = NDBC_CACHE[cache_key]
        return row, status + ":cached"
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1":
        result = (None, f"{station_id}.{suffix}:offline")
        NDBC_CACHE[cache_key] = result
        return result
    url = f"{NDBC_BASE}/{station_id}.{suffix}"
    try:
        text = safe_get(url).text
        rows = parse_ndbc_table(text)
        if not rows:
            result = (None, f"{station_id}.{suffix}:empty")
            NDBC_CACHE[cache_key] = result
            return result
        # Pick the row with the newest timestamp.
        rows = sorted(rows, key=lambda r: row_time_utc(r) or dt.datetime(1900, 1, 1, tzinfo=UTC), reverse=True)
        result = (rows[0], f"{station_id}.{suffix}:ok")
        NDBC_CACHE[cache_key] = result
        return result
    except Exception as exc:
        result = (None, f"{station_id}.{suffix}:failed:{type(exc).__name__}")
        NDBC_CACHE[cache_key] = result
        return result


def fetch_wave_and_wind_from_buoys(spot: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """Try nearest NDBC/CDIP-mirrored stations until one works."""
    statuses: List[str] = []
    candidates = spot.get("public_data", {}).get("buoy_candidates", [])[:5]
    for station in candidates:
        sid = station["id"]
        spec, spec_status = fetch_ndbc_latest(sid, "spec")
        txt, txt_status = fetch_ndbc_latest(sid, "txt")
        statuses.extend([spec_status, txt_status])

        wave: Dict[str, Any] = {}
        wind: Dict[str, Any] = {}

        if spec:
            wave_height_m = safe_float(spec.get("WVHT")) or safe_float(spec.get("SwH"))
            wave_period_s = safe_float(spec.get("SwP")) or safe_float(spec.get("DPD")) or safe_float(spec.get("APD"))
            wave_dir = safe_float(spec.get("SwD")) or safe_float(spec.get("MWD"))
            secondary_height_m = safe_float(spec.get("WWH"))
            secondary_period_s = safe_float(spec.get("WWP"))
            secondary_dir = safe_float(spec.get("WWD"))
            if wave_height_m and wave_period_s:
                wave = {
                    "source": "NDBC/CDIP realtime spec",
                    "station_id": sid,
                    "station_name": station.get("name", sid),
                    "height_ft": round(wave_height_m * M_TO_FT, 2),
                    "period_s": round(wave_period_s, 1),
                    "direction_deg": round(wave_dir if wave_dir is not None else 270),
                    "secondary_height_ft": round(secondary_height_m * M_TO_FT, 2) if secondary_height_m else None,
                    "secondary_period_s": round(secondary_period_s, 1) if secondary_period_s else None,
                    "secondary_direction_deg": round(secondary_dir) if secondary_dir is not None else None,
                }

        if txt:
            wind_dir = safe_float(txt.get("WDIR"))
            wind_speed_mps = safe_float(txt.get("WSPD"))
            gust_mps = safe_float(txt.get("GST"))
            # TXT files sometimes include usable wave values if SPEC failed.
            if not wave:
                h = safe_float(txt.get("WVHT"))
                p = safe_float(txt.get("DPD")) or safe_float(txt.get("APD"))
                d = safe_float(txt.get("MWD"))
                if h and p:
                    wave = {
                        "source": "NDBC realtime txt",
                        "station_id": sid,
                        "station_name": station.get("name", sid),
                        "height_ft": round(h * M_TO_FT, 2),
                        "period_s": round(p, 1),
                        "direction_deg": round(d if d is not None else 270),
                        "secondary_height_ft": None,
                        "secondary_period_s": None,
                        "secondary_direction_deg": None,
                    }
            if wind_speed_mps is not None:
                wind = {
                    "source": "NDBC realtime txt",
                    "station_id": sid,
                    "station_name": station.get("name", sid),
                    "speed_kt": round(wind_speed_mps * MPS_TO_KT, 1),
                    "gust_kt": round(gust_mps * MPS_TO_KT, 1) if gust_mps is not None else None,
                    "direction_deg": round(wind_dir if wind_dir is not None else 270),
                }

        if wave or wind:
            return {"wave": wave, "wind": wind}, statuses

    return {"wave": {}, "wind": {}}, statuses or ["buoy:no_candidates"]


def fallback_wave(spot: Dict[str, Any], t: dt.datetime) -> Dict[str, Any]:
    """Deterministic seasonal fallback so the app still works offline."""
    lat = float(spot["lat"])
    # Winter North Pacific gets more WNW/NW energy; summer gets more S/SSW energy.
    doy = t.timetuple().tm_yday
    winter = (math.cos(2 * math.pi * (doy - 15) / 365.25) + 1) / 2
    summer = 1 - winter
    rand = random.Random(f"{spot['id']}-{t.date().isoformat()}")
    base = 1.6 + 2.0 * winter + 0.8 * max(0, (lat - 34) / 8)
    height = base + rand.uniform(-0.35, 0.45)
    if summer > winter:
        direction = 195 + rand.uniform(-15, 15)
        period = 13.5 + rand.uniform(-2.0, 2.0)
    else:
        direction = 285 + rand.uniform(-18, 18)
        period = 11.0 + rand.uniform(-1.5, 3.5)
    return {
        "source": "fallback seasonal climatology",
        "station_id": None,
        "station_name": None,
        "height_ft": round(clamp(height, 0.8, 9.0), 2),
        "period_s": round(clamp(period, 6.0, 20.0), 1),
        "direction_deg": round(direction % 360),
        "secondary_height_ft": round(clamp(height * 0.42, 0.4, 4.0), 2),
        "secondary_period_s": round(max(6.0, period - 4.0), 1),
        "secondary_direction_deg": 275 if summer > winter else 205,
    }


def fallback_wind(spot: Dict[str, Any], t: dt.datetime) -> Dict[str, Any]:
    lat = float(spot["lat"])
    rand = random.Random(f"wind-{spot['id']}-{t.date().isoformat()}")
    # Typical CA: lighter AM, W/NW sea breeze later. Daily run starts with early AM values.
    speed = 4.0 + rand.uniform(0.0, 4.0) + max(0.0, lat - 37.0) * 0.25
    direction = 285 if lat > 35 else 265
    return {
        "source": "fallback coastal wind pattern",
        "station_id": None,
        "station_name": None,
        "speed_kt": round(speed, 1),
        "gust_kt": round(speed + 4.0, 1),
        "direction_deg": direction,
    }


def noaa_time(d: dt.datetime) -> str:
    return d.astimezone(UTC).strftime("%Y%m%d %H:%M")


def parse_coops_time(value: str) -> dt.datetime:
    return dt.datetime.strptime(value, "%Y-%m-%d %H:%M").replace(tzinfo=UTC)


def fetch_tide_series(spot: Dict[str, Any], t: dt.datetime) -> Tuple[List[Dict[str, Any]], List[str]]:
    station = spot.get("public_data", {}).get("nearest_tide_station", {})
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1":
        sid = station.get("id", "unknown")
        return [], [f"tide:{sid}:offline"]
    sid = station.get("id")
    if not sid:
        return [], ["tide:no_station"]
    cache_key = (sid, t.strftime("%Y%m%d"))
    if cache_key in TIDE_CACHE:
        series, statuses = TIDE_CACHE[cache_key]
        return series, [s + ":cached" for s in statuses]

    begin = t - dt.timedelta(hours=6)
    end = t + dt.timedelta(hours=30)
    params = {
        "product": "predictions",
        "application": "california_surf_light",
        "begin_date": noaa_time(begin),
        "end_date": noaa_time(end),
        "datum": "MLLW",
        "station": sid,
        "time_zone": "gmt",
        "units": "english",
        "interval": "h",
        "format": "json",
    }
    try:
        data = safe_get(COOPS_API, params=params).json()
        rows = data.get("predictions", [])
        series = [{"time": parse_coops_time(r["t"]), "level_ft": float(r["v"])} for r in rows]
        if not series:
            result = ([], [f"tide:{sid}:empty"])
            TIDE_CACHE[cache_key] = result
            return result
        result = (series, [f"tide:{sid}:ok"])
        TIDE_CACHE[cache_key] = result
        return result
    except Exception as exc:
        result = ([], [f"tide:{sid}:failed:{type(exc).__name__}"])
        TIDE_CACHE[cache_key] = result
        return result


def fallback_tide_series(spot: Dict[str, Any], t: dt.datetime) -> List[Dict[str, Any]]:
    station = spot.get("public_data", {}).get("nearest_tide_station", {})
    phase = (sum(ord(c) for c in str(station.get("id", spot["id"]))) % 360) / 180 * math.pi
    series = []
    start = t - dt.timedelta(hours=6)
    for h in range(0, 37):
        current = start + dt.timedelta(hours=h)
        hours = current.timestamp() / 3600
        level = 2.8 + 2.1 * math.sin((hours / 12.42) * 2 * math.pi + phase)
        series.append({"time": current, "level_ft": round(level, 2)})
    return series


def interp_tide(series: List[Dict[str, Any]], t: dt.datetime) -> Tuple[float, str]:
    if not series:
        return 0.0, "unknown"
    series = sorted(series, key=lambda r: r["time"])
    if t <= series[0]["time"]:
        return float(series[0]["level_ft"]), "unknown"
    for i in range(1, len(series)):
        a = series[i - 1]
        b = series[i]
        if a["time"] <= t <= b["time"]:
            span = (b["time"] - a["time"]).total_seconds() or 1
            frac = (t - a["time"]).total_seconds() / span
            level = float(a["level_ft"]) + frac * (float(b["level_ft"]) - float(a["level_ft"]))
            trend = "rising" if float(b["level_ft"]) > float(a["level_ft"]) else "falling"
            return round(level, 2), trend
    return float(series[-1]["level_ft"]), "unknown"


def day_of_year(date: dt.datetime) -> int:
    return int(date.strftime("%j"))


def sun_time_utc(date: dt.datetime, lat: float, lon: float, is_rise: bool) -> Optional[dt.datetime]:
    """Small NOAA-style sunrise/sunset approximation, no dependency needed."""
    zenith = 90.833
    n = day_of_year(date)
    lng_hour = lon / 15.0
    t = n + (((6 if is_rise else 18) - lng_hour) / 24.0)
    m = (0.9856 * t) - 3.289
    l = (m + 1.916 * math.sin(math.radians(m)) + 0.020 * math.sin(math.radians(2 * m)) + 282.634) % 360
    ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l)))) % 360
    l_quadrant = math.floor(l / 90) * 90
    ra_quadrant = math.floor(ra / 90) * 90
    ra = (ra + (l_quadrant - ra_quadrant)) / 15.0
    sin_dec = 0.39782 * math.sin(math.radians(l))
    cos_dec = math.cos(math.asin(sin_dec))
    cos_h = (math.cos(math.radians(zenith)) - sin_dec * math.sin(math.radians(lat))) / (cos_dec * math.cos(math.radians(lat)))
    if cos_h > 1 or cos_h < -1:
        return None
    h = (360 - math.degrees(math.acos(cos_h))) if is_rise else math.degrees(math.acos(cos_h))
    h /= 15.0
    local_mean = h + ra - (0.06571 * t) - 6.622
    utc_hour = (local_mean - lng_hour) % 24
    midnight = dt.datetime(date.year, date.month, date.day, tzinfo=UTC)
    return midnight + dt.timedelta(hours=utc_hour)


def local_pacific_time_string(t: Optional[dt.datetime]) -> str:
    if not t:
        return "—"
    # Keep it dependency-free. Browser can localize later; for the JSON use UTC ISO too.
    return t.strftime("%H:%M UTC")


def exposure_for_direction(spot: Dict[str, Any], direction_deg: float) -> float:
    table = spot.get("exposure_by_direction") or {}
    key = nearest_direction_bin(direction_deg, table)
    return float(table.get(key, 0.8))


def surf_height_from_swell(spot: Dict[str, Any], wave: Dict[str, Any], tide_level: float) -> Tuple[float, Dict[str, Any]]:
    h = float(wave.get("height_ft") or 2.0)
    p = float(wave.get("period_s") or 10.0)
    d = float(wave.get("direction_deg") or 270.0)
    exposure = exposure_for_direction(spot, d)
    bathy = spot.get("bathymetry") or {}
    bathy_gain = float(bathy.get("canyon_multiplier", 1.0) or 1.0) * float(bathy.get("reef_multiplier", 1.0) or 1.0) * float(bathy.get("shadowing_multiplier", 1.0) or 1.0)
    period_bonus = 0.72 + clamp((p - 6.0) / 18.0, 0.0, 0.85)
    tide_modifier = 1.0
    # Generic tide penalty away from a mid tide. Real spots need tuning.
    if tide_level < 0.0 or tide_level > 6.5:
        tide_modifier = 0.88
    elif 1.0 <= tide_level <= 4.8:
        tide_modifier = 1.05

    # Face-height-ish estimate. This is a spot transform, not a full nearshore model.
    surf = h * exposure * bathy_gain * period_bonus * tide_modifier
    surf = clamp(surf, 0.2, 25.0)
    detail = {
        "input_height_ft": h,
        "input_period_s": p,
        "input_direction_deg": d,
        "directional_exposure": round(exposure, 2),
        "bathymetry_gain": round(bathy_gain, 2),
        "period_bonus": round(period_bonus, 2),
        "tide_modifier": round(tide_modifier, 2),
    }
    return round(surf, 2), detail


def wind_quality(spot: Dict[str, Any], wind: Dict[str, Any]) -> Tuple[str, float]:
    speed = float(wind.get("speed_kt") or 0.0)
    direction = float(wind.get("direction_deg") or 270.0)
    shore_normal = float(spot.get("beach_orientation_deg") or 260.0)
    offshore_from = (shore_normal + 180.0) % 360
    offshore_diff = angle_diff_deg(direction, offshore_from)
    onshore_diff = angle_diff_deg(direction, shore_normal)

    score = 0.65
    if offshore_diff < 55:
        score += 0.25
    if onshore_diff < 55:
        score -= 0.30
    if speed > 12:
        score -= 0.15
    if speed > 20:
        score -= 0.20
    score = clamp(score, 0.05, 0.98)
    if score >= 0.78:
        label = "clean"
    elif score >= 0.55:
        label = "fair"
    elif score >= 0.35:
        label = "bumpy"
    else:
        label = "poor"
    return label, round(score, 2)


def rating_from_scores(surf_mid: float, wind_score: float, confidence: float) -> str:
    if surf_mid < 1.0:
        return "flat"
    score = 0.45 * clamp(surf_mid / 6.0, 0, 1) + 0.40 * wind_score + 0.15 * confidence
    if score >= 0.75:
        return "good"
    if score >= 0.58:
        return "fair-good"
    if score >= 0.42:
        return "fair"
    return "poor"


def confidence_from_status(statuses: Iterable[str]) -> float:
    text = "|".join(statuses)
    score = 0.35
    if ".spec:ok" in text or ".txt:ok" in text:
        score += 0.25
    if "tide:" in text and ":ok" in text:
        score += 0.15
    if "fallback" not in text:
        score += 0.15
    if "gfswave:disabled" in text:
        score -= 0.05
    return round(clamp(score, 0.15, 0.92), 2)


def best_window_from_wind_and_sun(wind: Dict[str, Any], sunrise: Optional[dt.datetime]) -> str:
    speed = float(wind.get("speed_kt") or 0.0)
    if speed <= 8:
        return "Dawn to mid-morning"
    if speed <= 14:
        return "Early, before wind"
    return "Small window near sunrise"


def optional_gfswave_status(spot: Dict[str, Any]) -> str:
    """
    Placeholder hook for Stage 1.

    Full GFS-Wave use requires downloading small GRIB2 subsets from NOMADS and
    parsing with cfgrib/eccodes. That is useful, but not necessary for the first
    static app. This hook records the intended source without making the daily
    pipeline fragile.
    """
    if os.environ.get("ENABLE_GFSWAVE") == "1":
        return "gfswave:enabled_hook_add_cfgrib_later"
    return "gfswave:disabled_light_stage1"


def build_forecast_for_spot(spot: Dict[str, Any], generated_at: dt.datetime) -> Dict[str, Any]:
    statuses: List[str] = []
    fetched, buoy_statuses = fetch_wave_and_wind_from_buoys(spot)
    statuses.extend(buoy_statuses)
    wave = fetched.get("wave") or {}
    wind = fetched.get("wind") or {}
    if not wave:
        wave = fallback_wave(spot, generated_at)
        statuses.append("wave:fallback_climatology")
    if not wind:
        wind = fallback_wind(spot, generated_at)
        statuses.append("wind:fallback_pattern")
    statuses.append(optional_gfswave_status(spot))

    tide_series, tide_statuses = fetch_tide_series(spot, generated_at)
    statuses.extend(tide_statuses)
    if not tide_series:
        tide_series = fallback_tide_series(spot, generated_at)
        statuses.append("tide:fallback_sinusoid")
    tide_now, tide_trend = interp_tide(tide_series, generated_at)

    surf_mid, transform = surf_height_from_swell(spot, wave, tide_now)
    low = max(0.0, math.floor((surf_mid * 0.78) * 2) / 2)
    high = max(low + 0.5, math.ceil((surf_mid * 1.25) * 2) / 2)

    secondary = None
    if wave.get("secondary_height_ft") and wave.get("secondary_period_s"):
        secondary = {
            "height_ft": wave.get("secondary_height_ft"),
            "period_s": wave.get("secondary_period_s"),
            "direction_deg": wave.get("secondary_direction_deg"),
            "direction_compass": compass_from_deg(wave.get("secondary_direction_deg")),
        }
    else:
        secondary = {
            "height_ft": round(float(wave.get("height_ft", 2.0)) * 0.42, 1),
            "period_s": max(6.0, round(float(wave.get("period_s", 10.0)) - 4.0, 1)),
            "direction_deg": 275 if float(wave.get("direction_deg", 270)) < 250 else 205,
            "direction_compass": compass_from_deg(275 if float(wave.get("direction_deg", 270)) < 250 else 205),
        }

    wind_label, wind_score = wind_quality(spot, wind)
    confidence = confidence_from_status(statuses)
    rating = rating_from_scores((low + high) / 2, wind_score, confidence)
    sunrise = sun_time_utc(generated_at, float(spot["lat"]), float(spot["lon"]), True)
    sunset = sun_time_utc(generated_at, float(spot["lat"]), float(spot["lon"]), False)

    hourly = []
    for hour in range(0, 25, 3):
        ht = generated_at + dt.timedelta(hours=hour)
        tide_level, tide_dir = interp_tide(tide_series, ht)
        # Slight deterministic change through the day so the graph is not flat.
        day_factor = 1.0 + 0.06 * math.sin(hour / 24.0 * 2 * math.pi)
        h_mid = surf_mid * day_factor
        hourly.append({
            "time": to_iso(ht),
            "surf_min_ft": round(max(0, math.floor((h_mid * 0.78) * 2) / 2), 1),
            "surf_max_ft": round(max(0.5, math.ceil((h_mid * 1.25) * 2) / 2), 1),
            "wind_speed_kt": wind.get("speed_kt"),
            "wind_direction_deg": wind.get("direction_deg"),
            "tide_level_ft": round(tide_level, 2),
            "tide_trend": tide_dir,
        })

    source_station = wave.get("station_name") or wind.get("station_name") or "fallback"
    callout = (
        f"{compass_from_deg(wave.get('direction_deg'))} swell @ {wave.get('period_s')}s; "
        f"{wind_label} {compass_from_deg(wind.get('direction_deg'))} wind; "
        f"tide {tide_now:.1f} ft {tide_trend}."
    )

    return {
        "spot_id": spot["id"],
        "name": spot["name"],
        "region": spot.get("region"),
        "lat": spot["lat"],
        "lon": spot["lon"],
        "last_updated": to_iso(generated_at),
        "surf_height_ft": {"min": round(low, 1), "max": round(high, 1), "human": f"{round(low,1):g}-{round(high,1):g} ft"},
        "rating": rating,
        "confidence": confidence,
        "best_window": best_window_from_wind_and_sun(wind, sunrise),
        "primary_swell": {
            "height_ft": wave.get("height_ft"),
            "period_s": wave.get("period_s"),
            "direction_deg": wave.get("direction_deg"),
            "direction_compass": compass_from_deg(wave.get("direction_deg")),
            "source": wave.get("source"),
            "station_id": wave.get("station_id"),
            "station_name": wave.get("station_name"),
        },
        "secondary_swell": secondary,
        "wind": {
            "speed_kt": wind.get("speed_kt"),
            "gust_kt": wind.get("gust_kt"),
            "direction_deg": wind.get("direction_deg"),
            "direction_compass": compass_from_deg(wind.get("direction_deg")),
            "quality": wind_label,
            "source": wind.get("source"),
        },
        "tide": {
            "station_id": spot.get("public_data", {}).get("nearest_tide_station", {}).get("id"),
            "station_name": spot.get("public_data", {}).get("nearest_tide_station", {}).get("name"),
            "level_ft": round(tide_now, 2),
            "trend": tide_trend,
        },
        "sun": {
            "sunrise_utc": to_iso(sunrise) if sunrise else None,
            "sunset_utc": to_iso(sunset) if sunset else None,
            "sunrise_label": local_pacific_time_string(sunrise),
            "sunset_label": local_pacific_time_string(sunset),
        },
        "model_notes": {
            "callout": callout,
            "transform": transform,
            "beach_orientation_deg": spot.get("beach_orientation_deg"),
            "source_station": source_station,
        },
        "hourly": hourly,
        "data_status": statuses,
        "warnings": [s for s in statuses if "failed" in s or "fallback" in s or "disabled" in s],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spots", type=Path, default=SPOTS_PATH)
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    parser.add_argument("--limit", type=int, default=0, help="Optional limit for testing")
    args = parser.parse_args()

    if not args.spots.exists():
        raise SystemExit(f"Missing {args.spots}. Run scripts/build_spots_json.py first.")
    spots = json.loads(args.spots.read_text())
    active_spots = [s for s in spots if s.get("active", True)]
    if args.limit:
        active_spots = active_spots[: args.limit]

    generated_at = now_utc()
    forecasts: Dict[str, Any] = {}
    all_warnings: List[str] = []

    for i, spot in enumerate(active_spots, start=1):
        print(f"[{i}/{len(active_spots)}] {spot['name']}")
        try:
            forecast = build_forecast_for_spot(spot, generated_at)
        except Exception as exc:
            # Last-resort fallback for a single spot so one bad source cannot break the whole app.
            status = f"spot_pipeline_failed:{type(exc).__name__}:{exc}"
            all_warnings.append(status)
            wave = fallback_wave(spot, generated_at)
            wind = fallback_wind(spot, generated_at)
            forecast = {
                "spot_id": spot["id"],
                "name": spot["name"],
                "region": spot.get("region"),
                "lat": spot["lat"],
                "lon": spot["lon"],
                "last_updated": to_iso(generated_at),
                "surf_height_ft": {"min": 1, "max": 2, "human": "1-2 ft"},
                "rating": "unknown",
                "confidence": 0.15,
                "best_window": "unknown",
                "primary_swell": wave,
                "secondary_swell": None,
                "wind": wind,
                "tide": {},
                "sun": {},
                "model_notes": {"callout": "Fallback forecast only."},
                "hourly": [],
                "data_status": [status],
                "warnings": [status],
            }
        forecasts[spot["id"]] = forecast
        all_warnings.extend(forecast.get("warnings", []))

    payload = {
        "generated_at": to_iso(generated_at),
        "valid_for_hours": 30,
        "model": "california-public-light-stage1",
        "units": {"height": "ft", "wind": "kt", "tide": "ft MLLW"},
        "sources": {
            "waves_observed": "NDBC realtime flat files and CDIP stations mirrored through NDBC when available",
            "tides": "NOAA CO-OPS predictions",
            "bathymetry": "precomputed placeholder features ready for NCEI CRM/ETOPO rasters",
            "gfswave": "hook included; disabled by default in Stage 1 to avoid fragile GRIB parsing",
        },
        "data_status": {
            "forecast_count": len(forecasts),
            "warning_count": len(all_warnings),
            "warnings_sample": all_warnings[:80],
        },
        "forecasts": forecasts,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(forecasts)} forecasts to {args.out}")


if __name__ == "__main__":
    main()
