#!/usr/bin/env python3
"""Optional NOAA/NCEP GFS-Wave / WaveWatch grid fetcher for CaliSurf Light.

This is intentionally separate from the default GitHub Action because direct GRIB2
parsing is heavier and more brittle than the production-safe JSON gateway. To use
it later, install eccodes/cfgrib/xarray in the workflow, set ENABLE_NOMADS_WAVE=1,
and wire this output into public/data/wave_grid_24h.json.

The intended workflow is:
  1. Request only HTSGW and wave direction fields over the West Coast bbox.
  2. Parse GRIB2 transiently in GitHub Actions.
  3. Write only the reduced JSON grid; never commit raw GRIB files.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import tempfile
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlencode

import requests

NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_wave.pl"


def latest_cycle(now: dt.datetime | None = None) -> str:
    now = (now or dt.datetime.utcnow()).replace(tzinfo=dt.timezone.utc)
    # Wait a few hours so the cycle likely exists.
    hour = max(0, ((now.hour - 5) // 6) * 6)
    return f"{hour:02d}"


def request_url(date: str, cycle: str, fhr: int, bbox: Dict[str, float]) -> str:
    # Product naming can change slightly by grid; this uses the common global 0p25 product.
    params = {
        "dir": f"/gfs.{date}/{cycle}/wave/gridded",
        "file": f"gfswave.t{cycle}z.global.0p25.f{fhr:03d}.grib2",
        "var_HTSGW": "on",
        "var_DIRPW": "on",
        "subregion": "",
        "leftlon": bbox["west"],
        "rightlon": bbox["east"],
        "toplat": bbox["north"],
        "bottomlat": bbox["south"],
    }
    return NOMADS_FILTER + "?" + urlencode(params)


def fetch_grib(url: str, out: Path) -> None:
    r = requests.get(url, timeout=60, headers={"User-Agent": "CaliSurf-Light/2.5"})
    r.raise_for_status()
    out.write_bytes(r.content)


def parse_grib_to_points(path: Path) -> List[Dict[str, Any]]:
    try:
        import xarray as xr  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("xarray/cfgrib/eccodes are required for direct NOAA GRIB parsing") from exc
    ds = xr.open_dataset(path, engine="cfgrib")
    # Variable names differ by GRIB template. Keep this intentionally defensive.
    height_name = next((n for n in ds.data_vars if n.lower() in {"swh", "htsgw", "significantheightofcombinedwindwavesandswell"}), None)
    dir_name = next((n for n in ds.data_vars if "dir" in n.lower()), None)
    if not height_name:
        raise RuntimeError(f"No significant wave height variable found in {list(ds.data_vars)}")
    lats = ds.latitude.values
    lons = ds.longitude.values
    hvals = ds[height_name].values
    dvals = ds[dir_name].values if dir_name else None
    points = []
    for yi, lat in enumerate(lats):
        for xi, lon in enumerate(lons):
            lon2 = float(lon)
            if lon2 > 180:
                lon2 -= 360
            h_m = float(hvals[yi][xi])
            if h_m != h_m:
                continue
            points.append({"lat": round(float(lat), 4), "lon": round(lon2, 4), "height_ft": round(h_m * 3.28084, 2), "direction_deg": round(float(dvals[yi][xi])) if dvals is not None else None})
    return points


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.datetime.utcnow().strftime("%Y%m%d"))
    ap.add_argument("--cycle", default=latest_cycle())
    ap.add_argument("--out", default="public/data/noaa_wavewatch_sample.json")
    ap.add_argument("--south", type=float, default=30.5)
    ap.add_argument("--north", type=float, default=42.5)
    ap.add_argument("--west", type=float, default=-126.5)
    ap.add_argument("--east", type=float, default=-116.0)
    ap.add_argument("--hours", type=int, default=24)
    args = ap.parse_args()
    bbox = {"south": args.south, "north": args.north, "west": args.west, "east": args.east}
    frames = []
    with tempfile.TemporaryDirectory() as tmp:
        for fhr in range(0, args.hours + 1, 3):
            path = Path(tmp) / f"wave_f{fhr:03d}.grib2"
            url = request_url(args.date, args.cycle, fhr, bbox)
            fetch_grib(url, path)
            points = parse_grib_to_points(path)
            valid = dt.datetime.strptime(args.date + args.cycle, "%Y%m%d%H").replace(tzinfo=dt.timezone.utc) + dt.timedelta(hours=fhr)
            frames.append({"time": valid.isoformat().replace("+00:00", "Z"), "points": points})
    payload = {"generated_at": dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z"), "source": "NOAA/NCEP GFS-Wave direct GRIB2", "frames": frames}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
