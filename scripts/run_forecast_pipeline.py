#!/usr/bin/env python3
"""
run_forecast_pipeline.py

CaliSurf Light · west coast model V1

Runs in GitHub Actions, fetches public surf-relevant data, applies a lightweight
spot transform, and writes public/data/latest_forecasts.json for the static app.

The browser does NOT call marine APIs. It only downloads the generated JSON.

Primary live sources in V1:
- Open-Meteo Marine API for wave model forecasts (best-match model feed;
  includes NCEP GFS Wave/other wave model feeds depending on location/time).
- Open-Meteo Weather Forecast API for real wind forecasts in knots.
- NDBC/CDIP-mirrored realtime buoy files for observed wave/wind anchoring.
- NOAA CO-OPS tide predictions.
- Empirical California spot exposure/bathymetry coefficients from spots.json.

If any public source fails, the script falls back only for that missing part so
one external outage cannot break the whole app.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests

ROOT = Path(__file__).resolve().parents[1]
SPOTS_PATH = ROOT / "public" / "data" / "spots.json"
OUT_PATH = ROOT / "public" / "data" / "latest_forecasts.json"
WAVE_GRID_OUT_PATH = ROOT / "public" / "data" / "wave_grid_24h.json"

M_TO_FT = 3.28084
MPS_TO_KT = 1.94384
UTC = dt.timezone.utc

NDBC_BASE = "https://www.ndbc.noaa.gov/data/realtime2"
COOPS_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
OPEN_METEO_MARINE_API = "https://marine-api.open-meteo.com/v1/marine"
OPEN_METEO_WEATHER_API = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_BATCH_SIZE = int(os.environ.get("OPEN_METEO_BATCH_SIZE", "35"))
FORECAST_HOURS = int(os.environ.get("SURF_FORECAST_HOURS", "120"))
WAVE_GRID_HOURS = int(os.environ.get("SURF_WAVE_GRID_HOURS", "24"))
PACIFIC = ZoneInfo("America/Los_Angeles")

NDBC_CACHE: Dict[Tuple[str, str], Tuple[Optional[Dict[str, str]], str]] = {}
TIDE_CACHE: Dict[Tuple[str, str], Tuple[List[Dict[str, Any]], List[str]]] = {}

# Filled once per run before spot forecasts are built.
MARINE_BY_SPOT_ID: Dict[str, Dict[str, Any]] = {}
WIND_BY_SPOT_ID: Dict[str, Dict[str, Any]] = {}
MODEL_FETCH_WARNINGS: List[str] = []


def now_utc() -> dt.datetime:
    return dt.datetime.now(tz=UTC).replace(microsecond=0)


def pacific_midnight_utc(t: dt.datetime) -> dt.datetime:
    local = t.astimezone(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0)
    return local.astimezone(UTC)


def next_utc_hour(t: dt.datetime) -> dt.datetime:
    t = t.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    return t


def to_iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).isoformat().replace("+00:00", "Z")


def parse_iso_utc(value: str) -> dt.datetime:
    # Open-Meteo returns strings such as 2026-06-03T21:00 with no timezone.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        s = str(value).strip()
        if s in {"", "MM", "M", "NA", "null", "None", "99", "99.0", "999", "999.0", "9999", "9999.0"}:
            return None
        v = float(s)
        if not math.isfinite(v) or abs(v) >= 999:
            return None
        return v
    except Exception:
        return None


def angle_diff_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def weighted_direction_deg(items: Sequence[Tuple[Optional[float], float]]) -> Optional[float]:
    x = y = 0.0
    for deg, weight in items:
        if deg is None or not math.isfinite(float(deg)) or weight <= 0:
            continue
        rad = math.radians(float(deg))
        x += math.sin(rad) * weight
        y += math.cos(rad) * weight
    if abs(x) < 1e-9 and abs(y) < 1e-9:
        return None
    return round((math.degrees(math.atan2(x, y)) + 360.0) % 360.0)


def compass_from_deg(deg: Optional[float]) -> str:
    if deg is None or not math.isfinite(float(deg)):
        return "—"
    dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return dirs[int((float(deg) + 11.25) / 22.5) % 16]


def nearest_direction_bin(direction: float, exposure_table: Dict[str, float]) -> str:
    bins = [float(k) for k in exposure_table.keys()]
    if not bins:
        return "270"
    best = min(bins, key=lambda b: angle_diff_deg(direction, b))
    return str(int(best))


def safe_get(url: str, *, params: Optional[dict] = None, timeout: int = 28) -> requests.Response:
    headers = {"User-Agent": "CaliSurf-Light/1.0 (educational open-data surf forecast app)"}
    r = requests.get(url, params=params, timeout=timeout, headers=headers)
    r.raise_for_status()
    return r


def chunks(items: Sequence[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for i in range(0, len(items), size):
        yield list(items[i:i + size])


# ---------------------------------------------------------------------------
# NDBC / CDIP realtime buoy observations
# ---------------------------------------------------------------------------

def parse_ndbc_table(text: str) -> List[Dict[str, str]]:
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
        rows = parse_ndbc_table(safe_get(url, timeout=16).text)
        if not rows:
            result = (None, f"{station_id}.{suffix}:empty")
            NDBC_CACHE[cache_key] = result
            return result
        rows = sorted(rows, key=lambda r: row_time_utc(r) or dt.datetime(1900, 1, 1, tzinfo=UTC), reverse=True)
        result = (rows[0], f"{station_id}.{suffix}:ok")
        NDBC_CACHE[cache_key] = result
        return result
    except Exception as exc:
        result = (None, f"{station_id}.{suffix}:failed:{type(exc).__name__}")
        NDBC_CACHE[cache_key] = result
        return result


def fetch_wave_and_wind_from_buoys(spot: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
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
                    "direction_deg": round(wave_dir) if wave_dir is not None else None,
                    "secondary_height_ft": round(secondary_height_m * M_TO_FT, 2) if secondary_height_m else None,
                    "secondary_period_s": round(secondary_period_s, 1) if secondary_period_s else None,
                    "secondary_direction_deg": round(secondary_dir) if secondary_dir is not None else None,
                }

        if txt:
            wind_dir = safe_float(txt.get("WDIR"))
            wind_speed_mps = safe_float(txt.get("WSPD"))
            gust_mps = safe_float(txt.get("GST"))
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
                        "direction_deg": round(d) if d is not None else None,
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
                    "direction_deg": round(wind_dir) if wind_dir is not None else None,
                }

        if wave or wind:
            return {"wave": wave, "wind": wind}, statuses

    return {"wave": {}, "wind": {}}, statuses or ["buoy:no_candidates"]


# ---------------------------------------------------------------------------
# Open-Meteo forecast models, batched to keep the daily run lightweight.
# ---------------------------------------------------------------------------

def normalise_open_meteo_payload(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return [payload]
    return []


def num_or_none(values: Dict[str, Any], key: str, index: int) -> Optional[float]:
    arr = values.get(key)
    if not isinstance(arr, list) or index >= len(arr):
        return None
    return safe_float(arr[index])


def rows_from_open_meteo_marine(item: Dict[str, Any]) -> List[Dict[str, Any]]:
    hourly = item.get("hourly") or {}
    times = hourly.get("time") or []
    rows: List[Dict[str, Any]] = []
    for i, raw_time in enumerate(times):
        try:
            row = {
                "time": parse_iso_utc(raw_time),
                "wave_height_ft": num_or_none(hourly, "wave_height", i),
                "wave_period_s": num_or_none(hourly, "wave_period", i),
                "wave_peak_period_s": num_or_none(hourly, "wave_peak_period", i),
                "wave_direction_deg": num_or_none(hourly, "wave_direction", i),
                "swell_height_ft": num_or_none(hourly, "swell_wave_height", i),
                "swell_period_s": num_or_none(hourly, "swell_wave_period", i),
                "swell_peak_period_s": num_or_none(hourly, "swell_wave_peak_period", i),
                "swell_direction_deg": num_or_none(hourly, "swell_wave_direction", i),
                "secondary_height_ft": num_or_none(hourly, "secondary_swell_wave_height", i),
                "secondary_period_s": num_or_none(hourly, "secondary_swell_wave_period", i),
                "secondary_direction_deg": num_or_none(hourly, "secondary_swell_wave_direction", i),
                "wind_wave_height_ft": num_or_none(hourly, "wind_wave_height", i),
                "wind_wave_period_s": num_or_none(hourly, "wind_wave_period", i),
                "wind_wave_direction_deg": num_or_none(hourly, "wind_wave_direction", i),
            }
            rows.append(row)
        except Exception:
            continue
    return rows


def rows_from_open_meteo_wind(item: Dict[str, Any]) -> List[Dict[str, Any]]:
    hourly = item.get("hourly") or {}
    times = hourly.get("time") or []
    rows: List[Dict[str, Any]] = []
    for i, raw_time in enumerate(times):
        try:
            rows.append({
                "time": parse_iso_utc(raw_time),
                "speed_kt": num_or_none(hourly, "wind_speed_10m", i),
                "direction_deg": num_or_none(hourly, "wind_direction_10m", i),
                "gust_kt": num_or_none(hourly, "wind_gusts_10m", i),
            })
        except Exception:
            continue
    return rows


def nearest_row(rows: Sequence[Dict[str, Any]], target: dt.datetime) -> Optional[Dict[str, Any]]:
    if not rows:
        return None
    return min(rows, key=lambda r: abs((r["time"] - target).total_seconds()))


def row_at_or_after(rows: Sequence[Dict[str, Any]], target: dt.datetime) -> Optional[Dict[str, Any]]:
    if not rows:
        return None
    future = [r for r in rows if r["time"] >= target - dt.timedelta(minutes=45)]
    if future:
        return min(future, key=lambda r: abs((r["time"] - target).total_seconds()))
    return nearest_row(rows, target)


def fetch_open_meteo_models(spots: Sequence[Dict[str, Any]]) -> None:
    MARINE_BY_SPOT_ID.clear()
    WIND_BY_SPOT_ID.clear()
    MODEL_FETCH_WARNINGS.clear()

    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1":
        MODEL_FETCH_WARNINGS.append("openmeteo:offline")
        return

    active = list(spots)
    for batch in chunks(active, OPEN_METEO_BATCH_SIZE):
        lats = ",".join(f"{float(s['lat']):.5f}" for s in batch)
        lons = ",".join(f"{float(s['lon']):.5f}" for s in batch)

        marine_params = {
            "latitude": lats,
            "longitude": lons,
            "hourly": ",".join([
                "wave_height", "wave_direction", "wave_period", "wave_peak_period",
                "swell_wave_height", "swell_wave_direction", "swell_wave_period", "swell_wave_peak_period",
                "secondary_swell_wave_height", "secondary_swell_wave_direction", "secondary_swell_wave_period",
                "wind_wave_height", "wind_wave_direction", "wind_wave_period",
            ]),
            "forecast_days": "6",
            "length_unit": "imperial",
            "timezone": "GMT",
            "cell_selection": "sea",
        }
        try:
            payload = safe_get(OPEN_METEO_MARINE_API, params=marine_params, timeout=40).json()
            items = normalise_open_meteo_payload(payload)
            if len(items) != len(batch):
                MODEL_FETCH_WARNINGS.append(f"openmeteo_marine:count_mismatch:{len(items)}:{len(batch)}")
            for spot, item in zip(batch, items):
                rows = rows_from_open_meteo_marine(item)
                if rows:
                    MARINE_BY_SPOT_ID[spot["id"]] = {
                        "source": "Open-Meteo Marine API best-match wave model",
                        "rows": rows,
                        "status": "openmeteo_marine:ok",
                    }
                else:
                    MODEL_FETCH_WARNINGS.append(f"openmeteo_marine:{spot['id']}:empty")
        except Exception as exc:
            MODEL_FETCH_WARNINGS.append(f"openmeteo_marine:failed:{type(exc).__name__}")

        weather_params = {
            "latitude": lats,
            "longitude": lons,
            "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
            "forecast_days": "6",
            "wind_speed_unit": "kn",
            "timezone": "GMT",
        }
        try:
            payload = safe_get(OPEN_METEO_WEATHER_API, params=weather_params, timeout=40).json()
            items = normalise_open_meteo_payload(payload)
            if len(items) != len(batch):
                MODEL_FETCH_WARNINGS.append(f"openmeteo_wind:count_mismatch:{len(items)}:{len(batch)}")
            for spot, item in zip(batch, items):
                rows = rows_from_open_meteo_wind(item)
                if rows:
                    WIND_BY_SPOT_ID[spot["id"]] = {
                        "source": "Open-Meteo Weather Forecast API best-match wind model",
                        "rows": rows,
                        "status": "openmeteo_wind:ok",
                    }
                else:
                    MODEL_FETCH_WARNINGS.append(f"openmeteo_wind:{spot['id']}:empty")
        except Exception as exc:
            MODEL_FETCH_WARNINGS.append(f"openmeteo_wind:failed:{type(exc).__name__}")


def marine_primary_from_row(row: Dict[str, Any], source: str) -> Optional[Dict[str, Any]]:
    # Prefer resolved swell component when available; otherwise use combined sea.
    h = row.get("swell_height_ft") or row.get("wave_height_ft")
    p = row.get("swell_period_s") or row.get("wave_period_s") or row.get("wave_peak_period_s")
    d = row.get("swell_direction_deg") or row.get("wave_direction_deg")
    if h is None or p is None:
        return None
    return {
        "source": source,
        "station_id": None,
        "station_name": "Open-Meteo marine grid",
        "height_ft": round(float(h), 2),
        "period_s": round(float(p), 1),
        "direction_deg": round(float(d)) if d is not None else None,
    }


def marine_secondary_from_row(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    candidates = [
        (row.get("secondary_height_ft"), row.get("secondary_period_s"), row.get("secondary_direction_deg")),
        (row.get("wind_wave_height_ft"), row.get("wind_wave_period_s"), row.get("wind_wave_direction_deg")),
    ]
    for h, p, d in candidates:
        if h is not None and p is not None and float(h) > 0.05:
            return {
                "height_ft": round(float(h), 2),
                "period_s": round(float(p), 1),
                "direction_deg": round(float(d)) if d is not None else None,
                "direction_compass": compass_from_deg(d),
                "source": "Open-Meteo marine model component",
            }
    return None


def blended_wave(obs_wave: Dict[str, Any], model_wave: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if obs_wave and model_wave:
        oh = float(obs_wave.get("height_ft") or model_wave.get("height_ft") or 2.0)
        mh = float(model_wave.get("height_ft") or oh)
        op = float(obs_wave.get("period_s") or model_wave.get("period_s") or 10.0)
        mp = float(model_wave.get("period_s") or op)
        od = obs_wave.get("direction_deg")
        md = model_wave.get("direction_deg")
        direction = weighted_direction_deg([(od, 0.62 if od is not None else 0.0), (md, 0.38 if md is not None else 0.0)])
        return {
            "source": "CDIP/NDBC observation blended with Open-Meteo marine forecast",
            "station_id": obs_wave.get("station_id"),
            "station_name": obs_wave.get("station_name") or model_wave.get("station_name"),
            "height_ft": round(0.60 * oh + 0.40 * mh, 2),
            "period_s": round(0.60 * op + 0.40 * mp, 1),
            "direction_deg": direction,
            "observed_height_ft": round(oh, 2),
            "model_height_ft": round(mh, 2),
        }
    if model_wave:
        return dict(model_wave)
    if obs_wave:
        return dict(obs_wave)
    return {}


def wind_from_model_and_obs(spot_id: str, obs_wind: Dict[str, Any], target: dt.datetime) -> Tuple[Dict[str, Any], str]:
    model = WIND_BY_SPOT_ID.get(spot_id)
    row = row_at_or_after(model.get("rows", []), target) if model else None
    if row and row.get("speed_kt") is not None:
        model_wind = {
            "source": model.get("source", "Open-Meteo wind model"),
            "station_id": None,
            "station_name": "Open-Meteo weather grid",
            "speed_kt": round(float(row.get("speed_kt") or 0.0), 1),
            "gust_kt": round(float(row.get("gust_kt") or (float(row.get("speed_kt") or 0.0) + 4.0)), 1),
            "direction_deg": round(float(row.get("direction_deg"))) if row.get("direction_deg") is not None else None,
        }
        if obs_wind and abs((target - now_utc()).total_seconds()) < 5400:
            # Current call is anchored a little toward observed buoy wind, future remains model.
            ospeed = float(obs_wind.get("speed_kt") or model_wind["speed_kt"])
            mspeed = float(model_wind["speed_kt"] or ospeed)
            ogust = float(obs_wind.get("gust_kt") or ospeed + 4.0)
            mgust = float(model_wind.get("gust_kt") or mspeed + 4.0)
            odir = obs_wind.get("direction_deg")
            mdir = model_wind.get("direction_deg")
            model_wind.update({
                "source": "NDBC observation blended with Open-Meteo wind forecast",
                "station_id": obs_wind.get("station_id"),
                "station_name": obs_wind.get("station_name") or model_wind.get("station_name"),
                "speed_kt": round(0.45 * ospeed + 0.55 * mspeed, 1),
                "gust_kt": round(0.45 * ogust + 0.55 * mgust, 1),
                "direction_deg": weighted_direction_deg([(odir, 0.45 if odir is not None else 0), (mdir, 0.55 if mdir is not None else 0)]),
            })
        return model_wind, "wind:model_ok"
    if obs_wind:
        return dict(obs_wind), "wind:observed_only"
    return fallback_wind_from_climatology(target), "wind:fallback_climatology"


# ---------------------------------------------------------------------------
# Tides, sun and fallback helpers
# ---------------------------------------------------------------------------

def fallback_wave(spot: Dict[str, Any], t: dt.datetime) -> Dict[str, Any]:
    lat = float(spot["lat"])
    doy = t.timetuple().tm_yday
    winter = (math.cos(2 * math.pi * (doy - 15) / 365.25) + 1) / 2
    summer = 1 - winter
    rand = random.Random(f"{spot['id']}-{t.date().isoformat()}")
    base = 1.4 + 2.0 * winter + 0.6 * max(0, (lat - 34) / 8)
    height = base + rand.uniform(-0.25, 0.45)
    if summer > winter:
        direction = 195 + rand.uniform(-15, 15)
        period = 13.5 + rand.uniform(-2.0, 2.0)
    else:
        direction = 285 + rand.uniform(-18, 18)
        period = 11.0 + rand.uniform(-1.5, 3.5)
    return {
        "source": "fallback seasonal climatology",
        "station_id": None,
        "station_name": "seasonal fallback",
        "height_ft": round(max(0.4, height), 2),
        "period_s": round(period, 1),
        "direction_deg": round(direction),
    }


def fallback_wind_from_climatology(t: dt.datetime) -> Dict[str, Any]:
    # Only used if Open-Meteo and buoy wind both fail.
    hour = t.hour
    sea_breeze = 1.0 if (hour >= 17 or hour <= 3) else 0.0
    speed = 5.0 + 3.0 * sea_breeze
    return {
        "source": "fallback coastal wind climatology",
        "station_id": None,
        "station_name": "fallback",
        "speed_kt": round(speed, 1),
        "gust_kt": round(speed + 4.0, 1),
        "direction_deg": 270,
    }


def noaa_time(d: dt.datetime) -> str:
    return d.astimezone(UTC).strftime("%Y%m%d %H:%M")


def parse_coops_time(value: str) -> dt.datetime:
    return dt.datetime.strptime(value, "%Y-%m-%d %H:%M").replace(tzinfo=UTC)


def fetch_tide_series(spot: Dict[str, Any], t: dt.datetime) -> Tuple[List[Dict[str, Any]], List[str]]:
    station = spot.get("public_data", {}).get("nearest_tide_station", {})
    sid = station.get("id")
    if not sid:
        return [], ["tide:no_station"]
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1":
        return [], [f"tide:{sid}:offline"]
    cache_key = (sid, t.strftime("%Y%m%d"))
    if cache_key in TIDE_CACHE:
        series, statuses = TIDE_CACHE[cache_key]
        return series, [s + ":cached" for s in statuses]

    begin = min(t - dt.timedelta(hours=6), pacific_midnight_utc(t) - dt.timedelta(hours=2))
    end = pacific_midnight_utc(t) + dt.timedelta(hours=FORECAST_HOURS + 4)
    params = {
        "product": "predictions",
        "application": "calisurf_light",
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
        data = safe_get(COOPS_API, params=params, timeout=24).json()
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
    start = pacific_midnight_utc(t) - dt.timedelta(hours=2)
    for h in range(0, FORECAST_HOURS + 9):
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
    return t.strftime("%H:%M UTC")


# ---------------------------------------------------------------------------
# Surf transform
# ---------------------------------------------------------------------------

def exposure_for_direction(spot: Dict[str, Any], direction_deg: float) -> float:
    table = spot.get("exposure_by_direction") or {}
    key = nearest_direction_bin(direction_deg, table)
    return float(table.get(key, 0.8))


def surf_height_from_swell(spot: Dict[str, Any], wave: Dict[str, Any], tide_level: float) -> Tuple[float, Dict[str, Any]]:
    h = float(wave.get("height_ft") or 2.0)
    p = float(wave.get("period_s") or 10.0)
    d = float(wave.get("direction_deg") if wave.get("direction_deg") is not None else spot.get("beach_orientation_deg") or 270.0)
    exposure = exposure_for_direction(spot, d)
    bathy = spot.get("bathymetry") or {}
    bathy_gain = (
        float(bathy.get("canyon_multiplier", 1.0) or 1.0)
        * float(bathy.get("reef_multiplier", 1.0) or 1.0)
        * float(bathy.get("shadowing_multiplier", 1.0) or 1.0)
    )
    slope = float(bathy.get("slope_5_20m", 0.035) or 0.035)
    slope_gain = clamp(0.92 + (slope - 0.03) * 3.3, 0.86, 1.16)
    period_bonus = 0.72 + clamp((p - 6.0) / 18.0, 0.0, 0.85)
    tide_modifier = 1.0
    if tide_level < -0.5 or tide_level > 7.0:
        tide_modifier = 0.86
    elif tide_level < 0.5 or tide_level > 5.8:
        tide_modifier = 0.94
    elif 1.0 <= tide_level <= 4.8:
        tide_modifier = 1.05

    surf = h * exposure * bathy_gain * slope_gain * period_bonus * tide_modifier
    surf = clamp(surf, 0.2, 30.0)
    detail = {
        "input_height_ft": round(h, 2),
        "input_period_s": round(p, 1),
        "input_direction_deg": round(d, 1),
        "directional_exposure": round(exposure, 2),
        "bathymetry_gain": round(bathy_gain * slope_gain, 2),
        "period_bonus": round(period_bonus, 2),
        "tide_modifier": round(tide_modifier, 2),
        "slope_gain": round(slope_gain, 2),
    }
    return round(surf, 2), detail


def wind_quality(spot: Dict[str, Any], wind: Dict[str, Any]) -> Tuple[str, float]:
    speed = float(wind.get("speed_kt") or 0.0)
    direction = float(wind.get("direction_deg") if wind.get("direction_deg") is not None else 270.0)
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
    score = 0.30
    if "openmeteo_marine:ok" in text:
        score += 0.23
    if ".spec:ok" in text or ".txt:ok" in text:
        score += 0.14
    if "openmeteo_wind:ok" in text or "wind:model_ok" in text:
        score += 0.18
    if "tide:" in text and ":ok" in text:
        score += 0.12
    if "bathymetry:empirical_v2" in text:
        score += 0.05
    if "fallback" in text:
        score -= 0.12
    if "failed" in text:
        score -= 0.10
    return round(clamp(score, 0.15, 0.96), 2)


def best_window_from_hourly(hourly: Sequence[Dict[str, Any]]) -> str:
    if not hourly:
        return "Dawn to mid-morning"
    scored = []
    for row in hourly:
        speed = float(row.get("wind_speed_kt") or 99)
        tide = float(row.get("tide_level_ft") or 0)
        height = (float(row.get("surf_min_ft") or 0) + float(row.get("surf_max_ft") or 0)) / 2
        hour = parse_iso_utc(row["time"]).hour
        # Gentle preference for daylight/early surf windows.
        time_bonus = 0.25 if 13 <= hour <= 18 else (0.10 if 12 <= hour <= 21 else 0.0)
        tide_bonus = 0.15 if 1.0 <= tide <= 4.8 else 0.0
        score = height * 0.30 - speed * 0.035 + time_bonus + tide_bonus
        scored.append((score, row))
    best = max(scored, key=lambda x: x[0])[1]
    bt = parse_iso_utc(best["time"])
    local_hour = (bt.hour - 7) % 24  # rough PT label; browser displays exact times elsewhere.
    if 4 <= local_hour <= 10:
        return "Dawn to mid-morning"
    if 10 < local_hour <= 14:
        return "Late morning to early afternoon"
    if 14 < local_hour <= 18:
        return "Afternoon window"
    return "Check hourly window"


def build_forecast_for_spot(spot: Dict[str, Any], generated_at: dt.datetime) -> Dict[str, Any]:
    statuses: List[str] = ["bathymetry:empirical_v2"]
    fetched, buoy_statuses = fetch_wave_and_wind_from_buoys(spot)
    statuses.extend(buoy_statuses)
    obs_wave = fetched.get("wave") or {}
    obs_wind = fetched.get("wind") or {}

    marine_model = MARINE_BY_SPOT_ID.get(spot["id"])
    if marine_model:
        statuses.append(marine_model.get("status", "openmeteo_marine:ok"))
    else:
        statuses.append("openmeteo_marine:unavailable")
    wind_model = WIND_BY_SPOT_ID.get(spot["id"])
    if wind_model:
        statuses.append(wind_model.get("status", "openmeteo_wind:ok"))
    else:
        statuses.append("openmeteo_wind:unavailable")

    marine_current = nearest_row(marine_model.get("rows", []), generated_at) if marine_model else None
    model_wave = marine_primary_from_row(marine_current, marine_model.get("source", "Open-Meteo marine model")) if marine_current else None
    wave = blended_wave(obs_wave, model_wave)
    if not wave:
        wave = fallback_wave(spot, generated_at)
        statuses.append("wave:fallback_climatology")

    current_wind, wind_status = wind_from_model_and_obs(spot["id"], obs_wind, generated_at)
    statuses.append(wind_status)
    wind_label, wind_score = wind_quality(spot, current_wind)

    tide_series, tide_statuses = fetch_tide_series(spot, generated_at)
    statuses.extend(tide_statuses)
    if not tide_series:
        tide_series = fallback_tide_series(spot, generated_at)
        statuses.append("tide:fallback_sinusoid")
    tide_now, tide_trend = interp_tide(tide_series, generated_at)

    current_surf_mid, current_transform = surf_height_from_swell(spot, wave, tide_now)

    # Bias-correct model future waves to observed current sea state when both are available.
    height_scale = 1.0
    if obs_wave and model_wave and model_wave.get("height_ft"):
        height_scale = clamp(float(obs_wave.get("height_ft") or 1) / float(model_wave.get("height_ft") or 1), 0.65, 1.55)

    hourly: List[Dict[str, Any]] = []
    forecast_start = pacific_midnight_utc(generated_at)
    for hour in range(0, FORECAST_HOURS + 1, 3):
        ht = forecast_start + dt.timedelta(hours=hour)
        tide_level, tide_dir = interp_tide(tide_series, ht)
        marine_row = row_at_or_after(marine_model.get("rows", []), ht) if marine_model else None
        model_row_wave = marine_primary_from_row(marine_row, marine_model.get("source", "Open-Meteo marine model")) if marine_row else None
        if model_row_wave:
            model_row_wave["height_ft"] = round(float(model_row_wave["height_ft"]) * height_scale, 2)
            hour_wave = model_row_wave
        elif hour == 0:
            hour_wave = wave
        else:
            hour_wave = wave
        h_mid, _ = surf_height_from_swell(spot, hour_wave, tide_level)
        hour_wind, _ = wind_from_model_and_obs(spot["id"], obs_wind if hour == 0 else {}, ht)
        hourly.append({
            "time": to_iso(ht),
            "surf_min_ft": round(max(0, math.floor((h_mid * 0.78) * 2) / 2), 1),
            "surf_max_ft": round(max(0.5, math.ceil((h_mid * 1.25) * 2) / 2), 1),
            "wind_speed_kt": hour_wind.get("speed_kt"),
            "wind_direction_deg": hour_wind.get("direction_deg"),
            "wind_quality": wind_quality(spot, hour_wind)[0],
            "tide_level_ft": round(tide_level, 2),
            "tide_trend": tide_dir,
        })

    low = max(0.0, math.floor((current_surf_mid * 0.78) * 2) / 2)
    high = max(low + 0.5, math.ceil((current_surf_mid * 1.25) * 2) / 2)

    secondary = marine_secondary_from_row(marine_current) if marine_current else None
    if not secondary and obs_wave.get("secondary_height_ft") and obs_wave.get("secondary_period_s"):
        secondary = {
            "height_ft": obs_wave.get("secondary_height_ft"),
            "period_s": obs_wave.get("secondary_period_s"),
            "direction_deg": obs_wave.get("secondary_direction_deg"),
            "direction_compass": compass_from_deg(obs_wave.get("secondary_direction_deg")),
            "source": "NDBC/CDIP realtime secondary component",
        }
    if not secondary:
        secondary = {
            "height_ft": round(float(wave.get("height_ft", 2.0)) * 0.38, 1),
            "period_s": max(5.0, round(float(wave.get("period_s", 10.0)) - 4.0, 1)),
            "direction_deg": None,
            "direction_compass": "—",
            "source": "derived residual component",
        }

    confidence = confidence_from_status(statuses)
    rating = rating_from_scores((low + high) / 2, wind_score, confidence)
    sunrise = sun_time_utc(generated_at, float(spot["lat"]), float(spot["lon"]), True)
    sunset = sun_time_utc(generated_at, float(spot["lat"]), float(spot["lon"]), False)
    source_station = wave.get("station_name") or current_wind.get("station_name") or "model grid"
    callout = (
        f"{compass_from_deg(wave.get('direction_deg'))} swell @ {wave.get('period_s')}s; "
        f"{wind_label} {compass_from_deg(current_wind.get('direction_deg'))} wind; "
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
        "best_window": best_window_from_hourly(hourly),
        "primary_swell": {
            "height_ft": wave.get("height_ft"),
            "period_s": wave.get("period_s"),
            "direction_deg": wave.get("direction_deg"),
            "direction_compass": compass_from_deg(wave.get("direction_deg")),
            "source": wave.get("source"),
            "station_id": wave.get("station_id"),
            "station_name": wave.get("station_name"),
            "observed_height_ft": wave.get("observed_height_ft"),
            "model_height_ft": wave.get("model_height_ft"),
        },
        "secondary_swell": secondary,
        "wind": {
            "speed_kt": current_wind.get("speed_kt"),
            "gust_kt": current_wind.get("gust_kt"),
            "direction_deg": current_wind.get("direction_deg"),
            "direction_compass": compass_from_deg(current_wind.get("direction_deg")),
            "quality": wind_label,
            "source": current_wind.get("source"),
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
            "transform": current_transform,
            "beach_orientation_deg": spot.get("beach_orientation_deg"),
            "source_station": source_station,
            "model_version": "west coast model V1",
        },
        "hourly": hourly,
        "data_status": statuses,
        "warnings": [s for s in statuses if "failed" in s or "fallback" in s or "unavailable" in s or "offline" in s],
    }


def build_last_resort_forecast(spot: Dict[str, Any], generated_at: dt.datetime, status: str) -> Dict[str, Any]:
    wave = fallback_wave(spot, generated_at)
    wind = fallback_wind_from_climatology(generated_at)
    tide_series = fallback_tide_series(spot, generated_at)
    tide_now, tide_trend = interp_tide(tide_series, generated_at)
    surf_mid, transform = surf_height_from_swell(spot, wave, tide_now)
    low = max(0, math.floor((surf_mid * 0.78) * 2) / 2)
    high = max(0.5, math.ceil((surf_mid * 1.25) * 2) / 2)
    return {
        "spot_id": spot["id"],
        "name": spot["name"],
        "region": spot.get("region"),
        "lat": spot["lat"],
        "lon": spot["lon"],
        "last_updated": to_iso(generated_at),
        "surf_height_ft": {"min": round(low, 1), "max": round(high, 1), "human": f"{round(low,1):g}-{round(high,1):g} ft"},
        "rating": "unknown",
        "confidence": 0.15,
        "best_window": "unknown",
        "primary_swell": wave,
        "secondary_swell": None,
        "wind": wind,
        "tide": {"level_ft": tide_now, "trend": tide_trend},
        "sun": {},
        "model_notes": {"callout": "Fallback forecast only.", "transform": transform},
        "hourly": [],
        "data_status": [status],
        "warnings": [status],
    }



# ---------------------------------------------------------------------------
# 24-hour regional wave color layer for the Leaflet canvas overlay
# ---------------------------------------------------------------------------

def frange(start: float, stop: float, step: float) -> List[float]:
    vals: List[float] = []
    cur = start
    while cur <= stop + 1e-9:
        vals.append(round(cur, 4))
        cur += step
    return vals


def california_wave_grid_points() -> List[Dict[str, float]]:
    """Coarse California + adjacent Pacific grid. Kept intentionally small for mobile JSON."""
    lats = frange(30.5, 42.5, 1.0)
    lons = frange(-125.5, -117.5, 1.0)
    pts: List[Dict[str, float]] = []
    for lat in lats:
        for lon in lons:
            # Avoid painting too far inland/east. Open-Meteo cell_selection=sea will still snap nearshore points to sea.
            if lon > -118.2 and lat > 33.8:
                continue
            pts.append({"lat": lat, "lon": lon})
    return pts


def synthetic_wave_grid(generated_at: dt.datetime, status: str = "wave_grid:fallback_synthetic") -> Dict[str, Any]:
    base = next_utc_hour(generated_at)
    points = california_wave_grid_points()
    frames: List[Dict[str, Any]] = []
    for hour in range(0, WAVE_GRID_HOURS + 1):
        t = base + dt.timedelta(hours=hour)
        frame_points = []
        for p in points:
            lat = p["lat"]
            lon = p["lon"]
            offshore = clamp((-118.0 - lon) / 7.0, 0.0, 1.0)
            north = clamp((lat - 31.0) / 11.5, 0.0, 1.0)
            pulse = 0.9 * math.sin((hour / 24.0) * 2 * math.pi + lat * 0.35 + lon * 0.18)
            height = clamp(2.0 + 3.2 * offshore + 1.3 * north + pulse, 0.5, 13.0)
            direction = (280 + 18 * math.sin(hour / 5.0 + lat / 3.0)) % 360
            frame_points.append({"lat": lat, "lon": lon, "height_ft": round(height, 2), "direction_deg": round(direction)})
        frames.append({"time": to_iso(t), "points": frame_points})
    return {
        "generated_at": to_iso(generated_at),
        "valid_for_hours": WAVE_GRID_HOURS,
        "model": "calisurf-wave-grid-v1",
        "source": status,
        "units": {"height": "ft", "direction": "degrees true, waves come from this direction"},
        "bbox": {"lat_min": 30.5, "lat_max": 42.5, "lon_min": -125.5, "lon_max": -117.5},
        "frames": frames,
        "warnings": [status] if "fallback" in status or "offline" in status or "failed" in status else [],
    }


def fetch_wave_grid_24h(generated_at: dt.datetime) -> Dict[str, Any]:
    if os.environ.get("SURF_PIPELINE_OFFLINE") == "1":
        return synthetic_wave_grid(generated_at, "wave_grid:offline_synthetic")

    grid = california_wave_grid_points()
    if not grid:
        return synthetic_wave_grid(generated_at, "wave_grid:no_points_fallback")

    base = next_utc_hour(generated_at)
    frame_map: Dict[str, List[Dict[str, Any]]] = {
        to_iso(base + dt.timedelta(hours=h)): [] for h in range(0, WAVE_GRID_HOURS + 1)
    }
    warnings: List[str] = []

    for batch in chunks(grid, OPEN_METEO_BATCH_SIZE):
        lats = ",".join(f"{p['lat']:.4f}" for p in batch)
        lons = ",".join(f"{p['lon']:.4f}" for p in batch)
        params = {
            "latitude": lats,
            "longitude": lons,
            "hourly": "wave_height,wave_direction,swell_wave_height,swell_wave_direction",
            "forecast_hours": str(WAVE_GRID_HOURS + 1),
            "length_unit": "imperial",
            "timezone": "GMT",
            "cell_selection": "sea",
        }
        try:
            payload = safe_get(OPEN_METEO_MARINE_API, params=params, timeout=40).json()
            items = normalise_open_meteo_payload(payload)
            for source_point, item in zip(batch, items):
                hourly = item.get("hourly") or {}
                times = hourly.get("time") or []
                for i, raw_time in enumerate(times[: WAVE_GRID_HOURS + 1]):
                    try:
                        time_key = to_iso(parse_iso_utc(raw_time))
                        # Align to expected keys; if Open-Meteo starts at current hour this should match.
                        if time_key not in frame_map:
                            continue
                        combined_h = num_or_none(hourly, "wave_height", i)
                        swell_h = num_or_none(hourly, "swell_wave_height", i)
                        h = swell_h if swell_h is not None else combined_h
                        d = num_or_none(hourly, "swell_wave_direction", i)
                        if d is None:
                            d = num_or_none(hourly, "wave_direction", i)
                        if h is None:
                            continue
                        frame_map[time_key].append({
                            "lat": source_point["lat"],
                            "lon": source_point["lon"],
                            "height_ft": round(float(h), 2),
                            "direction_deg": round(float(d)) if d is not None else None,
                        })
                    except Exception:
                        continue
        except Exception as exc:
            warnings.append(f"wave_grid_batch_failed:{type(exc).__name__}")

    frames = [{"time": t, "points": pts} for t, pts in frame_map.items() if pts]
    if not frames or sum(len(f["points"]) for f in frames) < 12:
        return synthetic_wave_grid(generated_at, "wave_grid:openmeteo_failed_fallback")
    return {
        "generated_at": to_iso(generated_at),
        "valid_for_hours": WAVE_GRID_HOURS,
        "model": "calisurf-wave-grid-v1",
        "source": "Open-Meteo Marine API best-match wave model grid; drawn client-side as semitransparent wave-height colorization",
        "units": {"height": "ft", "direction": "degrees true, waves come from this direction"},
        "bbox": {"lat_min": 30.5, "lat_max": 42.5, "lon_min": -125.5, "lon_max": -117.5},
        "frames": frames,
        "warnings": warnings,
    }

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spots", type=Path, default=SPOTS_PATH)
    parser.add_argument("--out", type=Path, default=OUT_PATH)
    parser.add_argument("--wave-grid-out", type=Path, default=WAVE_GRID_OUT_PATH)
    parser.add_argument("--limit", type=int, default=0, help="Optional limit for testing")
    args = parser.parse_args()

    if not args.spots.exists():
        raise SystemExit(f"Missing {args.spots}. Run scripts/build_spots_json.py first.")
    spots = json.loads(args.spots.read_text())
    active_spots = [s for s in spots if s.get("active", True)]
    if args.limit:
        active_spots = active_spots[: args.limit]

    generated_at = now_utc()
    print(f"Fetching batched model guidance for {len(active_spots)} active spots...")
    fetch_open_meteo_models(active_spots)
    if MODEL_FETCH_WARNINGS:
        print("Model fetch warnings:", "; ".join(MODEL_FETCH_WARNINGS[:8]))

    forecasts: Dict[str, Any] = {}
    all_warnings: List[str] = list(MODEL_FETCH_WARNINGS)
    for i, spot in enumerate(active_spots, start=1):
        print(f"[{i}/{len(active_spots)}] {spot['name']}")
        try:
            forecast = build_forecast_for_spot(spot, generated_at)
        except Exception as exc:
            status = f"spot_pipeline_failed:{type(exc).__name__}:{exc}"
            all_warnings.append(status)
            forecast = build_last_resort_forecast(spot, generated_at, status)
        forecasts[spot["id"]] = forecast
        all_warnings.extend(forecast.get("warnings", []))

    print("Building 24-hour regional wave animation grid...")
    wave_grid_payload = fetch_wave_grid_24h(generated_at)
    args.wave_grid_out.parent.mkdir(parents=True, exist_ok=True)
    args.wave_grid_out.write_text(json.dumps(wave_grid_payload, indent=2) + "\n", encoding="utf-8")

    payload = {
        "generated_at": to_iso(generated_at),
        "valid_for_hours": FORECAST_HOURS,
        "model": "calisurf-west-coast-model-v1",
        "display_name": "CaliSurf Light",
        "subtitle": "west coast model V1",
        "units": {"height": "ft", "wind": "kt", "tide": "ft MLLW"},
        "sources": {
            "waves_forecast": "Open-Meteo Marine API best-match wave model guidance",
            "waves_observed": "NDBC realtime flat files and CDIP stations mirrored through NDBC when available",
            "wind_forecast": "Open-Meteo Weather Forecast API best-match 10 m wind guidance",
            "tides": "NOAA CO-OPS predictions",
            "bathymetry": "empirical California shelf/canyon/reef exposure coefficients in spots.json; NCEI CRM/ETOPO raster sampler remains the next precision upgrade",
            "wave_grid_layer": "public/data/wave_grid_24h.json generated from Open-Meteo Marine API wave_height/wave_direction over a reduced California offshore grid",
        },
        "wave_grid": {
            "file": "wave_grid_24h.json",
            "frame_count": len(wave_grid_payload.get("frames", [])),
            "source": wave_grid_payload.get("source"),
            "warnings": wave_grid_payload.get("warnings", []),
        },
        "data_status": {
            "forecast_count": len(forecasts),
            "warning_count": len(all_warnings),
            "warnings_sample": all_warnings[:80],
            "openmeteo_marine_spots": len(MARINE_BY_SPOT_ID),
            "openmeteo_wind_spots": len(WIND_BY_SPOT_ID),
        },
        "forecasts": forecasts,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(forecasts)} forecasts to {args.out}")
    print(f"Wrote {len(wave_grid_payload.get('frames', []))} wave-grid frames to {args.wave_grid_out}")


if __name__ == "__main__":
    main()
