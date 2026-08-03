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
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

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
};

// Build a request handler that only ever serves files contained within `root`.
export function createOrbitServer(root = process.cwd()) {
  return http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent((req.url || '/').split('?')[0]);
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path));

      // Containment: allow the root itself or a genuine descendant. Comparing
      // against `root + sep` (not a bare `startsWith(root)`) stops a sibling
      // directory that merely shares the prefix — e.g. `<root>-secret` — from
      // being reachable via path traversal.
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      // Refuse dotfiles / VCS metadata anywhere below the root (.git, .env, …).
      // Only the portion *below* root is inspected, so a project cloned inside a
      // hidden parent directory still serves normally.
      const rel = file.slice(root.length);
      if (rel.split(sep).some((seg) => seg.startsWith('.'))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      const data = await readFile(file);
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
