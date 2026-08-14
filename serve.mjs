// Minimal zero-dependency static server for local development.
// Usage: node serve.mjs   (then open http://localhost:8080)
//
// Hardening notes (this is a *development* server, not a production one):
//   - Binds to loopback (127.0.0.1) by default so the working tree — including
//     .git/ — is never exposed on the local network. Set HOST=0.0.0.0 only if
//     you deliberately need to reach it from another machine.
//   - Serves files strictly under the project root, and refuses dotfiles /
//     VCS metadata (e.g. .git/config, .env).
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Canonicalise a base directory (resolving any symlinks in it) so per-request
// containment checks compare against the real path. Falls back to the input if
// it can't be resolved yet (e.g. the directory is created later).
function canonicalRoot(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return normalize(dir);
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Served as application/octet-stream, a manifest is fetched but ignored and
  // the app is silently not installable, with nothing in the console to say so.
  '.webmanifest': 'application/manifest+json',
};

// Build a request handler that only ever serves files contained within `root`.
export function createOrbitServer(root = process.cwd()) {
  const realRoot = canonicalRoot(root);
  return http.createServer(async (req, res) => {
    const forbid = () => {
      res.writeHead(403);
      res.end('Forbidden');
    };
    try {
      let reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';

      // Primary guard: reject any traversal sequence or NUL byte in the request
      // path before it is ever turned into a filesystem path. With no `..` there
      // is no way for the resolved path to escape the project root.
      if (reqPath.includes('..') || reqPath.includes('\0')) return forbid();

      const file = normalize(join(root, reqPath));

      // Defence in depth: the resolved path must be the root itself or a genuine
      // descendant. Comparing against `root + sep` (not a bare `startsWith(root)`)
      // also stops a sibling directory that merely shares the prefix — e.g.
      // `<root>-secret` — from being reachable.
      if (file !== root && !file.startsWith(root + sep)) return forbid();

      // Refuse dotfiles / VCS metadata anywhere below the root (.git, .env, …).
      // Only the portion *below* root is inspected, so a project cloned inside a
      // hidden parent directory still serves normally.
      const rel = file.slice(root.length);
      if (rel.split(sep).some((seg) => seg.startsWith('.'))) return forbid();

      // Final guard against symlink escapes: readFile() follows symbolic links,
      // so a link *inside* root could still resolve to a file outside it. Compare
      // the fully-resolved real path against the canonical root before reading.
      const realFile = await realpath(file);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return forbid();

      const data = await readFile(realFile);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
}

// Start only when executed directly (`node serve.mjs`), so tests can import
// createOrbitServer without spinning up a listener on a fixed port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  createOrbitServer(process.cwd()).listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`Orbit running at http://${shown}:${port}`);
  });
}
