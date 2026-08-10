# Glossary

Orbit sits at the crossing point of orbital mechanics, astronomy, and 3D
graphics, so its README and code lean on a lot of shorthand. This page explains
that vocabulary in plain terms. You don't need any of it to *use* the app — it's
here for when a label, a docs paragraph, or a source comment leaves you
wondering what a three-letter acronym actually means.

Terms are grouped by theme; within each group they're roughly ordered from
most to least fundamental. Cross-references are linked, and acronyms are spelled
out on first use.

---

## Orbits and orbital elements

**Orbital elements** — A small set of numbers that describe an orbit's size,
shape, and orientation, plus where the object sits along it at a known instant.
Together they let you reconstruct the whole orbit and predict future positions.
Instead of streaming a satellite's coordinates continuously, agencies publish
these elements and let your software do the propagation (see
[SGP4](#sgp4)). Orbit fetches them as [OMM](#omm) records.

<a id="epoch"></a>
**Epoch** — The exact timestamp the orbital elements are valid *for*. An orbit
prediction is most accurate near its epoch and slowly drifts away from reality
the further you propagate from it, which is why Orbit refetches fresh elements
periodically rather than trusting old ones indefinitely.

<a id="propagation"></a>
**Propagation** — Taking orbital elements at their [epoch](#epoch) and computing
where the object is at some *other* time — past or future. Orbit propagates
every satellite on every animation frame to make them move. The math model it
uses is [SGP4](#sgp4).

**LEO / MEO / GEO** — Orbit altitude bands.
- **LEO (Low Earth Orbit)** — roughly 160–2,000 km up. Fast-moving; a pass
  overhead lasts only minutes. Starlink and the ISS live here.
- **MEO (Medium Earth Orbit)** — the middle band, ~2,000–35,000 km.
  GNSS (Global Navigation Satellite System) constellations — GPS, Galileo, … —
  sit here.
- **GEO (Geostationary / Geosynchronous Orbit)** — ~35,786 km up over the
  equator, where an orbit takes exactly one day, so the satellite appears to
  hang fixed in the sky. Weather and TV-broadcast satellites are typically GEO.
- **HEO (Highly Elliptical Orbit)** — a stretched, egg-shaped orbit that dwells
  high over one hemisphere and whips quickly through the low part.

**Apogee / Perigee** — The highest (apogee) and lowest (perigee) points of an
orbit above Earth. A perfectly circular orbit has neither; an
[elliptical](#eccentricity) one has both.

**Inclination** — The tilt of the orbital plane relative to Earth's equator, in
degrees. 0° hugs the equator; 90° passes over the poles; values near 53° (common
for Starlink) trade off coverage and launch cost.

<a id="eccentricity"></a>
**Eccentricity** — How stretched (non-circular) the orbit is. 0 is a perfect
circle; closer to 1 is a long, thin ellipse.

**RAAN (Right Ascension of the Ascending Node)** — One of the orbital elements:
the angle that fixes how the orbital plane is rotated around Earth's axis. Loosely,
it says *which way* the orbit is turned in space. ("Ascending node" is the point
where the satellite crosses the equator heading north.)

**Constellation** — A group of satellites operated together to provide coverage,
e.g. Starlink, OneWeb, or a GNSS system. Orbit's toggleable layers correspond to
constellations and object types.

---

## Data formats and sources

<a id="gp"></a>
**GP (General Perturbations)** — CelesTrak's umbrella name for the standard
orbital-element data used with the [SGP4](#sgp4) model. When the README says
Orbit fetches from CelesTrak's "GP endpoint," it means this element data. GP is
distributed in a few formats; Orbit uses [OMM](#omm) JSON.

<a id="omm"></a>
**OMM (Orbit Mean-Elements Message)** — A modern, structured format (Orbit uses
its JSON form) for publishing [orbital elements](#orbits-and-orbital-elements).
It carries the same information as the older [TLE](#tle) but isn't limited by
TLE's rigid fixed-width layout — importantly, it supports 6-digit catalog
numbers, which the satellite population has now outgrown TLE's 5-digit limit for.

<a id="tle"></a>
**TLE (Two-Line Element set)** — The legacy text format for orbital elements: two
80-character lines of tightly packed numbers. Still ubiquitous, but its 5-digit
catalog-number field was exhausted in 2026, so newer objects are only published
as [OMM](#omm). Orbit deliberately uses OMM instead.

<a id="norad-id-catalog-number"></a>
**NORAD ID / Catalog Number** — The unique number assigned to each tracked space
object by the U.S. space-tracking catalog. Orbit uses it to dedupe records that
appear in more than one CelesTrak group. The 5-digit form ran out in 2026, hence
the move to [OMM](#omm) and 6-digit ids.

**COSPAR ID / International Designator** — The other common identifier for a space
object, based on its launch: launch year, launch number, and a piece letter (e.g.
`1998-067A` for the ISS). Older GCAT-style "piece designators" look like
`1957 ALP 1`. Distinct from the [NORAD ID](#norad-id-catalog-number).

<a id="satcat"></a>
**SATCAT** — CelesTrak's Satellite Catalog: the base catalogue of objects (names,
ids, launch and decay dates, orbit class) that Orbit's enrichment pipeline builds
on. The authoritative reentry date comes from SATCAT's `DECAY_DATE`.

<a id="gcat"></a>
**GCAT (General Catalog of Artificial Space Objects)** — Jonathan McDowell's
catalogue (CC-BY licensed), used to enrich records with physical data — mass,
dimensions, shape, operator, and status.

**Enrichment** — The offline merge of [SATCAT](#satcat), [GCAT](#gcat), and
magnitude data into a per-object catalogue, so the app can show a satellite's
size, brightness, and operator alongside its live position. Each field records
which source "won" it. Built and published by the
[orbit-data](https://github.com/Darkflib/orbit-data) service; `data/` in this
repository is a weekly mirror of that catalogue, used as a fallback when the
service is unreachable.

**RCS (Radar Cross Section)** — A measure of how large an object looks to radar,
used as a rough proxy for physical size. Mentioned in Orbit as a possible future
input for sharpening brightness estimates.

**Ephemeris** — In general astronomy, a table or model giving a celestial body's
position over time. In Orbit specifically, `src/ephemeris.js` provides the Sun's
direction, which drives the day/night [terminator](#terminator) and decides
whether a satellite is sunlit. (Plural: *ephemerides*.)

**satellite.js / SGP4** — see [SGP4](#sgp4). `satellite.js` is the JavaScript
library Orbit uses to turn [OMM](#omm) records into positions in the browser.

<a id="sgp4"></a>
**SGP4 (Simplified General Perturbations 4)** — The standard mathematical model
that turns a set of [orbital elements](#orbits-and-orbital-elements) into a
position and velocity at a given time. It accounts for the main forces that
perturb an orbit (Earth's oblateness, atmospheric drag, …). Orbit runs SGP4
entirely in the browser, thousands of times per update, to animate every
satellite.

---

## Coordinate frames and time

<a id="eci"></a>
**ECI (Earth-Centred Inertial)** — A coordinate frame fixed relative to the stars,
not to the spinning Earth. [SGP4](#sgp4) produces positions in ECI. Because the
Earth rotates underneath it, an ECI position must be converted before it can be
drawn against a fixed Earth texture.

<a id="ecef"></a>
**ECEF / ECF (Earth-Centred, Earth-Fixed)** — A coordinate frame that rotates
*with* the Earth, so a point on the ground keeps the same coordinates. Orbit
converts satellite positions from [ECI](#eci) to ECEF (using [GMST](#gmst)) so
they line up with the textured globe and their [ground tracks](#ground-track).

<a id="gmst"></a>
**GMST (Greenwich Mean Sidereal Time)** — The rotation angle of the Earth
relative to the stars at a given instant. It's the bridge that rotates an
[ECI](#eci) position into an [ECEF](#ecef) one.

**Sidereal time** — Time measured by the stars rather than the Sun. A sidereal
day (~23 h 56 m) is how long the Earth takes to rotate once relative to distant
stars — slightly shorter than the 24 h solar day. [GMST](#gmst) is a sidereal
measure.

<a id="sub-satellite-point"></a>
**Sub-satellite point** — The spot on the Earth's surface directly beneath a
satellite (straight down along the local vertical). Trace it over time and you
get the [ground track](#ground-track); in reentry mode Orbit marks the final
sub-satellite point as the estimated impact location.

**WGS84** — The standard model of the Earth's shape (a slightly flattened
ellipsoid) and the reference for latitude, longitude, and altitude. Used when
converting positions to look angles for an observer on the ground.

<a id="topocentric"></a>
**Topocentric** — Measured from a specific observer's location on the Earth's
surface, rather than from the Earth's centre. A satellite's
[azimuth and elevation](#azimuth-elevation) are topocentric — they depend on
where *you* are standing.

**UTC / UT1 / DUT1** — Flavours of time. **UTC** is the civil time standard your
clock keeps; **UT1** tracks the Earth's *actual* rotation, which wobbles slightly.
**DUT1** is the small difference between them (well under a second). Orbit treats
UTC as UT1, which costs about 1.2 arcseconds of Earth rotation — measured,
accepted, and far below the app's other error sources.

**J2000** — A standard reference epoch (noon UTC, 1 January 2000) that many
astronomical coordinate frames and formulas are anchored to, including Orbit's
solar-position math.

**Declination** — A celestial "latitude": how far north or south of the celestial
equator a body sits. Orbit's Sun-direction model is checked against the known
solar declination at the equinoxes and solstices.

---

## Observing a satellite from the ground

<a id="pass"></a>
**Pass** — A single event of a satellite rising above your local horizon,
crossing the sky, and setting again. Orbit's "Next visible passes" list predicts
these for a selected satellite at your location.

<a id="aos"></a>
**AOS (Acquisition Of Signal)** — The moment a satellite rises into view above
the horizon — the *start* of a [pass](#pass). The term comes from radio
tracking (the instant you can first "acquire" the satellite's signal); here it
just means "comes into sight."

<a id="los"></a>
**LOS (Loss Of Signal)** — The opposite of [AOS](#aos): the moment the satellite
drops back below the horizon and the [pass](#pass) ends.

<a id="azimuth-elevation"></a>
**Azimuth / Elevation (look angles)** — The two angles that say where to point to
see a satellite from your location.
- **Azimuth** — compass bearing, 0°–360° (0° = north, 90° = east, …).
- **Elevation** — height above the horizon, 0° (on the horizon) to 90°
  (straight up). Together these are the *look angles*, and they are
  [topocentric](#topocentric).

**Culmination** — The highest point of a [pass](#pass) — the moment of peak
[elevation](#azimuth-elevation), when the satellite is closest to overhead and
usually brightest. Orbit reports the culmination time and peak elevation.

**Zenith / Nadir** — **Zenith** is the point straight up above an observer (90°
elevation); **nadir** is straight down. A "near-zenith pass" goes almost directly
overhead — fast-moving and hard to sample precisely, which is why the README
notes larger timing error on those.

<a id="slant-range"></a>
**Slant range** — The straight-line distance from the observer to the satellite
(along the line of sight), as opposed to the ground distance. It affects how
bright the satellite looks.

<a id="magnitude"></a>
**Magnitude** — Astronomical brightness, on a backwards scale: *smaller* numbers
are brighter (the ISS can reach about −4; the naked-eye limit under a dark sky is
around +6.5). Orbit only lists a pass as "visible" when the object is plausibly
bright enough to see. Two flavours matter here:
- **Intrinsic / standard magnitude** — a satellite's baseline brightness under
  reference conditions (a standard range and lighting). A fixed property of the
  object; only ~8% of catalogued objects have one on record.
- **Apparent magnitude** — how bright it actually looks *right now* from your
  location, after adjusting the standard magnitude for its current
  [slant range](#slant-range) and [phase angle](#phase-angle).

<a id="phase-angle"></a>
**Phase angle** — The Sun–satellite–observer angle, which sets how much of the
satellite's sunlit side you can see (like the phases of the Moon). A low phase
angle (Sun behind you) means a fuller, brighter view; it's part of the
[apparent-magnitude](#magnitude) calculation.

<a id="terminator"></a>
**Terminator** — The moving day/night dividing line on the Earth. Orbit renders a
live terminator from the real Sun direction. A satellite is best seen when the
*observer* is in darkness but the *satellite* is still catching sunlight above
the shadow line.

**Twilight (civil twilight)** — The period after sunset / before sunrise when the
sky is dim but not fully dark. Orbit only lists a pass once the Sun is more than
6° below the observer's horizon (the end of civil twilight), matching the
convention used by Heavens-Above and N2YO.

**Sunlit / Eclipsed (in shadow)** — Whether the satellite itself is in sunlight
or has passed into the Earth's shadow. An eclipsed satellite reflects no sunlight
and is invisible, even on a clear night, which is why a single overhead pass can
briefly wink out and reappear.

**Umbra / Penumbra** — The two parts of the Earth's shadow: the **umbra** is the
full shadow (no direct sunlight), the **penumbra** is the fuzzy partial-shadow
edge. Orbit uses a simplified cylindrical umbra for its sunlit test — good enough
to decide "lit or not," without grading the gradual dimming through the penumbra.

---

## Visualization overlays

<a id="ground-track"></a>
**Ground track** — The path the [sub-satellite point](#sub-satellite-point)
traces across the Earth's surface over time — effectively the satellite's shadow
route along the ground. Toggleable per selected satellite.

**Orbit path** — The full loop of the satellite's orbit drawn in 3D space around
the globe (as opposed to the ground track, which lies *on* the surface).

**Footprint** — The circular area of the Earth's surface currently within the
satellite's line of sight — its coverage area at this instant. Drawn as a ring on
the globe beneath the satellite.

---

## Reentry mode

<a id="reentry"></a>
**Reentry** — When a decaying object drops low enough that atmospheric drag
brings it down. Orbit's reentry mode works from CelesTrak's decaying-object watch
list (`SPECIAL=DECAYING`) and [propagates](#propagation) each object with
[SGP4](#sgp4) until it falls below a reentry altitude, marking the estimated
impact [sub-satellite point](#sub-satellite-point).

**Decay** — The gradual loss of orbital altitude, mainly from atmospheric drag,
that eventually leads to [reentry](#reentry).

**Decaying-object watch list** — CelesTrak's `SPECIAL=DECAYING` dataset: objects
flagged as close to reentry. Orbit derives the *when* and *where* of reentry in
the browser rather than relying on a published forecast — these are SGP4
estimates, indicative of the trend rather than authoritative predictions.

---

## Rendering and app internals

**Three.js** — The WebGL 3D-graphics library Orbit uses to draw the Earth,
atmosphere, starfield, and the satellite point cloud.

**Point cloud** — Rendering thousands of satellites as individual points in one
efficient draw, rather than as separate 3D models, so the scene stays smooth.

**Raycasting** — The technique that turns a mouse click into a 3D selection:
Orbit casts a ray from the camera through the cursor and finds which satellite it
hits.

**Web Worker** — A background thread in the browser. Orbit runs the heavy
[SGP4](#sgp4) [propagation](#propagation) in a worker so it doesn't block
rendering and interaction on the main thread.

**Time warp** — Speeding up (or slowing / rewinding) the simulation clock. Orbit
can pause, snap back to "now," and warp time up to 1500× to watch orbits evolve
quickly.

**CORS (Cross-Origin Resource Sharing)** — The browser rule that decides whether
a page may fetch data from another domain. CelesTrak's GP endpoint is
CORS-enabled, which is what lets Orbit fetch orbital elements directly from the
browser with no backend of its own.

**localStorage** — A small persistent store in the browser. Orbit caches the
fetched orbital elements there (compactly encoded) and only refetches every 2
hours, so repeat loads are near-instant and use essentially no network.
