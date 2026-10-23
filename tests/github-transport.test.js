const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { Readable } = require('node:stream'), { EventEmitter } = require('node:events');
const Transport = require('../src/modules/shared/runtime/github-transport'), Github = require('../src/modules/shared/runtime/github-releases');
const Web = require('../src/modules/shared/runtime/github-web');
const { BackendWorkerClient } = require('../src/core/backend-worker-client');
const token = 'ghp_example_transport_token_1234567890', digest = 'c'.repeat(64), commit = 'a'.repeat(40), annotation = 'b'.repeat(40);
const response = data => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) });
const pkt = text => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
const refs = Buffer.from(pkt('# service=git-upload-pack\n') + '0000' + pkt(annotation + ' refs/tags/v1.2.3\0multi_ack\n') + pkt(commit + ' refs/tags/v1.2.3^{}\n') + '0000');
const releases = '<section data-release-anchor="release-v1.2.3"><h2>Runtime 1.2.3</h2><relative-time datetime="2026-10-08T12:00:00Z"></relative-time><div data-test-selector="body-content">Version: v1.2.3<br>Commit: <a href="/owner/runtime/commit/' + commit + '"><tt>aaaaaaa</tt></a></div><include-fragment src="https://github.com/owner/runtime/releases/expanded_assets/v1.2.3"></include-fragment></section>';
const assets = '<li><a href="/owner/runtime/releases/download/v1.2.3/runtime-macos.zip">Download</a><clipboard-copy value="sha256:' + digest + '"></clipboard-copy><span>1 MB</span></li>';
const missing = async () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }); };

test('transport performs no auth or network IO until an explicit request', async () => {
 let calls = 0; const transport = Transport.createGithubTransport({ env: {}, runCommand: async () => { calls++; return { stdout: token }; }, request: async () => { calls++; return response([]); } });
 assert.deepEqual(transport.peekAuthenticationStatus(), { checked: false, available: false, authenticated: false }); assert.equal(calls, 0);
 await transport.request('https://api.github.com/repos/owner/runtime/releases'); assert.equal(calls, 2);
});
test('two actual backend workers share one credential lookup and one concurrent request without receiving the credential', { timeout: 5000 }, async t => {
 let authCalls = 0, requests = 0, arrivals = 0, bothArrived; const releases = [];
 const waitingForBoth = new Promise(resolve => { bothArrived = resolve; });
 const transport = Transport.createGithubTransport({ env: {}, runCommand: async (_file, args) => { authCalls++; assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']); return { stdout: token + '\n' }; }, request: async (url, options) => { requests++; assert.equal(options.headers.Authorization, 'Bearer ' + token); await new Promise(resolve => url.includes('page=3') ? releases.push(resolve) : setTimeout(resolve, 50)); return response({ url }); } });
 const clients = [0, 1].map(() => { const broker = Transport.createBroker(transport), client = new BackendWorkerClient({ workerPath: path.join(__dirname, 'fixtures/github-transport-worker.cjs'), callbacks: { githubFetch: (...args) => { if (args[1].includes('page=3') && ++arrivals === 2) bothArrived(); return broker.request(...args); }, githubCancel: id => broker.cancel(id), githubAuthStatus: () => broker.authenticationStatus() } }); t.after(async () => { broker.close(); await client.close(); }); return client; });
 await Promise.all(clients.map(client => client.request('peek'))); assert.equal(authCalls, 0);
 const first = await Promise.all(clients.map(client => client.request('fetch', 'https://api.github.com/repos/owner/runtime/releases?page=1')));
 assert.equal(authCalls, 1); assert.equal(requests, 1); assert.ok(first.every(r => r.status === 200)); assert.doesNotMatch(JSON.stringify(first), /ghp_/);
 await Promise.all(clients.map(client => client.request('fetch', 'https://api.github.com/repos/owner/runtime/releases?page=2'))); assert.equal(requests, 2); assert.equal(authCalls, 1);
 const canceled = clients[0].request('fetch', 'https://api.github.com/repos/owner/runtime/releases?page=3');
 const surviving = clients[1].request('fetch', 'https://api.github.com/repos/owner/runtime/releases?page=3');
 const rejected = assert.rejects(canceled, { name: 'AbortError' });
 await waitingForBoth; await clients[0].request('abortFetches'); await rejected; releases.forEach(resolve => resolve());
 assert.equal((await surviving).status, 200); assert.equal(requests, 3); assert.equal(authCalls, 1);
 assert.deepEqual(await clients[0].request('auth'), { checked: true, available: true, authenticated: true });
});
test('selected fallback assets alone receive exact-size requests and checksum-bound HEAD results are cached', async () => {
 let clock = 0, heads = 0, apiCalls = 0, currentDigest = digest;
 const unrelated = assets.replaceAll('runtime-macos.zip', 'runtime-windows.zip');
 const transport = Transport.createGithubTransport({ now: () => clock, env: {}, runCommand: missing, request: async (url, options) => {
  if (new URL(url).hostname === 'api.github.com') { apiCalls++; return { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' }, body: Buffer.from('{}') }; }
  if (options.method === 'HEAD') { heads++; assert.match(url, /runtime-macos.zip$/); return { status: 200, headers: { 'content-length': '42' }, body: Buffer.alloc(0) }; }
  return { status: 200, headers: {}, body: Buffer.from(url.includes('expanded_assets') ? (assets + unrelated).replaceAll(digest, currentDigest) : releases) };
 } });
 const fetch = () => Github.fetchGithubReleases({ owner: 'owner', repo: 'runtime', request: transport.request, assetFilter: asset => asset.name === 'runtime-macos.zip' });
 const first = await fetch(); assert.equal(first[0].assets[0].size, 42); assert.equal(first[0].assets[1].size, undefined); assert.equal(heads, 1);
 clock += 20000; await fetch(); assert.equal(heads, 1); assert.equal(apiCalls, 1);
 clock += 20000; currentDigest = 'd'.repeat(64); await fetch(); assert.equal(heads, 2); assert.equal(apiCalls, 1);
});
test('numeric API pagination can continue from public web pages after the quota changes', async () => {
 const seen = [];
 const transport = Transport.createGithubTransport({ env: {}, runCommand: missing, request: async url => {
  seen.push(url);
  if (url.includes('/repos/owner/runtime/')) return { ...response([{ tag_name: 'v2' }]), headers: { link: '<https://api.github.com/repositories/123/releases?per_page=100&page=2>; rel="next"' } };
  if (url.includes('/repositories/123/')) return { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: Buffer.from('{}') };
  return { status: 200, headers: {}, body: Buffer.from(url.includes('expanded_assets') ? '' : releases) };
 } });
 const rows = await Github.fetchGithubReleases({ owner: 'owner', repo: 'runtime', request: transport.request });
 assert.deepEqual(rows.map(row => row.tag_name), ['v2', 'v1.2.3']); assert.ok(seen.includes('https://github.com/owner/runtime/releases?page=2'));
});
test('public release pagination and Atom commit fallback keep their original bounds and exact identities', async () => {
 const read = async url => ({ status: 200, headers: {}, body: Buffer.from(url.endsWith('commits.atom')
  ? '<feed><entry><link href="https://github.com/owner/runtime/commit/' + commit + '"/><title>Fix &amp; support</title><updated>2026-10-08T12:00:00Z</updated></entry></feed>'
  : url.includes('expanded_assets') ? '' : releases + '<a class="next_page" rel="next" href="?page=2">Next</a>') });
 const fallback = Web.createWebFallback(read);
 const page = await fallback('https://api.github.com/repos/owner/runtime/releases?page=1'); assert.match(page.headers.link, /page=2/);
 const commits = JSON.parse((await fallback('https://api.github.com/repos/owner/runtime/commits?per_page=1')).body);
 assert.equal(commits.length, 1); assert.equal(commits[0].sha, commit); assert.equal(commits[0].commit.message, 'Fix & support');
 const atom = '<feed><entry><link href="https://github.com/owner/runtime/releases/tag/v1.2.3"/><title>1.2.3</title><updated>2026-10-08T12:00:00Z</updated><content>&lt;p&gt;Changes&lt;/p&gt;</content></entry></feed>';
 const release = await Web.createWebFallback(async url => ({ status: 200, headers: {}, body: Buffer.from(url.endsWith('releases.atom') ? atom : '') }))('https://api.github.com/repos/owner/runtime/releases');
 assert.equal(JSON.parse(release.body)[0].body, 'Changes');
 const exact = Web.createWebFallback(async url => { assert.equal(url, 'https://github.com/owner/runtime/commits/' + commit + '.atom'); return read('https://github.com/owner/runtime/commits.atom'); });
 assert.equal(JSON.parse((await exact('https://api.github.com/repos/owner/runtime/commits/' + commit)).body).sha, commit);
 await assert.rejects(Web.createWebFallback(() => read('https://github.com/owner/runtime/commits.atom'))('https://api.github.com/repos/owner/runtime/commits/' + 'd'.repeat(40)), /exact public identity/);
});
test('rolling tags refresh after the shared cache expires without another authentication lookup', async () => {
 let clock = 0, advertised = refs, authCalls = 0;
 const transport = Transport.createGithubTransport({ now: () => clock, env: {}, runCommand: async () => { authCalls++; return missing(); }, request: async url => new URL(url).hostname === 'api.github.com'
  ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' }, body: Buffer.from('{}') }
  : { status: 200, headers: {}, body: advertised } });
 const resolve = () => Github.resolveGithubTagCommit({ owner: 'owner', repo: 'runtime', tag: 'v1.2.3', request: transport.request });
 assert.equal(await resolve(), commit); advertised = Buffer.from(refs.toString().replaceAll(commit, 'd'.repeat(40))); clock += 20000;
 assert.equal(await resolve(), 'd'.repeat(40)); assert.equal(authCalls, 1);
});
test('a rejected token is retired for the session without another CLI invocation or credential disclosure', async () => {
 let authCalls = 0; const authorizations = [];
 const transport = Transport.createGithubTransport({ cacheMs: 0, env: {}, runCommand: async () => { authCalls++; return { stdout: token }; }, request: async (_url, options) => {
  authorizations.push(options.headers.Authorization); return options.headers.Authorization ? { status: 401, headers: {}, body: Buffer.from('{}') } : response([]);
 } });
 await transport.request('https://api.github.com/repos/owner/runtime/releases'); await transport.request('https://api.github.com/repos/owner/runtime/tags');
 assert.deepEqual(authorizations, ['Bearer ' + token, undefined, undefined]); assert.equal(authCalls, 1);
 assert.deepEqual(await transport.authenticationStatus(), { checked: true, available: true, authenticated: false });
});
test('known API reset and Retry-After windows suppress repeated quota requests', async () => {
 let clock = 0, apiCalls = 0;
 const transport = Transport.createGithubTransport({ now: () => clock, cacheMs: 0, env: {}, runCommand: missing, request: async url => {
  if (new URL(url).hostname === 'api.github.com') { apiCalls++; return { status: 429, headers: { 'retry-after': '300', 'x-ratelimit-reset': '120' }, body: Buffer.from('{}') }; }
  return { status: 200, headers: {}, body: Buffer.from(url.includes('expanded_assets') ? '' : releases) };
 } });
 const read = () => transport.request('https://api.github.com/repos/owner/runtime/releases');
 await read(); clock = 61000; await read(); clock = 180000; await read(); assert.equal(apiCalls, 1);
 clock = 301000; await read(); assert.equal(apiCalls, 2);
});
test('metadata concurrency is bounded and canceled queued requests never enter the network', async () => {
 let active = 0, maximum = 0, called = 0; const resolvers = [];
 const transport = Transport.createGithubTransport({ env: {}, runCommand: missing, request: async () => { called++; maximum = Math.max(maximum, ++active); await new Promise(resolve => resolvers.push(resolve)); active--; return response([]); } });
 const controller = new AbortController();
 const tasks = Array.from({ length: 8 }, (_, n) => transport.request('https://github.com/owner/runtime/releases?page=' + n));
 const canceled = transport.request('https://github.com/owner/runtime/releases?page=9', { signal: controller.signal });
 await new Promise(done => setImmediate(done)); assert.equal(called, 8); controller.abort(); await assert.rejects(canceled, { name: 'AbortError' });
 resolvers.forEach(resolve => resolve()); await Promise.all(tasks); assert.equal(maximum, 8); assert.equal(called, 8);
 await assert.rejects(transport.request('https://github.com/owner/runtime', { maxBytes: 0 }), /limits/);
});
test('missing gh is cached while official web fallback retains exact digests, HEAD sizes and peeled commits', async () => {
 let authCalls = 0, apiCalls = 0, heads = 0;
 const transport = Transport.createGithubTransport({ env: {}, runCommand: async () => { authCalls++; return missing(); }, request: async (url, options) => {
  const u = new URL(url); if (u.hostname === 'api.github.com') { apiCalls++; return { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: Buffer.from('{"message":"API rate limit exceeded"}') }; }
  assert.equal(options.headers.Authorization, undefined);
  if (url.includes('info/refs')) return { status: 200, headers: {}, body: refs };
  if (options.method === 'HEAD') { heads++; return { status: 200, headers: { 'content-length': '12345' }, body: Buffer.alloc(0) }; }
  return { status: 200, headers: {}, body: Buffer.from(url.includes('expanded_assets') ? assets : releases) };
 } });
 const found = await Github.fetchGithubReleases({ owner: 'owner', repo: 'runtime', request: transport.request });
 assert.equal(found[0].assets[0].size, 12345); assert.equal(found[0].assets[0].digest, 'sha256:' + digest); assert.match(found[0].body, new RegExp('Commit: ' + commit));
 assert.equal(await Github.resolveGithubTagCommit({ owner: 'owner', repo: 'runtime', tag: 'v1.2.3', request: transport.request }), commit);
 assert.equal((await Github.fetchGithubTags({ owner: 'owner', repo: 'runtime', request: transport.request }))[0].commit.sha, commit);
 assert.equal(authCalls, 1); assert.equal(apiCalls, 1); assert.equal(heads, 1);
});
test('canceling one subscriber never cancels another worker subscriber and abandoned calls abort the network', async () => {
 let canceled = 0, resolve;
 const transport = Transport.createGithubTransport({ env: {}, runCommand: missing, cacheMs: 0, request: (_url, options) => new Promise((done, reject) => { resolve = done; options.signal.addEventListener('abort', () => { canceled++; reject(Object.assign(Error('Canceled'), { name: 'AbortError' })); }); }) });
 const a = new AbortController(), b = new AbortController(), url = 'https://api.github.com/repos/owner/runtime/releases';
 const first = transport.request(url, { signal: a.signal }), second = transport.request(url, { signal: b.signal });
 await new Promise(done => setImmediate(done)); a.abort(); await assert.rejects(first, { name: 'AbortError' }); assert.equal(canceled, 0); resolve(response([])); await second;
 const third = transport.request(url, { signal: b.signal }); await new Promise(done => setImmediate(done)); b.abort(); await assert.rejects(third, { name: 'AbortError' }); assert.equal(canceled, 1);
});
test('credentials cannot leave the official API origin during redirects or through caller headers', async () => {
 for (const value of ['http://api.github.com/repos/a/b/releases', 'https://api.github.com.evil.invalid/', 'https://secret@github.com/a/b']) assert.throws(() => Transport.officialUrl(value), /official/);
 const calls = [];
 const fake = (url, options, callback) => { calls.push({ url: url.href, headers: options.headers }); const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => queueMicrotask(() => { const res = Readable.from([]); res.statusCode = calls.length === 1 ? 302 : 200; res.headers = calls.length === 1 ? { location: 'https://release-assets.githubusercontent.com/package' } : { 'content-length': '123' }; callback(res); }); req.destroy = error => { if (error) req.emit('error', error); req.emit('close'); }; return req; };
 await Transport.requestOfficial('https://api.github.com/repos/a/b/releases/assets/1', { method: 'HEAD', headers: { Authorization: 'Bearer ' + token, Cookie: 'private' }, httpsRequest: fake });
 assert.equal(calls[0].headers.Authorization, 'Bearer ' + token); assert.equal(calls[1].headers.Authorization, undefined); assert.equal(calls[1].headers.Cookie, undefined);
 const t = Transport.createGithubTransport({ env: {}, runCommand: missing, request: async (_url, options) => { assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined); return response([]); } });
 await t.request('https://api.github.com/repos/a/b/releases', { headers: { Authorization: 'caller-secret', Cookie: 'caller-secret' } });
});
test('Git advertisements and public asset metadata never invent missing hashes or external locations', () => {
 assert.equal(Web.parseRefs(refs).get('refs/tags/v1.2.3^{}'), commit);
 assert.throws(() => Web.parseRefs(Buffer.from('fffftruncated')), /truncated/);
 assert.equal(Web.parseAssets(assets.replace('sha256:' + digest, 'sha512:unknown'), { owner: 'owner', repo: 'runtime', tag: 'v1.2.3' })[0].digest, null);
 assert.equal(Web.parseAssets(assets.replace('/owner/runtime/releases/download/', 'https://evil.invalid/'), { owner: 'owner', repo: 'runtime', tag: 'v1.2.3' }).length, 0);
 assert.throws(() => Web.parseReleases(releases.replace('github.com/owner/runtime/releases/expanded_assets', 'evil.invalid/owner/runtime/releases/expanded_assets'), { owner: 'owner', repo: 'runtime' }), /escaped/);
});
