// Fail-safe validation gate. Throws (aborting the build before any deploy) when
// output looks broken, so a bad upstream never overwrites the published site
// with an empty or wrong catalogue. Softer regressions are returned as warnings.

const SATCAT_FLOOR = 20000;     // real catalogue is ~70k; far below = broken fetch
const GCAT_JOIN_MIN = 0.40;     // fraction of records that should resolve to GCAT

export function validate({ satcatRows, counts }) {
  const warnings = [];

  if (!(satcatRows >= SATCAT_FLOOR)) {
    throw new Error(`SATCAT parsed only ${satcatRows} rows (floor ${SATCAT_FLOOR}) — aborting, source likely broken`);
  }
  if (!(counts.records > 0)) {
    throw new Error('0 records survived merge/decay filter — aborting');
  }

  const gcatFrac = counts.records ? counts.withGcat / counts.records : 0;
  if (gcatFrac < GCAT_JOIN_MIN) {
    warnings.push(`GCAT join only ${(gcatFrac * 100).toFixed(1)}% (< ${GCAT_JOIN_MIN * 100}%) — metadata degraded, check GCAT join key`);
  }
  if (counts.withMag === 0) {
    warnings.push('no records carry a magnitude — brightness badge will be empty; check qs.mag vendor file');
  }

  return { warnings };
}
