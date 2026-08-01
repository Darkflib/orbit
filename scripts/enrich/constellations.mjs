// Per-constellation magnitude estimates.
//
// mmccants measures almost none of the large modern constellations
// individually (0 Starlink / OneWeb magnitudes in qs.mag), yet these are the
// bulk of what users click. As a fallback we assign one representative value
// per constellation bus, applied ONLY when there is no measured magnitude.
//
// These are ESTIMATES, not measurements — a typical brightness for the
// constellation, chosen to convey the right observability class rather than a
// precise value. They are always surfaced in the UI explicitly labelled as
// estimated (magSource: 'estimate', magBasis: <what the estimate is based on>).
// Values are rough standard magnitudes (1000 km range, full phase), consistent
// with the mmccants `stdMag` convention. Actual brightness varies by
// generation, orbit and pass geometry.
//
// Generation nuance (Starlink): the first sats (v0.9 / early v1.0, before the
// mid-2020 VisorSat sunshade and later dielectric-mirror coating) were markedly
// brighter than today's coated sats. Most have since decayed and are dropped by
// the 12-month window, but the few that remain get the brighter early estimate
// via the `variants` launch-date split below.
export const CONSTELLATION_MAG = [
  {
    id: 'starlink', label: 'Starlink', re: /^STARLINK/i, mag: 5.5,
    variants: [
      { before: '2020-06-01', mag: 4.5, label: 'Starlink (early, pre-visor)' },
    ],
  },
  { id: 'oneweb', label: 'OneWeb', re: /^ONEWEB/i, mag: 7.5 },
  { id: 'kuiper', label: 'Kuiper', re: /^KUIPER/i, mag: 6.0 },
  { id: 'qianfan', label: 'Qianfan', re: /^QIANFAN/i, mag: 5.5 },
  { id: 'guowang', label: 'Guowang', re: /HULIANWANG/i, mag: 6.5 },
];

// Return { id, label, mag } for a record's constellation estimate, or null.
// Takes the whole record so a constellation can vary its estimate by launch
// date (ISO strings compare lexicographically).
export function estimateMag(rec) {
  const name = rec && rec.name;
  if (!name) return null;
  for (const c of CONSTELLATION_MAG) {
    if (!c.re.test(name)) continue;
    if (c.variants && rec.launchDate) {
      for (const v of c.variants) {
        if (rec.launchDate < v.before) return { id: c.id, label: v.label, mag: v.mag };
      }
    }
    return { id: c.id, label: c.label, mag: c.mag };
  }
  return null;
}
