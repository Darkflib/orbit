# Orbit — Real-time 3D Satellite Tracker

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![No backend](https://img.shields.io/badge/backend-none-success.svg)
![No build step](https://img.shields.io/badge/build-none-success.svg)
![Data: CelesTrak](https://img.shields.io/badge/data-CelesTrak-38bdf8.svg)

A frontend-only, real-time 3D visualization of the world's active satellites.
It fetches [CelesTrak](https://celestrak.org/) orbital elements once — as OMM
(Orbit Mean-Elements Message) records in JSON — then uses
[satellite.js](https://github.com/shashwatak/satellite-js) (an SGP4
implementation) to propagate every satellite's position **directly in the
browser** — so thousands of satellites move continuously, frame by frame, with
essentially zero network traffic.

Thousands of Starlink satellites form a glowing shell around a textured Earth;
GPS/GNSS, OneWeb, geostationary birds, and the ISS all sit in their real orbits.
Click any satellite to see its live position, orbit path, ground track, and
coverage footprint.

> **New to orbital jargon?** Terms like GP, OMM, SGP4, ephemeris, AOS/LOS, and
> footprint are explained in the [Glossary](docs/GLOSSARY.md).

## Highlights

- **No backend, no API key, no rate limits.** All data comes from CelesTrak's
  public GP endpoint (CORS-enabled). Elements are cached in `localStorage`
  (compactly encoded) and only refetched every 2 hours.
- **OMM, not legacy TLE.** CelesTrak exhausted 5-digit catalog numbers in 2026;
  new objects (6-digit IDs) are no longer published as TLEs. Orbit uses the OMM
  JSON format via `satellite.js` `json2satrec`, so it keeps working as the
  catalog grows. See
  [CelesTrak's format notes](https://celestrak.org/NORAD/documentation/gp-data-formats.php).
- **In-browser SGP4.** Positions are computed locally from orbital elements, so
  the "real-time" motion costs no API quota. Time can be paused, rewound to now,
  and warped up to 1500×.
- **Propagation in a Web Worker.** Thousands of SGP4 propagations per update run
  off the main thread, keeping rendering and interaction smooth.
- **Physically-grounded rendering.** Positions are propagated in ECI, converted
  to Earth-fixed (ECEF) coordinates, and drawn against a fixed Earth texture with
  a live day/night terminator driven by the real Sun direction.
- **Interaction.** Click or search to select a satellite; toggle its orbit path,
  ground track, and footprint; let the camera follow it. Toggle layers
  (Starlink, GNSS, OneWeb, GEO, stations) or load all ~12,000 active satellites.
- **Reentry mode.** A separate view built on CelesTrak's decaying-object watch
  list (`SPECIAL=DECAYING`). Because those records carry only orbital elements,
  Orbit derives the *when* and *where* in the browser: it propagates each object
  with SGP4 until it drops below a reentry altitude and marks the sub-satellite
  point as the estimated impact location, plotting a red target on the globe for
  every prediction. A side panel lists the objects sorted by estimated
  time-to-reentry, and selecting one shows its predicted reentry time,
  countdown, and coordinates. These are SGP4 estimates — indicative of the
  trend, not authoritative reentry forecasts.

## Running it

The app is static, but because it uses ES module workers and `fetch`, it must be
served over HTTP (not opened via `file://`).

```bash
# Option 1 — bundled zero-dependency server (Node 18+)
npm start
# → http://localhost:8080

# Option 2 — anything that serves static files
python3 -m http.server 8080
npx serve .
```

Then open the printed URL. The first load fetches GP data from CelesTrak
(a few seconds); subsequent loads use the 2-hour cache.

## How it works

```
CelesTrak OMM (JSON)  ──fetch (≤ once / 2h)──►  localStorage cache (compact)
     │
     ▼
 parse + validate (satellite.js json2satrec)  ──►  Web Worker (holds SGP4 satrecs)
     │                                        │
     │   each animation frame: sim time ──────┘
     │                                        │
     ▼                                        ▼
 Three.js point cloud  ◄──── ECI→ECEF→scene positions (Float32Array, transferable)
```

- **`src/gp.js`** — fetches CelesTrak groups (and the `SPECIAL=DECAYING` set) as
  OMM JSON, normalises records, dedupes by NORAD id, and handles compact caching
  with stale-cache fallback.
- **`src/reentry.js`** — the reentry mode: SGP4 forward-propagation to an
  estimated decay epoch and sub-satellite impact point, plus the estimated-location
  markers drawn on the globe.
- **`src/worker.js`** — builds SGP4 records and propagates every satellite to a
  requested time, returning Earth-fixed scene positions as a transferable buffer.
- **`src/satellites.js`** — the point-cloud layer, layer visibility, click
  selection (raycasting), and the orbit / ground-track / footprint overlays.
- **`src/scene.js`** — renderer, camera, `OrbitControls`, the Earth (custom
  day/night shader), atmosphere, clouds, and starfield.
- **`src/utils.js`** — coordinate conversions (ECEF↔scene, lat/lon↔scene), an
  approximate Sun-direction model, and formatting helpers.
- **`src/main.js`** — the simulation clock, the render loop, and all UI wiring.

### Coordinate convention

Satellites are propagated in the inertial (ECI) frame, then rotated to
Earth-Centred-Earth-Fixed (ECEF) using Greenwich mean sidereal time so they line
up with a fixed Earth texture. ECEF `(x, y, z)` km maps to the Y-up scene as
`(x, z, −y)` scaled by 1 unit = 1000 km. The same convention is used for the
lat/lon → position helper, so ground tracks and footprints sit exactly beneath
their satellites.

## Accuracy

Pass predictions scan SGP4 on a fixed **30 s grid** over a 24 h horizon, then
refine each reported pass off that grid — the window edges by bisecting on
visibility, the culmination by a golden-section search — so the reported events
are no longer quantised to the step. Checked against an independent
implementation (Vallado SGP4 via Skyfield, JPL DE421 Sun, WGS84 topocentric,
conical umbra) on the same element set, and transitively against Heavens-Above:

| Quantity | Agreement |
|---|---|
| SGP4 position | 7.8 m |
| Look angles, Sun altitude at the observer | 0.0015° |
| Peak elevation (refined) | 0.002° |
| Rise/set bounded by the 10° gate or a magnitude cutoff | ~0.1 s |
| Rise/set bounded by Earth's shadow | ~2 s |

The peak is now accurate to the geometry floor — satellite.js's own look angles
are ~0.0015° from the reference, so the refined culmination is as good as the
propagator allows. The one edge that is not sub-second is a shadow-bounded one:
Orbit models Earth's shadow as a cylinder on a spherical Earth, the reference as
a converging cone on the WGS84 ellipsoid, and the two differ by ~2 s at orbital
altitude. That is now the largest error in the pass pipeline, though invisible at
the `hh:mm` the UI renders. Full write-ups: the physics in
[`docs/pass-validation-2026-08-04.md`](docs/pass-validation-2026-08-04.md); the
refinement and its independent check in
[`docs/pass-refinement-2026-08-05.md`](docs/pass-refinement-2026-08-05.md) and
[`docs/pass-refinement-validation-2026-08-05.md`](docs/pass-refinement-validation-2026-08-05.md).

A pass is only listed when the Sun is more than 6° below the observer's horizon
(the end of civil twilight), matching the convention Heavens-Above and N2YO use.
Objects with no magnitude on record are listed only where a naked-eye sighting
is physically plausible — roughly, within LEO range — rather than being assumed
bright enough to see.

## Data & attribution

- Orbital elements: [CelesTrak](https://celestrak.org/) (Dr. T.S. Kelso).
- Propagation: [satellite.js](https://github.com/shashwatak/satellite-js).
- Rendering: [three.js](https://threejs.org/). Earth textures from the three.js
  examples.

Visual references: [Track The Sky](https://trackthesky.com/) and
[satellitemap.space](https://satellitemap.space/).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set
up and submit changes, and please follow our
[Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue? See
[SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
