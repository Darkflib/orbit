// ---------------------------------------------------------------------------
// Search matching and ranking for the satellite combobox.
//
// Kept out of main.js because it is pure, and because the interesting part is
// not the DOM: the loaded 3D field and the catalogue index are two different
// sets of objects, and a query has to be answered from both. The field holds
// only what can be propagated; the catalogue holds everything CelesTrak lists,
// including the ~975 objects with no element set at all (USA 224, NORAD 37348).
//
// Consulting the catalogue only when the field came up empty looks like a sound
// optimisation and is not: with the default Starlink layer loaded, the query
// "37348" substring-matches the *name* STARLINK-37348 (NORAD 68737), so the
// field is non-empty, the catalogue is never asked, and the object the user
// typed the catalog number of is silently absent while a different satellite is
// offered in its place. Both sets are therefore always searched, merged, and
// ranked together — which is also why ranking lives here rather than being
// implied by concatenation order.
// ---------------------------------------------------------------------------

// Most matches the merged list will offer.
export const SEARCH_LIMIT = 40;
// Most catalogue-only matches to merge in. Small: they cannot be shown in 3D,
// so they are an answer to "where is it", not a browse list — the Catalogue
// browser is that.
export const CATALOGUE_SEARCH_LIMIT = 12;
// Shortest query worth spending the catalogue index (~5 MB, fetched once and
// memoised) on.
export const CATALOGUE_SEARCH_MIN = 3;

export function normaliseQuery(query) {
  return String(query ?? '').trim().toLowerCase();
}

// How well an option answers the query. Lower is better.
//
// An exact catalog number or name is what the user asked for and outranks every
// loose substring hit — without this, "37348" buries USA 224 under STARLINK-37348
// and every other Starlink whose name happens to contain those digits.
export function rankOption(opt, query) {
  const q = normaliseQuery(query);
  const name = String(opt.name ?? '').toLowerCase();
  const norad = String(opt.norad ?? '');
  if (norad === q) return 0;
  if (name === q) return 1;
  if (name.startsWith(q)) return 2;
  if (norad.startsWith(q)) return 3;
  return 4;
}

// Rank, then alphabetical, then field-before-catalogue: on an otherwise even
// tie the one that can actually be selected in 3D goes first.
export function sortOptions(options, query) {
  return options
    .map((opt, i) => ({ opt, i, rank: rankOption(opt, query) }))
    .sort((a, b) => a.rank - b.rank
      || String(a.opt.name).localeCompare(String(b.opt.name))
      || (a.opt.kind === b.opt.kind ? a.i - b.i : (a.opt.kind === 'field' ? -1 : 1)))
    .map((entry) => entry.opt);
}

// Catalogue-index rows matching the query, as search options. Rows are treated
// as untrusted shapes: the index is fetched, and a malformed one must degrade
// to "no match" rather than throw. `dataStatus` is sparse — written only when
// non-null, and absent altogether on a tree published before that field shipped
// — so it is carried through as-is and merely annotates the row.
export function catalogueCandidates(index, query, limit = CATALOGUE_SEARCH_LIMIT) {
  const q = normaliseQuery(query);
  if (q.length < CATALOGUE_SEARCH_MIN || !Array.isArray(index)) return [];
  const matches = [];
  for (const row of index) {
    const norad = String(row?.norad ?? '');
    const name = String(row?.name ?? '') || `NORAD ${norad}`;
    if (!name.toLowerCase().includes(q) && !norad.startsWith(q)) continue;
    matches.push({ kind: 'catalogue', norad, name, dataStatus: row?.dataStatus ?? null });
  }
  return sortOptions(matches, q).slice(0, limit);
}

// Merge the two result sets, de-duplicating by NORAD id. A field option wins a
// duplicate: it is the same object, and only that one can be shown in 3D.
export function mergeCandidates(fieldOptions, catalogueOptions, query, limit = SEARCH_LIMIT) {
  const seen = new Set(fieldOptions.map((opt) => String(opt.norad ?? '')));
  const merged = fieldOptions.concat(
    catalogueOptions.filter((opt) => {
      const norad = String(opt.norad ?? '');
      return norad !== '' && !seen.has(norad);
    }),
  );
  return sortOptions(merged, query).slice(0, limit);
}
