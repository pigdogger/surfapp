# CaliSurf Light V2.7

Mobile/timeline/nearshore visual refinement update.

## Changes

- Compresses the mobile wind/tide timeline bar.
- Makes the mobile map a little larger when open.
- Makes minimized map close completely instead of leaving a strip visible.
- Slows the hourly wind timeline.
- Updates nearshore wind arrows every hour using the selected timeline hour.
- Draws conventional wind arrows (`-->`) instead of the old spark shape.
- Scales arrow length by wind speed; winds below ~2 kt are dots.
- Draws arrows in the direction air is moving, not the direction it comes from.
- Adds small tide y-axis values to the timeline.
- Shows sunrise/sunset labels on the mobile timeline and improves local time handling.
- Shrinks/repositions the spot-quality legend so it does not cover map controls.
- Replaces the old wave grid/orb look with an empirical nearshore wave band based on spot forecasts and coast-following interpolation.
- Stops wave animation work entirely when the wave layer is off.

## Install

Upload the contents of this folder to the GitHub repo root, commit, run the forecast workflow, then trigger a Netlify clear-cache deploy.

Open with a cache-busting URL:

```text
https://calisurf.netlify.app/?v=27
```

This package intentionally leaves existing `public/data/*` files alone when uploaded manually; do not overwrite your Supabase-enabled `site_config.json` unless you mean to.
