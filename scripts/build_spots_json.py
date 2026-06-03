#!/usr/bin/env python3
"""
build_spots_json.py

Reads california_surf_spots_full.csv and creates public/data/spots.json.

The CSV only needs: name,lat,lon
The generated JSON adds:
- stable slug ID
- south-to-north ordering
- broad California region
- active flag
- empirical bathymetry-ready features
- directional exposure table
- nearest public tide station and buoy candidates

Run:
    python scripts/build_spots_json.py
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from bathymetry_features import build_bathymetry_features_for_spot, infer_region

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "california_surf_spots_full.csv"
DEFAULT_OUT = ROOT / "public" / "data" / "spots.json"

# Small static station lists. They are intentionally kept human-readable so a
# beginner can edit/extend them without learning a database.
TIDE_STATIONS = [
    {"id": "9410170", "name": "San Diego", "lat": 32.714, "lon": -117.174},
    {"id": "9410230", "name": "La Jolla", "lat": 32.867, "lon": -117.257},
    {"id": "9410660", "name": "Los Angeles", "lat": 33.720, "lon": -118.272},
    {"id": "9410840", "name": "Santa Monica", "lat": 34.008, "lon": -118.500},
    {"id": "9411340", "name": "Santa Barbara", "lat": 34.405, "lon": -119.692},
    {"id": "9412110", "name": "Port San Luis", "lat": 35.177, "lon": -120.760},
    {"id": "9413450", "name": "Monterey", "lat": 36.608, "lon": -121.889},
    {"id": "9414290", "name": "San Francisco", "lat": 37.806, "lon": -122.466},
    {"id": "9415020", "name": "Point Reyes", "lat": 37.996, "lon": -122.976},
    {"id": "9418767", "name": "North Spit, Humboldt Bay", "lat": 40.767, "lon": -124.217},
    {"id": "9419750", "name": "Crescent City", "lat": 41.745, "lon": -124.184},
]

BUOY_STATIONS = [
    # NDBC/CDIP nearshore and offshore candidates commonly useful for California.
    # Some stations may be offline at any given time; the pipeline tries the nearest few.
    {"id": "46235", "name": "Imperial Beach Nearshore", "lat": 32.570, "lon": -117.169, "kind": "cdip_ndbc"},
    {"id": "46232", "name": "Point Loma South", "lat": 32.530, "lon": -117.421, "kind": "cdip_ndbc"},
    {"id": "46225", "name": "Torrey Pines Outer", "lat": 32.933, "lon": -117.390, "kind": "cdip_ndbc"},
    {"id": "46266", "name": "Del Mar Nearshore", "lat": 32.956, "lon": -117.279, "kind": "cdip_ndbc"},
    {"id": "46086", "name": "San Clemente Basin", "lat": 32.491, "lon": -118.034, "kind": "ndbc"},
    {"id": "46047", "name": "Tanner Bank", "lat": 32.399, "lon": -119.525, "kind": "ndbc"},
    {"id": "46221", "name": "Santa Monica Bay", "lat": 33.855, "lon": -118.633, "kind": "cdip_ndbc"},
    {"id": "46025", "name": "Santa Monica Basin", "lat": 33.749, "lon": -119.053, "kind": "ndbc"},
    {"id": "46053", "name": "East Santa Barbara", "lat": 34.241, "lon": -119.839, "kind": "ndbc"},
    {"id": "46217", "name": "Anacapa Passage", "lat": 34.167, "lon": -119.435, "kind": "cdip_ndbc"},
    {"id": "46218", "name": "Harvest", "lat": 34.452, "lon": -120.782, "kind": "cdip_ndbc"},
    {"id": "46011", "name": "Santa Maria", "lat": 34.936, "lon": -120.998, "kind": "ndbc"},
    {"id": "46215", "name": "Diablo Canyon", "lat": 35.205, "lon": -120.859, "kind": "cdip_ndbc"},
    {"id": "46028", "name": "Cape San Martin", "lat": 35.741, "lon": -121.884, "kind": "ndbc"},
    {"id": "46240", "name": "Monterey Bay West", "lat": 36.626, "lon": -122.027, "kind": "cdip_ndbc"},
    {"id": "46042", "name": "Monterey Bay", "lat": 36.785, "lon": -122.469, "kind": "ndbc"},
    {"id": "46012", "name": "Half Moon Bay", "lat": 37.363, "lon": -122.881, "kind": "ndbc"},
    {"id": "46237", "name": "San Francisco Bar", "lat": 37.788, "lon": -122.634, "kind": "cdip_ndbc"},
    {"id": "46026", "name": "San Francisco", "lat": 37.759, "lon": -122.839, "kind": "ndbc"},
    {"id": "46013", "name": "Bodega Bay", "lat": 38.235, "lon": -123.317, "kind": "ndbc"},
    {"id": "46014", "name": "Point Arena", "lat": 39.225, "lon": -123.974, "kind": "ndbc"},
    {"id": "46022", "name": "Eel River", "lat": 40.715, "lon": -124.540, "kind": "ndbc"},
    {"id": "46244", "name": "Humboldt Bay North Spit", "lat": 40.896, "lon": -124.357, "kind": "cdip_ndbc"},
    {"id": "46027", "name": "St Georges", "lat": 41.840, "lon": -124.382, "kind": "ndbc"},
]


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"(^-|-$)", "", value)
    return value or "spot"


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest(items: Iterable[dict], lat: float, lon: float, n: int = 1) -> List[dict]:
    ranked = []
    for item in items:
        d = haversine_km(lat, lon, float(item["lat"]), float(item["lon"]))
        copy = dict(item)
        copy["distance_km"] = round(d, 1)
        ranked.append(copy)
    return sorted(ranked, key=lambda x: x["distance_km"])[:n]


def load_existing(path: Path) -> Dict[str, dict]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return {row["id"]: row for row in data if "id" in row}
    except Exception:
        return {}


def build_spots(csv_path: Path, existing_path: Path) -> List[dict]:
    existing = load_existing(existing_path)
    used_ids: set[str] = set()
    spots: List[dict] = []

    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        required = {"name", "lat", "lon"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"CSV is missing required columns: {sorted(missing)}")

        for row in reader:
            name = row["name"].strip()
            lat = float(row["lat"])
            lon = float(row["lon"])
            base_id = slugify(name)
            spot_id = base_id
            counter = 2
            while spot_id in used_ids:
                spot_id = f"{base_id}-{counter}"
                counter += 1
            used_ids.add(spot_id)

            previous = existing.get(spot_id, {})
            bathy_features = build_bathymetry_features_for_spot(name, lat, lon)
            tide_station = nearest(TIDE_STATIONS, lat, lon, 1)[0]
            buoy_candidates = nearest(BUOY_STATIONS, lat, lon, 5)

            previous_bathy = previous.get("bathymetry") or {}
            previous_source = str(previous_bathy.get("source", ""))
            keep_previous_bathy = bool(previous_bathy) and not previous_source.startswith("placeholder")
            bathymetry = previous_bathy if keep_previous_bathy else bathy_features["bathymetry"]
            exposure = previous.get("exposure_by_direction") if keep_previous_bathy else bathy_features["exposure_by_direction"]

            spot = {
                "id": spot_id,
                "name": name,
                "lat": lat,
                "lon": lon,
                "region": previous.get("region") or infer_region(lat, lon),
                "active": previous.get("active", True),
                "beach_orientation_deg": previous.get("beach_orientation_deg", bathy_features["beach_orientation_deg"]),
                "bathymetry": bathymetry,
                "exposure_by_direction": exposure,
                "public_data": {
                    "nearest_tide_station": previous.get("public_data", {}).get("nearest_tide_station", tide_station),
                    "buoy_candidates": previous.get("public_data", {}).get("buoy_candidates", buoy_candidates),
                },
                "notes": previous.get("notes", ""),
            }
            spots.append(spot)

    # Required: organize spots south-to-north by latitude.
    spots.sort(key=lambda s: (s["lat"], s["name"]))
    return spots


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    spots = build_spots(args.csv, args.out)
    args.out.write_text(json.dumps(spots, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(spots)} spots to {args.out}")


if __name__ == "__main__":
    main()
