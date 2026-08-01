// Precedence engine: fold the source maps into one enriched record per NORAD id.
//
// The base set is SATCAT (every record starts from a SATCAT row). GCAT and
// mmccants augment. Per-field precedence follows docs/data-enrichment-schema.md
// §3; the winning source id is stamped into `_sources` (attribution + trust).
// Finally the 12-month decay window is applied.

const DAY_MS = 86400000;

// Resolve a field from an ordered list of [sourceId, value] candidates; first
// non-null wins. Records the winning source into `sources`.
function pick(sources, field, candidates) {
  for (const [srcId, value] of candidates) {
    if (value !== null && value !== undefined && value !== '') {
      sources[field] = srcId;
      return value;
    }
  }
  return undefined;
}

function set(rec, field, value) {
  if (value !== null && value !== undefined && value !== '' &&
      !(Array.isArray(value) && value.length === 0)) {
    rec[field] = value;
  }
}

// Build the merged catalogue. `now` is an ISO date (YYYY-MM-DD) — the rolling
// 12-month decay window is measured from it; passed in for determinism/testing.
export function merge({ satcat, gcat, mmccants }, now) {
  const cutoff = new Date(now).getTime() - 365 * DAY_MS;
  const out = new Map();
  const counts = { records: 0, withGcat: 0, withMag: 0, droppedDecayed: 0 };

  for (const [norad, s] of satcat) {
    const g = gcat.get(norad) || {};
    const m = mmccants.get(norad) || {};
    const src = {};
    const rec = { norad };

    set(rec, 'cospar', pick(src, 'cospar', [['satcat', s.cospar]]));
    set(rec, 'name', pick(src, 'name', [['satcat', s.name], ['gcat', g.name]]));
    set(rec, 'altNames', g.altNames || undefined);
    if (rec.altNames) src.altNames = 'gcat';

    set(rec, 'objectType', pick(src, 'objectType', [['satcat', s.objectType], ['gcat', g.objectType]]));
    set(rec, 'opsStatus', pick(src, 'opsStatus', [['satcat', s.opsStatus]]));
    // Lifecycle status: GCAT wins; else derive from decay date.
    const derivedStatus = s.decayDate ? 'decayed' : 'in-orbit';
    set(rec, 'status', pick(src, 'status', [['gcat', g.status], ['satcat:derived', derivedStatus]]));
    set(rec, 'orbitClass', pick(src, 'orbitClass', [['gcat', g.orbitClass]]));

    set(rec, 'owner', pick(src, 'owner', [['gcat', g.owner]]));
    set(rec, 'country', pick(src, 'country', [['satcat', s.country], ['gcat', g.country]]));

    set(rec, 'launchDate', pick(src, 'launchDate', [['gcat', g.launchDate], ['satcat', s.launchDate]]));
    set(rec, 'launchSite', pick(src, 'launchSite', [['satcat', s.launchSite]]));

    set(rec, 'massKg', pick(src, 'massKg', [['gcat', g.massKg]]));
    set(rec, 'dimensions', pick(src, 'dimensions', [['gcat', g.dimensions]]));
    set(rec, 'shape', pick(src, 'shape', [['gcat', g.shape]]));
    set(rec, 'rcsSize', pick(src, 'rcsSize', [['satcat', s.rcsSize]]));
    set(rec, 'rcsValue_m2', pick(src, 'rcsValue_m2', [['satcat', s.rcsValue_m2]]));

    set(rec, 'stdMag', pick(src, 'stdMag', [['mmccants', m.stdMag]]));
    if (rec.stdMag !== undefined) rec.magSource = 'mmccants';

    // Decay date & the 12-month window use SATCAT only. GCAT's DDate has broader
    // semantics — it also marks assembly/renaming (e.g. Zarya's DDate is 1998,
    // when it became part of the ISS), which would wrongly drop still-orbiting
    // objects. SATCAT's DECAY_DATE is the authoritative atmospheric-reentry date.
    const decayDate = pick(src, 'decayDate', [['satcat', s.decayDate]]);
    set(rec, 'decayDate', decayDate);

    // Rolling 12-month window: keep active + recently-decayed only.
    if (decayDate) {
      const t = new Date(decayDate).getTime();
      if (!Number.isNaN(t) && t < cutoff) { counts.droppedDecayed++; continue; }
    }

    rec._sources = src;
    out.set(norad, rec);
    counts.records++;
    if (gcat.has(norad)) counts.withGcat++;
    if (rec.stdMag !== undefined) counts.withMag++;
  }

  return { records: out, counts };
}
