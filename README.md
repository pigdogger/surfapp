# CaliSurf Light

**west coast model V2.0**

Static Netlify surf app + GitHub Actions forecast pipeline + Supabase-ready admin backend.


## V2.0 visual/admin/mobile hotfix

This update addresses the post-deploy issues visible on mobile and desktop:

- Replaces the orb-style wave layer with a smoother raster/cell-based semi-transparent wave field.
- Makes the wind visualization coastal/hyperlocal by limiting particles to the California coastal corridor and interpolating nearby wind-grid points instead of painting the entire continent.
- Selecting a spot on the map now highlights and centers the matching spot row inside the spot list without scrolling the whole page.
- Makes mobile forecast/detail typography leaner and smaller by default.
- Makes the 5-day forecast explicitly horizontal-scroll on mobile, while widening desktop day columns so surf heights stay on one line.
- Pulls raw GitHub `site_config.json` in addition to the Netlify copy so forecast-action updates to settings can be seen without a Netlify rebuild.
- GitHub Actions now writes the public Supabase URL + publishable key into `site_config.json` when `SUPABASE_URL` and `SUPABASE_ANON_KEY` secrets exist. The service-role key is never written to the frontend.

## What this update fixes

- Stops mobile page jumping when region chips, map spots, or spot-list rows are selected.
- Keeps spot highlighting and map panning/centering, but does not auto-scroll the page.
- Makes the mobile map a widescreen/banner map above the spot list.
- Makes the logo larger.
- Adds mobile forecast detail scaling in the admin UI.
- Adds visible animated wave-height pulsing over the Esri Ocean Basemap.
- Adds `public/data/wind_grid_latest.json` and an animated Windy/MyRadar-style wind particle layer.
- Puts the spot-color selector on its own left-aligned row above the wave/wind layer controls.
- Adds a Wind direction checkbox and wind pause/play button.
- Makes the 5-day forecast horizontally scrollable on mobile and wider on desktop so wave heights stay on one line.
- Changes the snapshot card to **39 hour snapshots**.
- Colors snapshot wind green for low/offshore/clean wind and yellow for higher/onshore wind.
- Adds a small solid color dot to each spot row matching the active marker-color scheme.
- Makes map dots solid color with no white outline or shiny fill; selected dots keep a halo/light effect.
- Shows all active surf spots on the map even when a region is selected; spots outside the selected region are dim/grey but still clickable.
- Adds Supabase-ready admin auth, editable spots, live aesthetic settings, RLS schema, and GitHub Actions Supabase spot ingestion.

## Upload steps

Unzip this package and upload the **contents inside** the folder to GitHub, not the folder itself. Commit, then run:

```text
Actions → Update surf forecasts → Run workflow
```

Trigger a Netlify deploy if it does not redeploy automatically, then hard-refresh the app.

## Supabase setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL Editor.
3. Create the auth user `admin@calisurf.com`.
4. Insert that auth user's UUID into `admin_profiles` using the commented SQL at the bottom of `supabase/schema.sql`.
5. Add GitHub Actions secrets:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

6. Run the forecast workflow once. It will write the public Supabase URL + publishable key into `public/data/site_config.json` automatically. Manual fallback: put your public publishable key into `public/data/site_config.json`:

```json
"supabase": {
  "enabled": true,
  "url": "https://YOUR_PROJECT.supabase.co",
  "anon_key": "YOUR_PUBLIC_ANON_KEY"
}
```

Once configured, admin changes to GPS, spot names, active/hidden state, marker size, opacity, mobile scaling, corner radius, and other settings publish through Supabase instead of GitHub uploads. GitHub Actions reads the Supabase spots on the next model run.

## Model note

This version includes working JSON-based wave and wind visual layers with a smoother wave raster and coastal-corridor wind particles. The current production-safe gateway uses Open-Meteo model APIs plus existing NDBC/CDIP and NOAA CO-OPS ingestion. The direct NOAA HRRR/RAP/GFS/GFS-Wave GRIB2 implementation is still the next deeper model upgrade; the app and pipeline are structured so only derived JSON goes to the frontend.
