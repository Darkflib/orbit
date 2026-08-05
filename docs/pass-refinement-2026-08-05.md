# Pass event-time & culmination refinement — 2026-08-05

Follow-up to [pass-validation-2026-08-04.md](pass-validation-2026-08-04.md),
which established that Orbit's physics is sound and that the **30 s scan step was
the entire remaining error budget**: ±30 s on the window edges and up to **8.97°**
understated at the culmination of a fast near-zenith pass (STARLINK-34970: 81°
reported for an 89.7° overhead pass), with the compass bearing flipping on half
the ISS passes checked. This change refines both off the grid.

## What changed

`src/passes.js` now refines each emitted pass after the grid scan locates it:

- **Window edges** — each non-clipped edge is bisected on **window membership**
  (`inWindow`: above the 10° gate *and* sunlit *and* dark sky *and* bright
  enough). Bisecting the whole conjunction means the edge lands on whatever
  transition actually bounds the window — the 10° gate on a pass that rises and
  sets in darkness, or the shadow / twilight / brightness edge on one that
  doesn't — with no special-casing. The refined time sits on the inside of the
  transition, so a window never claims visibility a moment early or late. Clipped
  edges (scan boundaries, not rise/set) are left as reported.
- **Culmination** — elevation over a single visible window is unimodal (one
  culmination per pass), so a **golden-section search** across the refined window
  finds the true maximum whether it falls in the interior *or* on an edge (a pass
  still climbing when it enters Earth's shadow has its highest visible instant at
  the shadow entry, not at an interior peak). The look angles — elevation and the
  compass azimuth — are read back at that instant.

Cost: ~4.7 ms per 24 h scan, up from ~2 ms. Only emitted passes (≤ `maxPasses`)
are refined, so it stays bounded regardless of how many passes the day holds.

## Verified — refined 30 s vs a 1 s scan

The 2026-08-04 exercise showed Orbit's own code at `stepSec: 1` reproduces the
independent Skyfield / DE421 / Vallado-SGP4 reference (and Heavens-Above) to ~1 s
and ~0.1°. So a refined 30 s scan agreeing with a 1 s scan is the self-contained
proof that the refinement has recovered reference-grade numbers. The fixed ISS
element set, scanned over a 45-observer grid (lat −50…50, lon −180…160), 59
matched passes:

| Quantity | Raw 30 s grid (2026-08-04) | Refined 30 s vs 1 s |
|---|---|---|
| AOS | ≤ 29.8 s | **≤ 78 ms** |
| LOS | ≤ 29.0 s | **≤ 109 ms** |
| Peak elevation | ≤ **8.97°** | **≤ 0.065°** |
| Peak azimuth (el < 85°) | up to a compass point out | **≤ 0.61°** |

The highest pass in the grid (−50, 160), a near-zenith pass, is the case the grid
hurts most: the raw grid sample maxes at **86.10°**, the refinement lifts it to
**89.69°**, and a 1 s scan puts the true culmination at **89.69°** — a 3.59°
correction, matched to 0.001°.

Azimuth is compared only below 85° elevation: through the zenith the azimuth
genuinely sweeps ~180° across the overhead point, so a millisecond of peak-time
difference is a large and meaningless azimuth swing there — the elevation is the
meaningful quantity on an overhead pass, and it agrees to 0.065°.

The checks are locked in as `test/passes-refinement.test.mjs` (the grid
consistency and the near-zenith recovery), alongside the existing invariants in
`test/passes.test.mjs`, which continue to hold — the refined edges only ever grow
a window outward to the true transition and the refined peak stays within it.

## Still the user's to confirm

The external Heavens-Above cross-check from 2026-08-04 (ISS, four passes) predates
this change. Re-running it against the refined output is the last confirmation
before shipping — the 1 s agreement above predicts the shipped 30 s output should
now match Heavens-Above to ~1 s and ~0.2° and get all four compass bearings right,
where the raw 30 s step read the 71° pass as 68° and flipped two of four bearings.
