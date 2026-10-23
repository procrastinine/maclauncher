import fs from 'node:fs';
import path from 'node:path';
import Content from './runtime-content.cjs';

export function runtimeContentPlugin({ root = path.resolve(import.meta.dirname, '..') } = {}) {
  root = fs.realpathSync(root);
  let config;
  const check = id => {
    if (typeof id !== 'string' || id.startsWith('\0')) return;
    const file = id.split('?')[0];
    if (path.isAbsolute(file)) {
      Content.assertOwnedImport(root, file);
      const relative = Content.ownedPath(root, file);
      if (relative === 'src/external' || relative?.startsWith('src/external' + path.sep))
        throw new Error('Renderer content excludes upstream source checkouts.');
    }
  };
  return {
    name: 'runtime-content-boundary', enforce: 'pre',
    configResolved(value) { config = value; },
    load(id) { check(id); return null; },
    buildStart() {
      if (!config.publicDir || !fs.existsSync(config.publicDir)) return;
      function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          check(file);
          if (entry.isDirectory()) walk(file);
        }
      }
      walk(config.publicDir);
    },
    generateBundle() { for (const id of this.getModuleIds()) check(id); },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        try {
          const url = decodeURIComponent((request.url || '').split('?')[0]);
          if (url.startsWith('/@fs/')) check(url.slice(4));
          else if (!url.startsWith('/@')) {
            check(path.resolve(config.root, '.' + url));
            if (config.publicDir) check(path.resolve(config.publicDir, '.' + url));
          }
          next();
        } catch (error) {
          response.statusCode = 403;
          response.end(error.message);
        }
      });
    }
  };
}
