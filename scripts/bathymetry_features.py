#!/usr/bin/env python3
"""
bathymetry_features.py

Stage 2-ready bathymetry feature helpers for the California surf widget.

This first implementation does NOT download or process large bathymetry rasters.
Instead, it creates a consistent data structure that can be replaced later with
real values derived from NOAA/NCEI Coastal Relief Model, ETOPO, BlueTopo, CDIP
nearshore points, or other open bathymetry products.

Why this matters:
- Surf height at a beach is not just offshore swell height.
- Directional exposure, submarine canyons, reefs, and shelf slope change how
  swell refracts, focuses, shadows, and breaks.
- The widget only needs tiny per-spot numbers, not a full bathymetry raster.

Later upgrade path:
1. Download NCEI/NOAA CRM or ETOPO raster covering California.
2. Sample depth contours around each spot.
3. Estimate beach orientation from shoreline geometry.
4. Ray-trace or approximate exposure from swell direction bins.
5. Save the results back into public/data/spots.json.
"""

from __future__ import annotations

import math
import re
from typing import Dict, Iterable, Mapping, Optional

DIRECTION_BINS = list(range(0, 360, 15))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def angle_diff_deg(a: float, b: float) -> float:
    """Smallest absolute difference between two bearings."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


def infer_region(lat: float, lon: float) -> str:
    """Simple south-to-north California region grouping."""
    if lat < 33.75:
        return "San Diego"
    if lat < 34.35:
        return "Orange / LA"
    if lat < 35.40:
        return "Ventura / Santa Barbara"
    if lat < 36.30:
        return "Central Coast"
    if lat < 37.10:
        return "Monterey Bay"
    if lat < 38.40:
        return "San Francisco / Marin"
    if lat < 40.40:
        return "Mendocino"
    return "Humboldt / Del Norte"


def infer_beach_orientation_deg(lat: float, lon: float, name: str = "") -> int:
    """
    Approximate incoming swell direction normal to the beach.

    This is intentionally simple. A real version should derive this from a
    shoreline vector or from hand-tuned local knowledge.
    """
    lower = name.lower()

    # A few named overrides where local geometry is very important.
    overrides = {
        "blacks": 255,
        "scripps": 260,
        "la jolla": 265,
        "windansea": 260,
        "sunset cliffs": 255,
        "coronado": 240,
        "tijuana": 235,
        "trestles": 215,
        "san onofre": 215,
        "rincon": 215,
        "ventura": 230,
        "malibu": 215,
        "steamer lane": 240,
        "mavericks": 260,
        "ocean beach": 270,
        "linda mar": 250,
        "monterey": 245,
        "moss landing": 255,
        "fort point": 250,
    }
    for token, value in overrides.items():
        if token in lower:
            return value

    # Broad regional defaults.
    if lat < 33.0:
        return 245
    if lat < 33.8:
        return 255
    if lat < 34.4:
        return 225
    if lat < 35.5:
        return 240
    if lat < 37.0:
        return 255
    if lat < 38.2:
        return 260
    return 270


def infer_bathymetry_multipliers(name: str, lat: float, lon: float) -> Dict[str, Optional[float]]:
    """Hand-set placeholder bathymetry multipliers ready for real raster values."""
    lower = name.lower()
    canyon = 1.0
    reef = 1.0
    shadow = 1.0
    slope = 0.035

    # Known or likely canyon/focus areas. These are placeholders, not surveyed values.
    if any(token in lower for token in ["blacks", "scripps", "la jolla"]):
        canyon = 1.18
        slope = 0.055
    if any(token in lower for token in ["moss landing", "monterey", "marina", "seaside"]):
        canyon = 1.12
        slope = 0.050
    if any(token in lower for token in ["mavericks", "point", "reef", "lane", "windansea", "rincon"]):
        reef = 1.08
        slope = max(slope, 0.045)
    if any(token in lower for token in ["santa cruz", "cowell", "capitola", "malibu", "san onofre", "doheny"]):
        shadow = 0.82
    if lat > 39.0:
        slope = 0.042

    return {
        "slope_5_20m": round(slope, 4),
        "canyon_multiplier": round(canyon, 3),
        "reef_multiplier": round(reef, 3),
        "shadowing_multiplier": round(shadow, 3),
        "source": "placeholder_v1_ready_for_ncei_crm",
    }


def build_directional_exposure(
    beach_orientation_deg: Optional[float],
    bathymetry: Optional[Mapping[str, float]] = None,
    bins: Iterable[int] = DIRECTION_BINS,
) -> Dict[str, float]:
    """
    Build a simple directional exposure table.

    A swell from the beach-normal direction gets the highest exposure. Swell more
    than ~100 degrees away is mostly shadowed. Longer-term, replace this with
    ray-tracing or SWAN output over real bathymetry.
    """
    if beach_orientation_deg is None:
        beach_orientation_deg = 260
    bathymetry = bathymetry or {}
    canyon = float(bathymetry.get("canyon_multiplier", 1.0) or 1.0)
    reef = float(bathymetry.get("reef_multiplier", 1.0) or 1.0)
    shadow = float(bathymetry.get("shadowing_multiplier", 1.0) or 1.0)

    exposure: Dict[str, float] = {}
    for direction in bins:
        diff = angle_diff_deg(direction, beach_orientation_deg)
        # Cosine lobe centered on beach-normal direction.
        base = math.cos(math.radians(diff))
        if base < 0:
            base = 0.0
        value = 0.15 + 0.95 * (base**1.6)
        value *= canyon * reef * shadow
        exposure[str(direction)] = round(clamp(value, 0.05, 1.65), 2)
    return exposure


def build_bathymetry_features_for_spot(name: str, lat: float, lon: float) -> Dict:
    orientation = infer_beach_orientation_deg(lat, lon, name)
    bathy = infer_bathymetry_multipliers(name, lat, lon)
    exposure = build_directional_exposure(orientation, bathy)
    return {
        "beach_orientation_deg": orientation,
        "bathymetry": bathy,
        "exposure_by_direction": exposure,
    }


if __name__ == "__main__":
    # Tiny manual smoke test.
    for name, lat, lon in [
        ("Blacks", 32.8919, -117.2550),
        ("Ocean Beach", 37.759, -122.511),
        ("Mavericks", 37.493, -122.500),
    ]:
        print(name, build_bathymetry_features_for_spot(name, lat, lon))
