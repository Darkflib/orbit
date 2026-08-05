# Refinement validation — 2026-08-05

Independent check of the event-time and culmination refinement described in
[pass-refinement-2026-08-05.md](pass-refinement-2026-08-05.md), against the same
external reference used in
[pass-validation-2026-08-04.md](pass-validation-2026-08-04.md).

**Verdict: the refinement works, and it works to the physics floor. Peak
elevation is now accurate to 0.002° — a ~1000× improvement, and as good as
satellite.js's look angles are in the first place. The dominant remaining error
is no longer the scan step; it is the cylindrical Earth-shadow model, worth
~2 s at a shadow-bounded window edge.**

## What this adds over the branch's own verification

`pass-refinement-2026-08-05.md` compares a refined 30 s scan against a 1 s scan
of the same code. That is a self-consistency check: it proves the refinement
recovers what a finer grid of *Orbit's own implementation* would have produced.
It cannot detect an error shared by both.

This exercise re-runs the 2026-08-04 external reference — Vallado SGP4 via
Skyfield, JPL DE421 apparent Sun, Skyfield WGS84 topocentric, conical
umbra/penumbra on an oblate Earth — updated to track the policy the app now
implements, so that a difference means numerics rather than convention:

- a pass is visible only at or below −6° Sun altitude,
- an object with no magnitude is admitted only when `UNKNOWN_STD_MAG + magOffset`
  clears the cutoff,
- an object above the gate for the whole scan is a standing object, not a pass.

The reference refines to a **0.5 ms** tolerance against the app's 200 ms, so it
is not the limiting factor in any figure below.

Sample: the same 11 hand-picked objects (LEO/MEO/GEO/HEO) and seeded random 40
as 2026-08-04, same observer (Kegworth, 52.8306 N, −1.2833 E, `altKm: 0`), same
24 h window from 2026-08-04T22:00:00Z, same CelesTrak OMM snapshot fed to both.
**51 objects, 14 emitted passes, 5 standing objects.**

## Results

### Structure

| | Agreement |
|---|---|
| Pass counts (`total` / `geomVisible` / emitted) | **49 / 51** objects identical |
| Standing objects (`alwaysUp`) | **5 / 5**, look angles to 0.000°, dark hours to 0.0 min |

The two exceptions are `geomVisible` only, and are discussed under "Still
grid-quantised" below.

### Peak elevation — the error this change set out to fix

Raw 30 s grid against refined 30 s, both scored on the reference:

| NORAD | Object | Peak | Grid error | Refined error |
|---|---|---|---|---|
| 63516 | STARLINK-33785 | 62.98° | −2.099° | +0.0008° |
| 63516 | STARLINK-33785 | 57.74° | −1.589° | +0.0008° |
| 66083 | STARLINK-35291 | 83.19° | −1.336° | +0.0001° |
| 66083 | STARLINK-35291 | 60.56° | −1.269° | −0.0008° |
| 48602 | STARLINK-2713 | 45.89° | −0.439° | +0.0008° |
| 48881 | STARLINK-3005 | 65.63° | −0.336° | +0.0020° |
| 48593 | STARLINK-2250 | 77.55° | −0.261° | +0.0007° |
| 65458 | STARLINK-34784 | 66.97° | −0.178° | −0.0008° |
| 25994 | TERRA | 37.04° | −0.113° | +0.0009° |
| 65176 | STARLINK-34707 | 28.30° | −0.097° | −0.0009° |
| 40053 | SPOT 7 | 31.65° | −0.043° | +0.0008° |
| 40053 | SPOT 7 | 10.36° | −0.033° | +0.0003° |
| 38771 | METOP-B | 26.31° | −0.027° | +0.0006° |
| 55447 | APSTAR-6E SPS | 37.28° | −0.000° | −0.0001° |

Worst grid error **2.099°**, worst refined error **0.0020°** — a factor of
~1050. Every grid error is negative, as expected: sampling a maximum can only
ever miss it low.

This is the physics floor. The 2026-08-04 layer check put satellite.js's
topocentric look angles at 0.0015° from Skyfield's, so a refined peak agreeing
to 0.0020° is agreeing as closely as the underlying geometry allows. Nothing
further is available without changing the propagator.

Peak **time** agrees to **≤ 48 ms** and peak **azimuth** to **≤ 0.174°** (scored
below 85° elevation; through the zenith the azimuth sweeps ~180° and a
millisecond of peak-time difference is a large, meaningless swing there).

### Window edges — and the new dominant error term

The edges split cleanly by *what actually bounds the window*, which the
refinement's `inWindow` bisection deliberately does not distinguish:

| Binding constraint | Edges | Max Δ | Median Δ |
|---|---|---|---|
| 10° elevation gate | 6 | **87 ms** | 41 ms |
| Naked-eye magnitude cutoff | 13 | **105 ms** | 69 ms |
| **Earth's shadow** | 9 | **2516 ms** | 1887 ms |

Gate- and magnitude-bounded edges land within ~100 ms — sub-second, as the
branch claims. Shadow-bounded edges do not, and the reason is a modelling
difference rather than a refinement failure.

It is systematic and signed. Orbit's AOS is always *later* than the reference's
and its LOS always *earlier*:

| NORAD | Object | Edge | Δ |
|---|---|---|---|
| 66083 | STARLINK-35291 | AOS | +2516 ms |
| 63516 | STARLINK-33785 | LOS | −2393 ms |
| 48593 | STARLINK-2250 | LOS | −2079 ms |
| 63516 | STARLINK-33785 | LOS | −2002 ms |
| 65458 | STARLINK-34784 | AOS | +1887 ms |
| 48881 | STARLINK-3005 | AOS | +1725 ms |

That sign pattern is exactly what a **cylindrical shadow on a 6371 km sphere**
predicts against a converging **umbra cone on the WGS84 ellipsoid**. A cylinder
never narrows, so it is too wide at orbital altitude; the satellite therefore
reads as eclipsed for ~2 s too long at each end, ~4 s per window. The six large
cases are all Starlink at ~550 km, where the cone has converged appreciably and
the discrepancy is at its worst.

**Not worth fixing.** The UI renders `hh:mm`, so ~4 s of window is invisible,
and the real penumbra makes the true answer soft anyway. But the header comment
in `src/passes.js` — "the edges land ~sub-second" — is true only for gate- and
magnitude-bounded edges. A shadow-bounded edge lands ~2 s from a conical model,
and that is now the largest error in the pass pipeline. Worth a footnote there
and in the README's Accuracy section.

### Still grid-quantised: `total` and `geomVisible`

The refinement acts on *emitted* passes. The scan that decides which passes
exist is still a 30 s walk, so a short visible window can be missed entirely:

| NORAD | Sunlit window the grid misses | `geomVisible` 30 s | at 1 s |
|---|---|---|---|
| 63516 | 24 s | 2 | **3** |
| 66083 | 26 s | 2 | **3** |

Both are the two count disagreements above; in both cases the *emitted* passes
still match. The consequence is confined to the fallback line in
`renderPasses()` — the app can report "2 sunlit passes in 24 h" where there were
three. Low-value to fix (it would mean refining the scan itself, which is the
cost the grid exists to avoid) but it should be known, because the branch's
accuracy claims do not cover these two numbers.

### Minor: `peakMag` is not refined

`peakElevation` and `peakAzimuth` are read back at the refined culmination;
`peakMag` is still the brightest *grid* sample. The difference is ≤ 0.02 mag
across the sample, so it is numerically irrelevant — but it is an inconsistency,
and reading the magnitude back at the refined peak alongside the look angles
would cost nothing since `visibilityAt(tPk)` is already being called.

## The Heavens-Above question

`pass-refinement-2026-08-05.md` leaves the external cross-check as "still the
user's to confirm". It cannot be settled head-on, for a structural reason worth
recording so nobody tries again.

Heavens-Above tabulates the **geometric** 10° pass — rise, culmination, set.
Orbit emits the **visible window**, whose edges are usually the shadow,
twilight, or magnitude boundary rather than the elevation gate. The two are only
directly comparable when a window happens to be gate-bounded at both ends, which
in this sample is **1 window out of 14** (SPOT 7, 22:54:26–22:56:02, and it is a
marginal 10.4° pass):

<https://heavens-above.com/PassSummary.aspx?satid=40053&lat=52.8306&lng=-1.2833&loc=Kegworth&alt=0&tz=UCT>

It is, however, settled transitively and tightly:

1. The reference reproduced Heavens-Above on ISS (four passes, 2026-08-04) to
   **≤ 1.2 s** and **≤ 0.22°**, with all twelve compass bearings identical.
2. Refined Orbit reproduces that reference to **≤ 87 ms** on gate-bounded edges,
   **≤ 48 ms** on peak time and **≤ 0.0020°** on peak elevation.

So refined Orbit against Heavens-Above is bounded well under 1.5 s and 0.25° —
the branch's own prediction ("~1 s and ~0.2°, and all four compass bearings
right") holds, with the refinement contributing under a tenth of that budget.

## Correction to this exercise

The first run of the updated reference showed an 8.9 s AOS disagreement on
METOP-B. That was a bug in the *reference*, not in Orbit: its edge bracket was
one dense-sample step wide rather than one coarse step, so a run starting flush
with the dense array could not be bisected back past the coarse grid point, and
it silently reported its own quantisation. Fixed; the edge then agreed to 34 ms.
Recorded because it is the same class of error this whole exercise exists to
find, and it landed in the measuring instrument rather than the instrument under
test.

## Reproducing

`ref_passes2.py` (policy-matched reference) and `compare2.py` (diff), with the
OMM snapshots and both output sets, are in the session output folder.

```
node orbit_run.mjs    selection.json omm.json 2026-08-04T22:00:00Z orbit_ref.json
python3 ref_passes2.py selection.json omm.json 2026-08-04T22:00:00Z ref2_out.json
python3 compare2.py    orbit_ref.json ref2_out.json
```

Branch test suite: **33 / 33 passing** (`npm test`, Node's built-in runner), run
from a clean checkout of `claude/pass-refinement` with a fresh `npm ci`.
