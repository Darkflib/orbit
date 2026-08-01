// Conditional-GET helper for the enrichment build.
//
// Persists each URL's ETag / Last-Modified and the last-good body under
// .cache/enrich/ so repeat runs send If-None-Match / If-Modified-Since and
// reuse the cached body on a 304 — saving the upstream's bandwidth and making
// no-op runs cheap. Text sources only (SATCAT CSV, GCAT TSV); the magnitude
// file is read from a vendored copy, not fetched here.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '..', '.cache', 'enrich');

// A browser-ish UA + referer; some hosts (mmccants) 404 bare programmatic gets.
const UA = 'orbit-enrichment/1 (+https://github.com/Darkflib/orbit)';

function slug(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

// Fetch a text resource with conditional-GET caching.
// Returns { body, fromCache, status, fetchedAt }.
export async function getText(url, { referer } = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const metaPath = join(CACHE_DIR, slug(url) + '.meta.json');
  const bodyPath = join(CACHE_DIR, slug(url) + '.body');

  let meta = null;
  try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* first run */ }

  const headers = { 'User-Agent': UA };
  if (referer) headers.Referer = referer;
  if (meta?.etag) headers['If-None-Match'] = meta.etag;
  if (meta?.lastModified) headers['If-Modified-Since'] = meta.lastModified;

  const res = await fetch(url, { headers, redirect: 'follow' });

  if (res.status === 304 && meta) {
    const body = await readFile(bodyPath, 'utf8');
    return { body, fromCache: true, status: 304, fetchedAt: meta.fetchedAt };
  }
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);

  const body = await res.text();
  const fetchedAt = new Date().toISOString();
  await writeFile(bodyPath, body);
  await writeFile(metaPath, JSON.stringify({
    etag: res.headers.get('etag') || null,
    lastModified: res.headers.get('last-modified') || null,
    fetchedAt,
  }));
  return { body, fromCache: false, status: res.status, fetchedAt };
}

// Minimal CSV row splitter that honours double-quoted fields (SATCAT has none
// today, but names could gain commas). Not a full RFC-4180 parser — no embedded
// newlines — which the sources never use.
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
