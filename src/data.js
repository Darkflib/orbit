// Static catalogue access. Prefer the independently hosted, atomically
// published data service, then fall back to the snapshot bundled with the app.
import {
  ORBIT_DATA_CATALOG_URL,
  ORBIT_DATA_FETCH_TIMEOUT_MS,
} from './constants.js';

function localUrl(path, baseURI) {
  return new URL(`data/${path}`, baseURI).href;
}

export async function fetchDataJson(
  path,
  {
    fetchImpl = globalThis.fetch,
    baseURI = globalThis.document?.baseURI,
    timeoutMs = ORBIT_DATA_FETCH_TIMEOUT_MS,
  } = {},
) {
  const sources = [ORBIT_DATA_CATALOG_URL(path)];
  if (baseURI) sources.push(localUrl(path, baseURI));

  const failures = [];
  for (const source of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(source, { mode: 'cors', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      failures.push(`${source}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Data unavailable (${failures.join('; ')})`);
}
