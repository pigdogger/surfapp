#!/usr/bin/env python3
"""
train_ml_calibration.py

Stage 3 placeholder: train an ML bias-correction layer.

This is NOT the whole surf model. The ocean physics still come from public wave
models, buoys, tides, and bathymetry. ML should correct systematic local bias:
for example, "this spot usually undercalls long-period SSW swell" or "this reef
needs a lower tide than the basic model assumes."

Expected training CSV columns:
- offshore_wave_height
- offshore_period
- offshore_direction
- wind_speed
- wind_direction
- tide_level
- tide_trend
- beach_orientation_deg
- slope_5_20m
- canyon_multiplier
- reef_multiplier
- shadowing_multiplier
- directional_exposure
- observed_surf_height_ft

Run later:
    python scripts/train_ml_calibration.py --training-data data/training_observations.csv --out models/surf_rf.joblib
"""

from __future__ import annotations

import argparse
from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

FEATURES = [
    "offshore_wave_height",
    "offshore_period",
    "offshore_direction",
    "wind_speed",
    "wind_direction",
    "tide_level",
    "tide_trend",
    "beach_orientation_deg",
    "slope_5_20m",
    "canyon_multiplier",
    "reef_multiplier",
    "shadowing_multiplier",
    "directional_exposure",
]
TARGET = "observed_surf_height_ft"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--training-data", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("models/surf_rf.joblib"))
    args = parser.parse_args()

    df = pd.read_csv(args.training_data)
    missing = [c for c in FEATURES + [TARGET] if c not in df.columns]
    if missing:
        raise SystemExit(f"Training file is missing columns: {missing}")

    # Convert tide trend labels into simple numeric values for the starter model.
    trend_map = {"falling": -1, "unknown": 0, "rising": 1}
    df["tide_trend"] = df["tide_trend"].map(trend_map).fillna(0)

    X = df[FEATURES]
    y = df[TARGET]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    model = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("rf", RandomForestRegressor(n_estimators=300, min_samples_leaf=4, random_state=42, n_jobs=-1)),
    ])
    model.fit(X_train, y_train)
    preds = model.predict(X_test)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": model, "features": FEATURES, "target": TARGET}, args.out)

    print(f"Saved model to {args.out}")
    print(f"MAE: {mean_absolute_error(y_test, preds):.2f} ft")
    print(f"R^2: {r2_score(y_test, preds):.3f}")
    print("Reminder: this model is a bias-correction layer, not a replacement for wave physics.")


if __name__ == "__main__":
    main()
