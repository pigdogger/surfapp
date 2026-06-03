# California Surf Light

A beginner-friendly, deployable surf forecast app built from `california_surf_spots_full.csv`.

It has:

- A public surf forecast page at `public/index.html`
- A private/local admin controls page at `public/admin.html`
- A Python data pipeline that generates static JSON
- A GitHub Actions workflow that runs every day around 2 AM Pacific
- No live backend required for Stage 1

The app is intentionally lightweight:

```text
CSV surf spots + public ocean data
        ↓
GitHub Actions runs Python once per day
        ↓
public/data/latest_forecasts.json is updated
        ↓
Netlify static page fetches JSON in the browser
```

Your laptop does **not** need to stay on. GitHub Actions does the daily work online.

---

## File tree

```text
.
├── california_surf_spots_full.csv
├── netlify.toml
├── requirements.txt
├── README.md
├── public
│   ├── index.html
│   ├── admin.html
│   ├── styles.css
│   ├── app.js
│   ├── admin.js
│   └── data
│       ├── spots.json
│       ├── latest_forecasts.json
│       └── site_config.json
├── scripts
│   ├── build_spots_json.py
│   ├── run_forecast_pipeline.py
│   ├── bathymetry_features.py
│   └── train_ml_calibration.py
└── .github
    └── workflows
        └── update_forecasts.yml
```

---

## What each part does

### `public/index.html`

The public surf forecast page. It loads:

- `public/data/spots.json`
- `public/data/latest_forecasts.json`
- `public/data/site_config.json`

It shows:

- Esri Ocean Basemap
- all California surf spots as markers
- a south-to-north spot list
- surf height, swell, wind, tide, sunrise/sunset, confidence, model notes, and warnings
- a lightweight bathymetry visual layer

### `public/admin.html`

A local admin/control page. It lets you change:

- theme colors
- marker size
- typography size
- compact/full layout
- visible forecast cards
- swell arrows
- wind arrows
- bathymetry toggle
- hidden/visible surf spots
- locally added spots

In Stage 1 this saves to browser `localStorage` and can export JSON. It does **not** permanently edit the GitHub repo by itself.

For real multi-user editing later, add a write backend such as Supabase, Firebase, or a GitHub write integration.

### `scripts/build_spots_json.py`

Reads `california_surf_spots_full.csv` and writes `public/data/spots.json`.

It adds:

- stable spot IDs
- region names
- active flags
- nearest tide station candidates
- nearest buoy candidates
- placeholder bathymetry features
- directional exposure tables

### `scripts/run_forecast_pipeline.py`

Runs the daily forecast pipeline.

It tries to use public data:

- NDBC realtime buoy files
- CDIP stations mirrored through NDBC when available
- NOAA CO-OPS tide predictions
- optional future GFS-Wave hook

If a source fails, the script still writes a forecast using fallback values and adds warnings in `data_status`.

### `scripts/bathymetry_features.py`

Stage 2-ready bathymetry feature generator.

Right now it creates placeholder values with the correct shape:

- `beach_orientation_deg`
- `slope_5_20m`
- `canyon_multiplier`
- `reef_multiplier`
- `shadowing_multiplier`
- `exposure_by_direction`

Later, replace these placeholder values with real values sampled from NOAA/NCEI Coastal Relief Model or ETOPO rasters.

### `scripts/train_ml_calibration.py`

Stage 3 placeholder.

It trains a `RandomForestRegressor` using surf observations. This is a bias-correction layer, not the whole wave model.

---

## Local test on your computer

Open Terminal in the project folder.

Install Python packages:

```bash
python -m pip install -r requirements.txt
```

Build spots from the CSV:

```bash
python scripts/build_spots_json.py
```

Run the forecast pipeline:

```bash
python scripts/run_forecast_pipeline.py
```

If you want to test without internet:

```bash
SURF_PIPELINE_OFFLINE=1 python scripts/run_forecast_pipeline.py
```

Start a local web server:

```bash
python -m http.server 8888 -d public
```

Then open:

```text
http://localhost:8888
```

Admin page:

```text
http://localhost:8888/admin.html
```

---

## Deploy to GitHub

1. Create a new GitHub repo.
2. Upload this whole folder.
3. Make sure `california_surf_spots_full.csv` is in the repo root.
4. Go to the repo's **Actions** tab.
5. Enable workflows if GitHub asks.
6. Open the `Update surf forecasts` workflow.
7. Click **Run workflow** once manually.
8. Confirm that these files update:

```text
public/data/spots.json
public/data/latest_forecasts.json
```

The workflow also runs automatically every day at `09:17 UTC`, which is about `2:17 AM Pacific` during daylight time.

---

## Deploy the public page to Netlify

1. Sign in to Netlify.
2. Choose **Add new site**.
3. Connect your GitHub repo.
4. Use these build settings:

```text
Build command: echo 'Static site: no build required'
Publish directory: public
```

The included `netlify.toml` already sets these.

---

## Avoiding a Netlify rebuild every forecast run

There are two modes.

### Simple mode

Keep `site_config.json` like this:

```json
{
  "data_base_url": "./data"
}
```

This means Netlify serves the data files from the deployed site. It is the simplest setup, but Netlify may redeploy when GitHub Actions commits new JSON.

### No-rebuild data mode

Set `public/data/site_config.json` to use raw GitHub data:

```json
{
  "data_base_url": "https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/public/data"
}
```

Then the Netlify page fetches the latest JSON directly from GitHub on every page load. The page code can stay deployed while the data changes in GitHub.

The workflow commit message includes `[skip netlify]`. If your Netlify site still rebuilds on those commits, use Netlify's deploy settings to ignore data-only commits or turn off automatic deploys and redeploy only when frontend files change.

---

## How the surf model works

This is the simple Stage 1 formula:

```text
public wave data
× directional exposure
× bathymetry multiplier
× period bonus
× tide modifier
= estimated surf face height
```

Then the app scores wind:

```text
offshore / light wind = cleaner
onshore / strong wind = worse
```

Then it creates:

- surf height range
- rating
- confidence
- best window
- data warnings

This is not a professional-grade nearshore numerical wave model yet. It is a practical, lightweight public-data baseline.

---

## Stage 2: real bathymetry upgrade

Use NOAA/NCEI Coastal Relief Model or ETOPO rasters.

The goal is to fill these fields in `spots.json` with real values:

```json
"bathymetry": {
  "slope_5_20m": 0.045,
  "canyon_multiplier": 1.18,
  "reef_multiplier": 1.05,
  "shadowing_multiplier": 0.92
}
```

Beginner version:

1. Pick a small region, like San Diego.
2. Download only that bathymetry raster.
3. For each spot, sample depths offshore.
4. Estimate the slope between 5 m and 20 m depth.
5. Save the results into `spots.json`.

Advanced version:

1. Build directional exposure tables from bathymetry.
2. Add island/headland shadowing.
3. Add canyon focusing.
4. Compare against nearshore buoys or camera observations.

---

## Stage 3: ML calibration

Once you have observed surf heights, train a correction model.

Example input row:

```csv
offshore_wave_height,offshore_period,offshore_direction,wind_speed,wind_direction,tide_level,tide_trend,beach_orientation_deg,slope_5_20m,canyon_multiplier,reef_multiplier,shadowing_multiplier,directional_exposure,observed_surf_height_ft
4.2,14,285,6,80,2.3,1,260,0.045,1.1,1.0,0.95,1.05,5.0
```

Run:

```bash
python scripts/train_ml_calibration.py --training-data data/training_observations.csv --out models/surf_rf.joblib
```

Use ML to correct bias, not to replace ocean physics.

---

## Common beginner problems

### The map loads but forecasts are blank

Check that this file exists:

```text
public/data/latest_forecasts.json
```

Then run:

```bash
python scripts/run_forecast_pipeline.py
```

### GitHub Actions fails to push

Check that the workflow has write permission:

```yaml
permissions:
  contents: write
```

Also check your repo settings under:

```text
Settings → Actions → General → Workflow permissions
```

Choose read/write permissions.

### NOAA source is down or times out

That is okay. The pipeline writes fallback forecasts and warnings instead of breaking the whole app.

### Admin changes disappeared

Stage 1 admin saves in the current browser only. To make a change permanent, export the JSON and commit it, or edit the CSV/spots files directly.
