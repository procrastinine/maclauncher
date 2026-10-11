#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function parseVersion(value) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || (match[4] || '').split('.').some(id => /^0\d+$/.test(id))) throw new Error('package.json.version must be a valid semantic version.');
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') || [] };
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
function planRelease({ eventName, ref, event, version, previousVersion }) {
  const parsed = parseVersion(version);
  const result = { build: false, publish: false, version, tag: '', prerelease: parsed.pre.length > 0 };
  if (eventName === 'workflow_dispatch') return { ...result, build: true };
  if (eventName !== 'push' || event.deleted) return result;
  if (ref.startsWith('refs/tags/')) {
    if (ref !== `refs/tags/v${version}`) throw new Error('Release tag must match package.json.version.');
  } else {
    if (ref !== `refs/heads/${event.repository?.default_branch}`) return result;
    if (previousVersion === version) return result;
    if (previousVersion != null && compareVersions(version, previousVersion) <= 0) throw new Error('A release version must increase; build metadata alone is not an increment.');
  }
  return { ...result, build: true, publish: true, tag: `v${version}` };
}
function getPlan({ env = process.env, repoRoot = path.resolve(__dirname, '..'), tool = execFileSync } = {}) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  let previousVersion = null;
  if (env.GITHUB_EVENT_NAME === 'push' && !event.deleted && env.GITHUB_REF === `refs/heads/${event.repository?.default_branch}` && !/^0+$/.test(event.before || '')) {
    if (!/^[a-f0-9]{40}$/.test(event.before || '')) throw new Error('The previous push commit is unavailable.');
    const git = args => tool('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let previous;
    try { previous = git(['show', `${event.before}:package.json`]); }
    catch {
      // A root commit has no earlier package version to compare.
      if (git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).length !== 1) throw new Error('Cannot compare the previous package version; the push baseline must be available.');
    }
    if (previous != null) previousVersion = JSON.parse(previous).version;
  }
  return planRelease({ eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF || '', event, version, previousVersion });
}
function assetNames(manifest) {
  return [`MacLauncher-macOS-${manifest.arch}-runtimes-${manifest.maximumNativeMacOS}.zip`,
    'MacLauncher-source.tar.gz', 'MacLauncher-runtime-sources.tar.gz', 'native-payload-inventory.json',
    'build-manifest.json', 'source-pins.json', 'SHA256SUMS.txt', 'distribution-plan.json',
    'packaging-checks.json', 'LICENSE', 'ATTRIBUTIONS.md', 'RUNTIME_DISTRIBUTION.md', 'RELEASE_NOTES.md'];
}
async function verifyAssets(directory, { version, sha }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build-manifest.json'), 'utf8'));
  if (manifest.version !== version || manifest.sourceCommit !== sha || manifest.releaseTag !== `v${version}` || manifest.arch !== 'arm64' || !/^\d+\.\d+(?:\.\d+)?$/.test(manifest.maximumNativeMacOS || '')) {
    throw new Error('Release artifacts must match the exact source commit, version and Apple Silicon target.');
  }
  const names = assetNames(manifest);
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify([...names].sort())) throw new Error('Release asset set is incomplete or contains unexpected files.');
  for (const name of names) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.size === 0 || stat.size >= 2 * 1024 ** 3) throw new Error('Release assets must be nonempty regular files smaller than 2 GiB.');
  }
  const checksums = fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  const expected = new Set(names.slice(0, 3));
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || !expected.delete(match[2])) throw new Error('Release checksums must cover exactly the app and both source archives.');
    const hash = createHash('sha256');
    for await (const bytes of fs.createReadStream(path.join(directory, match[2]))) hash.update(bytes);
    if (hash.digest('hex') !== match[1]) throw new Error('Release archive checksum mismatch.');
  }
  if (expected.size) throw new Error('Release archive checksums are missing.');
  return names;
}
async function githubRequest(route, { env = process.env, tool = execFileSync, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Uploads can block for minutes. A separate gh process avoids reusing an HTTP
  // connection whose close event was delayed while the upload was running.
  let output;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      output = tool('gh', ['api', '--method', 'GET', `repos/${env.GITHUB_REPOSITORY}/${route}`,
        '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'], {
        env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 8 * 1024 ** 2
      });
      break;
    } catch (error) {
      const status = /\(HTTP (\d{3})\)\s*$/.exec(String(error.stderr || ''))?.[1];
      if (status === '404') return null;
      if (error.code === 'ENOENT') throw new Error('The release runner requires GitHub CLI.');
      if (attempt < 2 && (!status || ['500', '502', '503', '504'].includes(status))) {
        await pause(1000 * 2 ** attempt); continue;
      }
      const diagnostics = [status && `HTTP ${status}`, `attempt ${attempt + 1}/3`,
        error.code && `code ${error.code}`, Number.isInteger(error.status) && `exit ${error.status}`,
        error.signal && `signal ${error.signal}`].filter(Boolean).join(', ');
      let detail = String(error.stderr || error.message || 'No process diagnostics');
      if (env.GH_TOKEN) detail = detail.split(env.GH_TOKEN).join('[redacted token]');
      detail = detail.replace(/\/(?:Users|home|Volumes)\/[^\s"'<>]+/g, '[local path]')
        .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted credentials]@').trim().slice(0, 1000);
      const message = status ? 'GitHub release lookup failed' : 'GitHub release lookup failed after three attempts. Retry publication after the connection is restored';
      throw new Error(`${message} (${diagnostics}; GET ${route}). ${detail}`);
    }
  }
  try { return JSON.parse(output); }
  catch { throw new Error('GitHub release lookup returned invalid JSON.'); }
}
async function findRelease(tag, request) {
  const published = await request(`releases/tags/${encodeURIComponent(tag)}`);
  if (published) return published;
  // The tag endpoint documents published releases; authenticated listings include drafts.
  for (let page = 1; page <= 10; page++) {
    const releases = await request(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('GitHub release listing is unavailable.');
    const found = releases.find(release => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 100) return null;
  }
  throw new Error('GitHub release listing exceeds the lookup limit.');
}
async function publish({ directory, env = process.env, request = route => githubRequest(route, { env }), tool = execFileSync } = {}) {
  const version = env.RELEASE_VERSION, sha = env.GITHUB_SHA;
  const prerelease = parseVersion(version).pre.length > 0, tag = `v${version}`;
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') || !env.GH_TOKEN) throw new Error('Release publication requires an exact commit, repository and GitHub token.');
  const names = await verifyAssets(directory, { version, sha });
  const identities = new Map();
  for (const name of names) {
    const file = path.join(directory, name), hash = createHash('sha256');
    for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
    identities.set(name, { size: fs.statSync(file).size, digest: `sha256:${hash.digest('hex')}` });
  }
  const matches = (assets, name) => assets?.some(asset => asset.name === name && asset.state === 'uploaded' &&
    asset.size === identities.get(name).size && asset.digest === identities.get(name).digest);
  const existing = await findRelease(tag, request);
  let reference = await request(`git/ref/tags/${encodeURIComponent(tag)}`);
  for (let depth = 0; reference?.object?.type === 'tag' && depth < 8; depth++) reference = await request(`git/tags/${reference.object.sha}`);
  if (reference && (reference.object?.type !== 'commit' || reference.object.sha !== sha)) throw new Error('The release tag already points to another commit; it will not be moved.');
  if (existing && !existing.draft) {
    if (!reference || existing.assets?.length !== names.length || names.some(name => !matches(existing.assets, name))) throw new Error('The published release does not contain the complete expected asset set and checksums.');
    return { tag, published: true, unchanged: true };
  }
  if (existing && !reference && existing.target_commitish !== sha) throw new Error('The existing draft belongs to another source commit.');
  if (existing?.assets?.some(asset => !names.includes(asset.name))) throw new Error('The existing draft contains unexpected assets.');
  const gh = args => tool('gh', args, { env, stdio: 'inherit' });
  if (!existing) gh(['release', 'create', tag, '--repo', env.GITHUB_REPOSITORY, '--target', sha, '--draft', '--title', `MacLauncher ${tag}`, '--notes-file', path.join(directory, 'RELEASE_NOTES.md')]);
  const pending = names.filter(name => !matches(existing?.assets, name));
  if (pending.length) gh(['release', 'upload', tag, '--repo', env.GITHUB_REPOSITORY, '--clobber', ...pending.map(name => path.join(directory, name))]);
  const uploaded = await findRelease(tag, request);
  if (!Number.isSafeInteger(uploaded?.id) || !uploaded.draft || uploaded.assets?.length !== names.length || names.some(name => !matches(uploaded.assets, name))) throw new Error('GitHub has not received the complete release asset set with matching checksums.');
  gh(['api', '--method', 'PATCH', `repos/${env.GITHUB_REPOSITORY}/releases/${uploaded.id}`, '-F', 'draft=false', '-F', `prerelease=${prerelease}`, '-f', `make_latest=${prerelease ? 'false' : 'legacy'}`]);
  return { tag, published: true, unchanged: false };
}
async function main(args) {
  if (args[0] === 'plan' && args.length === 1) {
    const result = getPlan();
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
    return result;
  }
  if (args[0] === 'publish' && args.length === 2) return publish({ directory: path.resolve(args[1]) });
  throw new Error('Usage: node scripts/release.cjs plan|publish <asset-directory>');
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseVersion, compareVersions, planRelease, getPlan, assetNames, verifyAssets, githubRequest, findRelease, publish, main };
