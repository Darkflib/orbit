// Adapter: CelesTrak SATCAT (CSV). The LOAD-BEARING source — it defines the
// base object set; every enriched record starts from a SATCAT row. GCAT and
// mmccants only augment.
//
// Verified live 2026-08-01. Header row:
//   OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,
//   LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,
//   DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE
// RCS is a numeric m² value here (not the SMALL/MEDIUM/LARGE bucket the GP API
// returns), so we keep the number and derive the bucket from CelesTrak's
// thresholds.

import { getText, splitCsvLine } from '../http.mjs';

export const id = 'satcat';
export const licence = 'CelesTrak (T.S. Kelso), celestrak.org — used with attribution';
const URL = 'https://celestrak.org/pub/satcat.csv';

const OBJECT_TYPE = { PAY: 'payload', 'R/B': 'rocket-body', DEB: 'debris', UNK: 'unknown' };
// OPS_STATUS_CODE → schema opsStatus (CelesTrak legend).
const OPS_STATUS = {
  '+': 'operational', P: 'partial', B: 'backup', S: 'backup',
  '-': 'nonoperational', X: 'extended', D: 'decayed', '?': 'unknown',
};

// CelesTrak RCS-size thresholds (m²): SMALL <0.1, MEDIUM 0.1–1.0, LARGE >1.0.
function rcsSizeFromValue(v) {
  if (v == null || Number.isNaN(v)) return null;
  if (v < 0.1) return 'small';
  if (v <= 1.0) return 'medium';
  return 'large';
}

// "2026-07-31" or "" → ISO date string or null.
function isoDate(s) {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function load(http = { getText }) {
  const { body, fetchedAt, fromCache } = await http.getText(URL);
  const lines = body.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const byNorad = new Map();
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const norad = String(parseInt(f[col.NORAD_CAT_ID], 10));
    if (norad === 'NaN') continue;

    const rcsVal = f[col.RCS] ? parseFloat(f[col.RCS]) : null;
    byNorad.set(norad, {
      norad,
      cospar: f[col.OBJECT_ID] || null,
      name: (f[col.OBJECT_NAME] || '').trim() || null,
      objectType: OBJECT_TYPE[f[col.OBJECT_TYPE]] || 'unknown',
      opsStatus: OPS_STATUS[f[col.OPS_STATUS_CODE]] || 'unknown',
      country: f[col.OWNER] || null,
      launchDate: isoDate(f[col.LAUNCH_DATE]),
      launchSite: f[col.LAUNCH_SITE] || null,
      decayDate: isoDate(f[col.DECAY_DATE]),
      rcsValue_m2: Number.isNaN(rcsVal) ? null : rcsVal,
      rcsSize: rcsSizeFromValue(rcsVal),
    });
  }
  return { records: byNorad, meta: { ok: true, fetchedAt, fromCache, rows: byNorad.size } };
}
