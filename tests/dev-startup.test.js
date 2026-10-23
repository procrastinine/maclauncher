const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
let dev;
const root = path.resolve(__dirname, '..');
test.before(async () => { dev = await import('../scripts/dev-server.mjs'); });
function fakeServer(overrides = {}) {
  return { httpServer: { address: () => ({ port: 6199 }) },
    environments: { client: { moduleGraph: { getModuleByUrl: async () => ({ importedModules: new Set() }) } } },
    transformRequest: async () => ({ code: 'export const ready=true' }), waitForRequestsIdle: async () => {},
    listen: async () => {}, close: async () => {}, ...overrides };
}
const page = (status = 200, type = 'text/javascript') => new Response('export const ready=true', { status, headers: { 'content-type': type } });
const fetchPage = async url => url.pathname === '/' ? new Response('<div id="root"></div><script src="/src/main.tsx"></script>', { headers: { 'content-type': 'text/html' } }) : page();
test('startup surfaces nested module errors before Electron can be launched', async () => {
  let closed = false;
  const server = fakeServer({
    close: async () => { closed = true; },
    transformRequest: async url => { if (url === '/broken.ts') throw Error('Missing React dependency'); return { code: '' }; },
    environments: { client: { moduleGraph: { getModuleByUrl: async url => ({ importedModules: new Set(url === '/src/main.tsx'
      ? [{ url: '/broken.ts', type: 'js' }] : []) }) } } }
  });
  await assert.rejects(dev.startLauncherDevServer({ root, createViteServer: async () => server,
    prepare: (server, url, options) => dev.prepareRenderer(server, url, { ...options, fetchPage }) }), /Missing React dependency/);
  assert.equal(closed, true);
});
test('HTTP failures and HTML module fallbacks cannot pass readiness', async () => {
  await assert.rejects(dev.prepareRenderer(fakeServer(), 'http://127.0.0.1:6199/', {
    fetchPage: async url => url.pathname === '/src/main.tsx' ? page(500) : fetchPage(url)
  }), /HTTP 500/);
  await assert.rejects(dev.prepareRenderer(fakeServer(), 'http://127.0.0.1:6199/', {
    fetchPage: async url => url.pathname === '/src/main.tsx' ? page(200, 'text/html') : fetchPage(url)
  }), /HTML fallback/);
  await assert.rejects(dev.prepareRenderer(fakeServer(), 'http://127.0.0.1:6199/', {
    fetchPage: async () => new Response('An unrelated application', { headers: { 'content-type': 'text/html' } })
  }), /MacLauncher page/);
});
test('startup uses the owned bound port and waits until every module and HTTP check completes', async () => {
  const checked = []; let closed = false;
  const server = fakeServer({ close: async () => { closed = true; } });
  const result = await dev.startLauncherDevServer({ root, port: 5174,
    createViteServer: async options => { assert.equal(options.server.strictPort, false); return server; },
    prepare: (server, url, options) => dev.prepareRenderer(server, url, { ...options,
      fetchPage: async url => { checked.push(url.pathname); return fetchPage(url); } })
  });
  assert.equal(result.url, 'http://127.0.0.1:6199/');
  assert.equal(result.modules, 1);
  assert.deepEqual(new Set(checked), new Set(['/', '/@vite/client', '/src/main.tsx']));
  assert.equal(closed, false); await result.server.close();
});
test('timeouts and listen errors close only the owned dev server', async () => {
  let closed = 0;
  await assert.rejects(dev.startLauncherDevServer({ root, timeoutMs: 20,
    createViteServer: async () => fakeServer({ close: async () => { closed += 1; } }),
    prepare: async () => new Promise(() => {})
  }), /within 0.02 seconds/);
  await assert.rejects(dev.startLauncherDevServer({ root,
    createViteServer: async () => fakeServer({ close: async () => { closed += 1; }, listen: async () => { throw Error('cannot bind'); } })
  }), /cannot bind/);
  assert.equal(closed, 2);
});
test('dependency caches describe the actual local installation without changing metadata', () => {
  const file = path.join(root, 'node_modules', '.modules.yaml');
  const before = fs.readFileSync(file);
  assert.match(dev.dependencyLayoutKey(root), /^[0-9a-f]{16}$/);
  assert.equal(dev.dependencyLayoutKey(root), dev.dependencyLayoutKey(root));
  assert.deepEqual(fs.readFileSync(file), before);
});
test('real Vite cold startup prepares React and leaves an occupied server running', { timeout: 30000 }, async () => {
  const existing = http.createServer((request, response) => response.end('existing server'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  const occupied = existing.address().port; let result;
  try {
    result = await dev.startLauncherDevServer({ root, port: occupied });
    assert.notEqual(new URL(result.url).port, String(occupied));
    assert.ok(result.modules > 20, 'The actual renderer imports are ready');
    const entry = await fetch(new URL('/src/main.tsx', result.url));
    assert.equal(entry.status, 200); assert.match(await entry.text(), /react/);
    assert.equal(await (await fetch(`http://127.0.0.1:${occupied}/`)).text(), 'existing server');
    await result.server.close(); result = null;
    assert.equal(await (await fetch(`http://127.0.0.1:${occupied}/`)).text(), 'existing server');
  } finally { await result?.server.close(); await new Promise(resolve => existing.close(resolve)); }
});
test('the dev command hands a ready page to Electron and closes its server on exit', { timeout: 30000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-dev-startup-'));
  const stub = path.join(temporary, 'electron-stub');
  fs.writeFileSync(stub, `#!/usr/bin/env node
    (async()=>{ const url=process.env.ELECTRON_START_URL;
      const response=await fetch(url); const body=await response.text();
      if(!response.ok||!body.includes('id="root"'))throw Error('Page was not ready');
      const module=await fetch(new URL('/src/main.tsx',url));
      if(!module.ok)throw Error('Entry module was not ready');
      console.log('STUB_READY:'+JSON.stringify({url,runAsNode:process.env.ELECTRON_RUN_AS_NODE||null}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `, { mode: 0o700 });
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'scripts/dev.mjs')], {
      cwd: temporary, timeout: 25000, env: { ...process.env,
        MACLAUNCHER_ELECTRON_PATH: stub, MACLAUNCHER_DEV_PORT: '0', ELECTRON_RUN_AS_NODE: '1' }
    });
    const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('STUB_READY:')).slice('STUB_READY:'.length));
    assert.equal(result.runAsNode, null);
    await assert.rejects(fetch(result.url), /fetch failed/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
