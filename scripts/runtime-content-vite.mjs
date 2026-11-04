import fs from 'node:fs';
import path from 'node:path';
import Content from './runtime-content.cjs';

export function runtimeContentPlugin({ root = path.resolve(import.meta.dirname, '..') } = {}) {
  root = fs.realpathSync(root);
  let config;
  const excluded = id => {
    if (typeof id !== 'string' || id.startsWith('\0')) return false;
    const file = id.split('?')[0];
    if (!path.isAbsolute(file)) return false;
    const paths = [file];
    try { paths.push(fs.realpathSync(file)); } catch {}
    return paths.some(file => {
      const relative = Content.ownedPath(root, file);
      return relative && (Content.excludedReason(relative) || relative === 'src/external' || relative.startsWith('src/external' + path.sep));
    });
  };
  return {
    name: 'runtime-content-boundary', enforce: 'pre',
    config() { return { build: { copyPublicDir: false } }; },
    configResolved(value) { config = value; },
    load(id) { return excluded(id) ? 'export {};' : null; },
    buildStart() {
      if (!config.publicDir || !fs.existsSync(config.publicDir)) return;
      const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (excluded(file)) continue;
          if (fs.statSync(file).isDirectory()) walk(file);
          else this.emitFile({ type: 'asset', fileName: path.relative(config.publicDir, file).split(path.sep).join('/'), source: fs.readFileSync(file) });
        }
      };
      walk(config.publicDir);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        try {
          const url = decodeURIComponent((request.url || '').split('?')[0]);
          if (url.startsWith('/@fs/') ? excluded(url.slice(4)) : !url.startsWith('/@') &&
              (excluded(path.resolve(config.root, '.' + url)) || config.publicDir && excluded(path.resolve(config.publicDir, '.' + url)))) {
            response.statusCode = 403;
            response.end('Content is excluded from the renderer.');
            return;
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
