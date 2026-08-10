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

The `data/` tree in this repository is a mirror of that published catalogue,
refreshed weekly by `mirror-catalogue.yml` and served as the app's fallback when
the mirror origin is unreachable. It is not built here; see
[orbit-data's `SOURCES.md`](https://github.com/Darkflib/orbit-data/blob/main/SOURCES.md)
for the fetch URLs and the vendored copies.
