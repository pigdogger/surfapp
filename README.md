# CaliSurf Light — west coast model V1.2

Static California surf forecast app with a GitHub Actions forecast pipeline.

## What is new in this update

- Adds a semi-transparent **24-hour wave-height colorization layer** over the Esri Ocean Basemap.
- Adds animated wave frames from `public/data/wave_grid_24h.json`.
- Adds small swell-direction arrows inside the wave layer.
- Extends spot forecasts to **5 days** of 3-hourly model snapshots.
- Renames the hourly card to **30 hour snapshots**.
- Adds a 5-column **5 day forecast** card.
- Adds map marker color modes:
  - poor → fair/good rating
  - wave size
  - morning-good window
  - afternoon-good window
  - evening-good window
- Defaults to San Diego.
- Removes spot count from the public header.
- Removes bathy checkbox and map attribution text.
- Keeps Esri Ocean Basemap as the visual base map.
- Keeps PWA install/update support and the CaliSurf Light logo/favicon.

## Data files produced by GitHub Actions

The workflow now commits:

```text
public/data/spots.json
public/data/latest_forecasts.json
public/data/wave_grid_24h.json
public/data/site_config.json
```

`latest_forecasts.json` contains the spot-level forecast cards.

`wave_grid_24h.json` contains lightweight regional grid frames used by the animated map overlay. The browser does not parse GRIB and does not call model APIs directly.

## Model strategy

The app uses a two-level strategy:

1. **Spot model:** NDBC/CDIP observations, Open-Meteo marine/wind guidance, NOAA CO-OPS tides, and empirical spot exposure/bathymetry coefficients.
2. **Regional wave layer:** Open-Meteo Marine API wave-height and wave-direction fields on a reduced California offshore grid, exported as small JSON for browser animation.

Open-Meteo is used as the easiest reliable Stage 1/2 model gateway because it exposes wave variables such as wave height, direction, period, swell wave height/direction/period, secondary swell, and GFS Wave/ECMWF/DWD/Météo-France wave-model sources through JSON. The higher-control upgrade is direct NOAA NOMADS GFS-Wave GRIB2 retrieval for variables such as `HTSGW`, `DIRPW`, and `PERPW`, using `cfgrib` or `wgrib2`; that should be done server-side in GitHub Actions and only derived JSON should be committed.

## Source-code/modeling note for Ventusky/NREL-style maps

I did not find public source code for Ventusky’s sea-map renderer or the NREL Marine Energy Atlas viewer that can simply be copied into this project. Instead, this app reproduces the useful pattern: fetch/model wave fields server-side, reduce them to a mobile-sized grid, then render a semi-transparent canvas color layer with arrows over the existing map. That avoids scraping or depending on another site’s proprietary front-end.

## Admin aesthetic console

Open:

```text
/admin.html
```

Login:

```text
admin@calisurf.com
bonitaindo26
```

The static admin console can change marker size, marker color mode, corner radius, mobile buffer, wave-layer opacity, wave-layer arrows, card visibility, colors, layout, hidden spots, and local spot additions.

Important: this is still a local/static admin gate. It saves to browser `localStorage` or lets you download `site_config.json`. True public live editing later needs Supabase, Firebase, Netlify Identity, or GitHub write integration.

## Deploy/update steps

1. Upload/overwrite these files in GitHub.
2. Commit the change.
3. Netlify should redeploy because frontend files changed.
4. Run:

```text
Actions → Update surf forecasts → Run workflow
```

5. Confirm these files changed:

```text
public/data/latest_forecasts.json
public/data/wave_grid_24h.json
```

6. Open the site and hard refresh once.

If users have installed the PWA, they should see **Update available** when the new service worker is ready.

## Future direct-GRIB upgrade

For a production-grade version, keep this exact frontend JSON shape but replace the Open-Meteo wave grid generator with direct NOAA NOMADS GFS-Wave GRIB2 subset downloads:

- Bbox: ~30.5°N–42.5°N, 125.5°W–116.0°W.
- Variables: `HTSGW`, `DIRPW`, `PERPW`, plus swell partitions when needed.
- Parser: `cfgrib + xarray`, fallback `wgrib2`.
- Commit only reduced JSON, never raw GRIB.

