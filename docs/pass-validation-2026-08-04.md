# Pass-prediction sanity check — 2026-08-04

Independent validation of `src/passes.js` / `src/visibility.js` as deployed at
<https://darkflib.github.io/orbit/>.

**Verdict: the physics is right — Orbit's own code run at a 1 s step reproduces
Heavens-Above to within 2 seconds and 0.2 deg. Everything that disagrees is the
30 s sampling step. Two further behavioural issues are worth fixing, neither of
them a maths error.**

- Observer: Kegworth, UK — 52.8306 N, −1.2833 E (the app always stores
  `altKm: 0`, so the reference used 50 m / 0 km to match).
- Window: 24 h from 2026-08-04T22:00:00Z, matching `updatePasses()`.
- Elements: CelesTrak OMM JSON, the same `gp.php?GROUP=…&FORMAT=JSON` endpoint
  `src/gp.js` uses, fetched once and fed byte-identically to both
  implementations. That removes data vintage as a variable, so every
  disagreement is attributable to the algorithm.
- Sample: 11 hand-picked objects spanning LEO / MEO / GEO / HEO, then a
  seeded random 40 (18 LEO, 8 MEO, 8 GEO, 6 HEO) as a second, unbiased pass.

## How it was checked

Two things were run side by side.

1. **Orbit itself.** `src/passes.js`, `visibility.js`, `ephemeris.js` and
   `constants.js` were fetched verbatim from the deployed site and executed in
   Node against `satellite.js@7.1.0` — the same version the page's import map
   pins. The call is the one `main.js` makes: `predictPasses(satrec, observer,
   start, stdMag, { hours: 24 })`, everything else default (30 s step, 10 deg
   minimum elevation, mag 6.5 cutoff, 4 passes max).

2. **An independent reference**, deliberately different at every layer where
   an independent check has value:

   | Layer | Orbit | Reference |
   |---|---|---|
   | SGP4 | satellite.js | `sgp4` (Vallado C++ port) via Skyfield |
   | Sun | mean-longitude series, `ephemeris.js` | JPL DE421 apparent |
   | Topocentric | `ecfToLookAngles` | Skyfield WGS84 topocentric |
   | Earth shadow | cylindrical, sphere R=6371 | conical umbra/penumbra, WGS84 oblate |
   | Event times | 30 s grid, sampled extremum | bisection + golden section to 0.5 s |

### Layer-by-layer agreement (440 samples, 11 objects, 37-minute spacing)

| Quantity | Max difference | Reading |
|---|---|---|
| SGP4 position | **7.8 m** | satellite.js SGP4 is sound |
| SGP4 velocity | 8.8 mm/s | |
| GMST | 1.20 arcsec | constant — this is DUT1, `gstime` treats UTC as UT1. ~37 m of Earth rotation. Ignorable |
| Look-angle elevation | 0.0015 deg | |
| Look-angle azimuth | 0.0029 deg | |
| Slant range | 29 m | |
| Sun altitude at observer | **0.0015 deg** | ~1 s of timing error on the day/night gate |

One trap worth recording. Comparing `sunDirectionEci()`'s raw vector against a
J2000 reference shows a **0.373 deg** error that looks alarming and is not real:
the app's vector is equinox-of-date, which is the correct frame to pair with
SGP4's TEME output, and 0.373 deg is exactly general precession from J2000 to
2026.6. Both vectors go through the same `eciToEcf(gmst)` rotation, so it
cancels. Score the Sun altitude at the observer, not the raw vector.

### End-to-end agreement

All 51 objects: **pass counts identical** (`total` / `geomVisible` / visible)
except two Starlink cases noted below.

| | 11 hand-picked | random 40 |
|---|---|---|
| AOS | ≤ 23.9 s | ≤ 29.8 s |
| LOS | ≤ 26.4 s | ≤ 29.0 s |
| Peak time | ≤ 12.3 s | ≤ 14.4 s |
| Peak elevation | ≤ 0.33 deg | ≤ **8.97 deg** |
| Peak magnitude | ≤ 0.02 | ≤ 0.03 |

Every bound except the peak-elevation outlier sits inside one 30 s step, which
is the signature of quantisation rather than a modelling error. Confirmed
directly: re-running Orbit's *own* code at `stepSec: 1` reproduces the
reference's numbers almost exactly (TERRA −3.0 s vs −3.9 s, METOP-B −26.0 s vs
−26.4 s, Starlink-3005 −12.0 s vs −11.9 s, Galileo +23.0 s vs +23.9 s).

## Issues

### 1. Peak elevation is understated on near-zenith LEO passes — up to 9 deg

STARLINK-34970, 2026-08-05 20:19Z: Orbit reports **max 81 deg**, the true
culmination is **89.7 deg**.

A 550 km Starlink sweeps roughly 0.8 deg/s through the zenith, so a 30 s grid
can miss culmination by 15 s. Near the top of the sky the elevation curve is at
its sharpest, and the miss shows up almost entirely in the reported figure. The
UI renders `peakElevation.toFixed(0)`, so this is a visible, wrong integer —
"max 81 deg NE" for what is actually a straight-overhead pass, which is the one
detail an observer most wants right.

Not exotic: it hit 1 in 40 random objects, and 3 more passes in the same sample
came in 1.3–2.7 deg low. It also costs 2.9 deg on the ISS pass Heavens-Above
puts at 71 deg (see below), and flips the displayed compass bearing on half the
ISS passes checked.

Cheapest fix that keeps the 30 s scan: after `finalize()` picks `peak`, run a
few iterations of golden-section (or fit a parabola through the three samples
around the peak) on elevation between `peak-1` and `peak+1`. Three extra SGP4
calls per pass, and it collapses the error to well under 0.1 deg. Same trick on
the two window edges takes AOS/LOS from ±30 s to ±1 s.

### 2. Objects with no magnitude bypass the brightness filter entirely

`passes.js:54` — `s.v.apparentMag == null || s.v.apparentMag <= maxMag`. A null
magnitude is treated as "bright enough".

For LEO that is defensible (80.6% of active LEO objects have a magnitude). For
everything else it is not:

| Regime | Active objects | With a magnitude |
|---|---|---|
| LEO | 15 468 | 80.6% |
| MEO | 177 | **1.7%** |
| GEO | 584 | **5.5%** |
| HEO | 47 | **6.4%** |

The `geo` layer is on by default and 536 of its 568 objects have no magnitude.
Concretely, ASTRA 2F is reported as two naked-eye passes, 22:00–04:36 and
19:45–22:00, "max 24 deg SE". It is a geostationary comsat around mag +10.5 —
invisible, and it never moves. Same for every GPS and Galileo satellite: none
carry a magnitude, so all of them get listed.

The app already knows better — `brightnessClass()` buckets anything above mag 10
as "telescope". It just has no number to bucket.

Options, roughly in order of effort:

- Fall back to a range-derived floor when `stdMag` is null: even a crude
  `stdMag ≈ 8` for an unknown payload puts a 36 000 km object at apparent +16
  and filters it out, while leaving a 400 km object at +2.
- Or gate on regime: don't emit naked-eye passes for objects whose perigee is
  above (say) 2000 km unless there is a real measured magnitude.
- Or, minimally, treat null as "unknown" rather than "visible" and surface it
  as such — "3 sunlit passes, brightness unknown" instead of a pass list that
  implies you could go outside and see it.

### 3. Never-setting objects produce one 24 h "pass"

`predictPasses` only calls `finalize()` on the above-to-below transition, plus
once after the loop. An object that never drops below 10 deg — every GEO,
several MEO and HEO — therefore accumulates 2880 samples into a single "pass",
which is then split by darkness into windows of several hours. Reported as
`total: 1`, with a `peakElevation` that is just wherever the scan happened to
start and a `peakTime` that means nothing for a body fixed in the sky.

It is self-consistent and it does not corrupt anything else, but "1 pass in
24 h" and "peak at 01:15" are the wrong nouns for a geostationary satellite. A
regime check upstream — treat perigee-above-horizon-permanently objects as
"always up, best seen when dark" rather than as passes — would read better.

Related and cosmetic: windows clipped by the scan boundary report the boundary
as AOS or LOS. ASTRA 2F "visible from 22:00" is really "already up when we
started looking".

### 4. The twilight threshold is more permissive than other trackers

`visibility.js:59` computes `sky` with a −6 deg civil-twilight boundary, but the
pass gate never reads it — `state` only becomes `daylight` when `sunAltDeg > 0`.
So a pass counts as visible whenever the Sun is below the geometric horizon.

Heavens-Above and N2YO both require roughly Sun < −6 deg. Of the 7 visible
passes in the hand-picked sample:

| Object | Window | Sun altitude | Other trackers |
|---|---|---|---|
| METOP-B | 19:45–19:54 | −0.0 to −1.2 | would not list it at all |
| GSAT0101 | 02:17–04:36 | −15.1 to −0.0 | would trim the window |
| ASTRA 2F | both windows | to −0.0 | would trim |
| TERRA, METOP-B (21:25), Starlink-3005 | | −7.9 to −18.3 | comparable |

So an external comparison against Heavens-Above will show Orbit listing extra
passes and longer windows. That is a **convention difference, not an error** —
but it is the one that will make the app look wrong next to a tracker people
trust, and `sky` is already computed and thrown away. Using it (`sky === 'day'`
→ `sunAltDeg > -6`) would align the two.

## External check — Heavens-Above, ISS

Heavens-Above "all passes" for the same site and element set (its banner reads
414 x 424 km, 51.6 deg, epoch 3 August; Orbit's OMM is
`2026-08-03T19:06:47`). Same 10 deg threshold, same 24 h window, `tz=UCT`.

**Four passes, all flagged `daylight`, brightness `-`. Zero visible.** That is
exactly what Orbit reports (`total: 4, geomVisible: 0`) and exactly what the
independent reference reports. The "no visible passes" answer is correct, not a
filter swallowing something.

The reference against Heavens-Above, refined to 0.5 s:

| HA start | ref | HA peak | ref | HA end | ref | HA max el | ref | Compass |
|---|---|---|---|---|---|---|---|---|
| 10:03:15 | +0.2 s | 10:05:46 | +0.7 s | 10:08:18 | +0.9 s | 20 | 20.03 | SSW/SSE/E — identical |
| 11:38:49 | +0.9 s | 11:42:07 | +0.6 s | 11:45:26 | +0.2 s | 56 | 56.22 | WSW/SSE/E — identical |
| 13:15:26 | +1.2 s | 13:18:48 | +0.3 s | 13:22:10 | +0.2 s | 71 | 70.89 | W/S/ESE — identical |
| 14:52:15 | +1.2 s | 14:55:21 | +0.6 s | 14:58:27 | +0.2 s | 34 | 33.85 | W/SSW/SE — identical |

Everything inside 1.2 s and 0.22 deg, every compass bearing matching. Two
independent codebases, two ephemerides, two SGP4 implementations.

Then the same four passes through **Orbit's own code**, at its shipped 30 s step
and at 1 s, scored against Heavens-Above:

| | dAOS | dPeak | dLOS | d max el | compass |
|---|---|---|---|---|---|
| **stepSec: 30 (shipped)** | +4 to +15 s | −7 to +14 s | −10 to −27 s | −0.1 to **−2.9** | **2 of 4 wrong** |
| stepSec: 1 | +1 to +2 s | 0 to +1 s | 0 to +1 s | −0.1 to +0.2 | 4 of 4 correct |

At 1 s Orbit reproduces Heavens-Above to within two seconds. At 30 s the 71 deg
pass reads 68 deg, and the compass bearing shown next to it flips on half the
passes — pass 1 renders SE where HA says SSE, pass 3 renders SSE where HA says
S. That is issue 1 above, now measured against an external source rather than
against my own reference: **the shipped step size is the only thing standing
between this app and Heavens-Above-grade output.**

N2YO could not be used — it geolocates to the fetcher's IP and renders its table
client-side.

## Reproducing

`orbit_run.mjs`, `ref_passes.py`, `check_layers.py`, `compare.py`,
`dump_js_state.mjs`, `step_sens.mjs` and `diag_geom.mjs`, with the OMM snapshots
and both output sets, are in the session output folder. Order:

```
node orbit_run.mjs     selection.json omm.json 2026-08-04T22:00:00Z orbit_out.json
python3 ref_passes.py  selection.json omm.json 2026-08-04T22:00:00Z ref_out.json
python3 compare.py     orbit_out.json ref_out.json
node dump_js_state.mjs omm.json 2026-08-04T22:00:00Z js_state.json
python3 check_layers.py js_state.json omm.json
```
