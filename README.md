# CaliSurf Light

**west coast model V1**

A beginner-friendly, deployable California surf forecast app built from `california_surf_spots_full.csv`.

It includes:

- Public forecast page: `public/index.html`
- Admin/aesthetic console: `public/admin.html`
- PWA install support: `manifest.webmanifest` + `service-worker.js`
- Custom logo/favicons/app icons from the supplied surfer/Vitruvian-style image
- Python forecast pipeline: `scripts/run_forecast_pipeline.py`
- GitHub Actions daily update workflow
- Netlify static hosting support

---

## PWA / Add to Home Screen

The app is installable as **CaliSurf Light**.

Files added:

```text
public/manifest.webmanifest
public/service-worker.js
public/assets/icons/favicon.ico
public/assets/icons/apple-touch-icon.png
public/assets/icons/icon-192.png
public/assets/icons/icon-512.png
public/assets/icons/maskable-192.png
public/assets/icons/maskable-512.png
```

The service worker caches the app shell and uses network-first behavior for forecast JSON so the app can load quickly while still updating model data.

When a new service worker is available, the public page shows:

```text
Update available → Download update
```

Tapping it activates the new version and reloads the app.

---

## Admin login

Open:

```text
/admin.html
```

Use:

```text
email: admin@calisurf.com
password: bonitaindo26
```

This is a static local gate, not true secure server authentication. For a real private admin later, use Supabase, Firebase Auth, Netlify Identity, or another backend.

---

## Model sources

West coast model V1 uses:

- Open-Meteo Marine API for wave forecast guidance.
- Open-Meteo Weather API for real wind forecasts.
- NDBC/CDIP realtime buoy observations as an observed anchor.
- NOAA CO-OPS tide predictions.
- Empirical California shelf/canyon/reef exposure coefficients in `spots.json`.

The browser does not run the model. GitHub Actions runs the Python pipeline and writes:

```text
public/data/latest_forecasts.json
```

---

## Deploy / update steps

1. Upload the project contents to GitHub.
2. Let Netlify redeploy because frontend files changed.
3. Go to **Actions → Update surf forecasts → Run workflow**.
4. Wait for the workflow to turn green.
5. Open your site and hard refresh.
6. On mobile, use the install button if shown, or use browser Share → Add to Home Screen.

The included `site_config.json` points forecast data to:

```text
https://raw.githubusercontent.com/pigdogger/surfapp/main/public/data
```

That lets the Netlify frontend receive updated forecast JSON from GitHub without requiring a Netlify rebuild every forecast run.

---

## Local test

```bash
python -m pip install -r requirements.txt
python scripts/build_spots_json.py
python scripts/run_forecast_pipeline.py
python -m http.server 8888 -d public
```

Open:

```text
http://localhost:8888
```

Offline model test:

```bash
SURF_PIPELINE_OFFLINE=1 python scripts/run_forecast_pipeline.py
```

---

## Netlify settings

```text
Build command: echo 'Static site: no build required'
Publish directory: public
```

`netlify.toml` also sets service-worker and manifest cache headers.
