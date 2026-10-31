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
test('Vite cache cleanup keeps the current set and the two most recently modified others', t => {
  const cacheRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'maclauncher-vite-cache-'));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const set = (checkout, layout, age) => {
    const file = path.join(cacheRoot, checkout, layout);
    fs.mkdirSync(path.join(file, 'deps'), { recursive: true });
    const at = new Date(Date.now() - age * 60_000); fs.utimesSync(file, at, at);
    return file;
  };
  const checkout = 'a'.repeat(16), clone = 'b'.repeat(16), removedClone = 'c'.repeat(16);
  const current = set(checkout, '1'.repeat(16), 50);
  const newest = set(clone, '2'.repeat(16), 1), second = set(checkout, '3'.repeat(16), 2);
  const older = set(checkout, '4'.repeat(16), 3), oldest = set(removedClone, '5'.repeat(16), 4);
  fs.mkdirSync(path.join(cacheRoot, 'unrelated'));
  fs.symlinkSync(newest, path.join(cacheRoot, checkout, '6'.repeat(16)));
  assert.deepEqual(dev.pruneViteCaches(cacheRoot, current).sort(), [older, oldest].sort());
  for (const file of [current, newest, second, path.join(cacheRoot, 'unrelated')]) assert.ok(fs.existsSync(file), file);
  assert.ok(fs.lstatSync(path.join(cacheRoot, checkout, '6'.repeat(16))).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(cacheRoot, removedClone)), false, 'an emptied checkout directory is removed');
  assert.deepEqual(dev.pruneViteCaches(cacheRoot, current), []);
  assert.deepEqual(dev.pruneViteCaches(path.join(cacheRoot, 'missing'), current), []);
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
    assert.equal(entry.headers.get('content-security-policy'), "script-src 'self' 'unsafe-inline'");
    const document = await (await fetch(result.url)).text();
    assert.match(document, /http-equiv="Content-Security-Policy"/);
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
      console.log('STUB_READY:'+JSON.stringify({url,runAsNode:process.env.ELECTRON_RUN_AS_NODE||null,
        nodeOptions:process.env.NODE_OPTIONS,arguments:process.argv.slice(2)}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `, { mode: 0o700 });
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'scripts/dev.mjs')], {
      cwd: temporary, timeout: 25000, env: { ...process.env,
        MACLAUNCHER_ELECTRON_PATH: stub, MACLAUNCHER_DEV_PORT: '0', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--stack-trace-limit=17' }
    });
    const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('STUB_READY:')).slice('STUB_READY:'.length));
    assert.equal(result.runAsNode, null);
    assert.equal(result.nodeOptions, '--stack-trace-limit=17', 'Electron receives the original options without an injected preload');
    assert.deepEqual(result.arguments, [path.join(root, 'scripts/dev-bootstrap.cjs'), '.']);
    await assert.rejects(fetch(result.url), /fetch failed/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('branded development Electron enforces the import boundary in its actual main process', {
  skip: process.platform !== 'darwin', timeout: 45000
}, async t => {
  const { prepareDevelopmentApp } = await import('../scripts/dev-app.mjs');
  const { resolveElectronBinary } = require('../src/core/electron-binary');
  const binary = await prepareDevelopmentApp({ electronBinary: resolveElectronBinary() });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-electron-guard-'));
  const source = fs.mkdtempSync(path.join(root, 'src', '.dev-guard-'));
  t.after(() => { fs.rmSync(temporary, { recursive: true, force: true }); fs.rmSync(source, { recursive: true, force: true }); });
  const canary = path.join(source, 'fixtures', 'canary.cjs');
  fs.mkdirSync(path.dirname(canary));
  fs.writeFileSync(canary, 'throw Error("Excluded fixture executed");');
  const entry = path.join(temporary, 'probe.cjs');
  fs.writeFileSync(entry, `
    const assert=require('node:assert/strict'), {app}=require('electron');
    app.setPath('userData', ${JSON.stringify(temporary)});
    app.setPath('sessionData', ${JSON.stringify(temporary)});
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(app.isPackaged, true, 'The branded app exercises Electron packaged-mode options');
    assert.equal(app.getAppPath(), ${JSON.stringify(root)});
    assert.equal(app.getVersion(), ${JSON.stringify(require('../package.json').version)});
    assert.equal(process.argv[1], ${JSON.stringify(entry)});
    require(${JSON.stringify(path.join(root, 'src/core/runtime-settings.js'))});
    assert.throws(()=>require(${JSON.stringify(canary)}), /Runtime content excludes test directory or fixture/);
    const {Worker}=require('node:worker_threads');
    const worker=new Worker(${JSON.stringify(`
      const assert=require('node:assert/strict');
      assert.equal(process.env.NODE_OPTIONS,undefined);
      assert.throws(()=>require(${JSON.stringify(canary)}),/Runtime content excludes test directory or fixture/);
      require('node:worker_threads').parentPort.postMessage('guarded');
    `)}, {eval:true});
    worker.once('error',error=>{console.error(error);app.whenReady().then(()=>app.exit(1));});
    worker.once('exit',code=>app.whenReady().then(()=>app.exit(code)));
    worker.once('message',value=>{
      assert.equal(value,'guarded');
      console.log('PASS development Electron main and worker import guard without NODE_OPTIONS');
    });
  `);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const { stdout, stderr } = await promisify(execFile)(binary, [path.join(root, 'scripts/dev-bootstrap.cjs'), entry], {
    cwd: root, env, timeout: 30000
  });
  assert.match(stdout, /PASS development Electron main and worker import guard without NODE_OPTIONS/);
  assert.doesNotMatch(stderr, /NODE_OPTION|ERROR:/);
});
