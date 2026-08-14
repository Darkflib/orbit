# Data sources & attribution

Orbit's satellite catalogue and sky artifacts are built and published by the
[orbit-data](https://github.com/Darkflib/orbit-data) service, which fetches and
normalises the sources below. Each enriched field records its winning source in
the `_sources` object of the enrichment files.

- **satcat** — CelesTrak (T.S. Kelso), celestrak.org — used with attribution
- **gcat** — GCAT © Jonathan McDowell, planet4589.org/space/gcat — CC-BY 4.0
- **mmccants** — Quicksat standard magnitudes © Mike McCants (freeware) — mmccants.org
- **bsc5** — Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren) — public domain, via VizieR V/50 (CDS); proper names from the IAU Catalog of Star Names (IAU WGSN, CC-BY 4.0)
- **constellation-figures** — Constellation figure lines © Olaf Frohn, from d3-celestial — BSD-3-Clause; positions J2000, consistent with the BSC5 star set

## Vendored runtime assets

`vendor/` holds the third-party code and imagery the app loads at runtime,
committed rather than fetched from a CDN so the app can be installed and
launched offline. Each file's upstream URL, pinned version and sha256 are
recorded in `vendor/VENDOR.json`, and `npm run vendor` regenerates the tree.

- **three.js** © three.js authors — MIT; `build/three.module.js` and
  `examples/jsm/controls/OrbitControls.js`
- **satellite.js** © Shashwat Kandadai and contributors — MIT
- **astronomy-engine** © Don Cross — MIT
- **Earth textures** — `examples/textures/planets` from the three.js repository
  (r160), distributed under three.js's MIT licence; derived from NASA imagery

The `data/` tree in this repository is a mirror of that published catalogue,
refreshed weekly by `mirror-catalogue.yml` and served as the app's fallback when
the mirror origin is unreachable. It is not built here; see
[orbit-data's `SOURCES.md`](https://github.com/Darkflib/orbit-data/blob/main/SOURCES.md)
for the fetch URLs and the vendored copies.
