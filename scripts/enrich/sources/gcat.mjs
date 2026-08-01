// Adapter: GCAT — Jonathan McDowell's General Catalog of Artifacts in Space.
// Augments the SATCAT base set with mass, dimensions, shape, orbit class,
// operator, lifecycle status and alternate names.
//
// Verified live 2026-08-01. Tab-separated; header line begins "#JCAT". Columns:
//   #JCAT Satcat Launch_Tag Piece Type Name PLName LDate Parent SDate Primary
//   DDate Status Dest Owner State Manufacturer Bus Motor Mass MassFlag DryMass
//   DryFlag TotMass TotFlag Length LFlag Diameter DFlag Span SpanFlag Shape
//   ODate Perigee PF Apogee AF Inc IF OpOrbit OQUAL AltNames
//
// JOIN KEY: the `Satcat` column IS the NORAD number (verified: row S00001 has
// Satcat "00001"). We join on it directly, avoiding conversion of GCAT's
// old-style Piece designators ("1957 ALP 1"). Objects GCAT tracks but NORAD
// does not have a non-numeric/blank Satcat and simply don't join.
//
// Licence: GCAT is CC-BY 4.0 — attribution required (see SOURCES.md).

import { getText } from '../http.mjs';

export const id = 'gcat';
export const licence = 'GCAT © Jonathan McDowell, planet4589.org/space/gcat — CC-BY 4.0';
const URL = 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv';

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// GCAT dates: "1998 Nov 20", "1957 Oct 4 1933", "1957 Dec 1 1000?", "2020 Jan?".
// Return YYYY-MM-DD only when year+month+day are all present and certain enough;
// otherwise null (SATCAT's precise date then wins via precedence).
function gcatDate(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})\s+([A-Z][a-z]{2})\s+(\d{1,2})\b/);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (!mon) return null;
  return `${m[1]}-${mon}-${String(m[3]).padStart(2, '0')}`;
}

// Numeric field or null. GCAT uses "-" and blanks for unknown; flags live in
// separate *Flag columns which we ignore in v1.
function num(s) {
  if (!s) return null;
  const t = s.trim().replace(/[?~*]/g, '');
  if (!t || t === '-') return null;
  const v = parseFloat(t);
  return Number.isNaN(v) ? null : v;
}

// Positive numeric field or null. GCAT stores 0 as a "no measurement" sentinel
// for physical quantities (mass, length, diameter, span), so treat any
// non-positive value as missing — otherwise it surfaces as "0 kg" / "Ø 0 m" and,
// via the nullish-coalescing fallback, blocks a real value in a later column.
function posNum(s) {
  const v = num(s);
  return v != null && v > 0 ? v : null;
}

function str(s) {
  const t = (s || '').trim();
  return t && t !== '-' ? t : null;
}

// OpOrbit code → coarse orbit class.
function orbitClass(op) {
  const t = (op || '').toUpperCase();
  if (!t || t === '-') return null;
  if (t.startsWith('LEO') || t.startsWith('LLEO')) return 'LEO';
  if (t.startsWith('MEO')) return 'MEO';
  if (t.startsWith('GEO') || t.startsWith('GSO')) return 'GEO';
  if (t.startsWith('HEO') || t.startsWith('GTO') || t.startsWith('MOL') || t.startsWith('EEO')) return 'HEO';
  return 'other';
}

// GCAT Status (lifecycle) → schema status.
function lifecycle(s) {
  const t = (s || '').trim().toUpperCase();
  if (!t) return null;
  if (t.startsWith('O')) return 'in-orbit';
  if (t.startsWith('L')) return 'landed';
  if (t.startsWith('R') || t.startsWith('D')) return 'decayed';
  return null;
}

export async function load(http = { getText }) {
  const { body, fetchedAt, fromCache } = await http.getText(URL);
  const lines = body.split(/\r?\n/);
  const headerLine = lines.find((l) => l.startsWith('#JCAT'));
  if (!headerLine) throw new Error('GCAT: header (#JCAT …) not found');
  const header = headerLine.replace(/^#/, '').split('\t').map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const byNorad = new Map();
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    const satcat = (f[col.Satcat] || '').trim();
    if (!/^\d+$/.test(satcat)) continue; // only NORAD-numbered objects join
    const norad = String(parseInt(satcat, 10));

    const mass = posNum(f[col.TotMass]) ?? posNum(f[col.Mass]) ?? posNum(f[col.DryMass]);
    const length = posNum(f[col.Length]);
    const diameter = posNum(f[col.Diameter]);
    const span = posNum(f[col.Span]);
    const dims = {};
    if (span != null) dims.span_m = span;
    if (length != null) dims.length_m = length;
    if (diameter != null) dims.diameter_m = diameter;

    const alt = str(f[col.AltNames]);
    byNorad.set(norad, {
      owner: str(f[col.Owner]),
      country: str(f[col.State]),
      launchDate: gcatDate(f[col.LDate]),
      decayDate: gcatDate(f[col.DDate]),
      massKg: mass,
      dimensions: Object.keys(dims).length ? dims : null,
      shape: str(f[col.Shape]),
      orbitClass: orbitClass(f[col.OpOrbit]),
      status: lifecycle(f[col.Status]),
      altNames: alt ? alt.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : null,
    });
  }
  return { records: byNorad, meta: { ok: true, fetchedAt, fromCache, rows: byNorad.size } };
}
