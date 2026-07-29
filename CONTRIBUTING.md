# Contributing to Orbit

Thanks for your interest in improving Orbit! This is a small, dependency-free
frontend project, so getting started is quick.

## Getting set up

```bash
git clone https://github.com/darkflib/orbit.git
cd orbit
npm start          # serves at http://localhost:8080
```

There is no build step and there are no npm dependencies — the app loads
three.js and satellite.js from a CDN via an import map. You just need Node 18+
to run the bundled static server (`serve.mjs`), or any static file server
(`python3 -m http.server`, `npx serve`, etc.). The app must be served over
HTTP, not opened via `file://`, because it uses ES module workers and `fetch`.

## Project layout

| Path | What it does |
|------|--------------|
| `index.html` / `styles/` | Page shell and UI styling |
| `src/main.js` | Simulation clock, render loop, UI wiring |
| `src/scene.js` | three.js renderer, camera, Earth, atmosphere, stars |
| `src/satellites.js` | Point cloud, selection, orbit/track/footprint overlays |
| `src/worker.js` | SGP4 propagation Web Worker |
| `src/gp.js` | CelesTrak OMM (GP) fetching, parsing, caching |
| `src/utils.js` | Coordinate/time/formatting helpers |
| `src/constants.js` | Scale, layers, colours, endpoints |

## Development guidelines

- **Match the surrounding style.** Modern ES modules, no framework, no
  transpilation. Keep code readable and commented where the intent isn't
  obvious (especially coordinate-frame maths).
- **Coordinate frames matter.** Satellites are propagated in ECI, converted to
  ECEF via GMST, then mapped to the scene as `(x, z, -y)` scaled by
  1 unit = 1000 km. The same convention is used by the lat/lon helper so ground
  tracks and footprints line up with satellites — keep both paths consistent if
  you touch either.
- **Keep it frontend-only.** No backend, no build tooling, no required API keys.
- **Mind performance.** Propagation runs in a worker; avoid moving heavy
  per-satellite maths onto the main thread.

## Submitting changes

1. Create a branch off `main`.
2. Make your change, and test it in a browser (load the app, confirm satellites
   render and a selection shows orbit/track/footprint).
3. Open a pull request describing what changed and why. Screenshots or a short
   clip are very welcome for visual changes.

## Reporting bugs and ideas

Use the issue templates under **Issues → New issue**. For anything
security-related, please see [SECURITY.md](SECURITY.md) instead of opening a
public issue.

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
