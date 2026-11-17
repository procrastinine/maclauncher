// Copyright (c) MacLauncher contributors. MIT license.
const Upstream = require('../../runtime/upstream'), Cache = require('../../runtime/runtime-catalog');
const Static = require('./model-source.json'), Models = require('./models');
const RAW = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([a-f0-9]{40})\/(.+)$/;
const safe = name => typeof name === 'string' && name.length <= 256 && !/[\0/\\]/.test(name);
const validEntry = row => safe(row?.version) && row.version.length <= 240 && typeof row.label === 'string' &&
  typeof row.repository === 'string' && /^https:\/\/(?:github\.com|huggingface\.co|pypi\.nvidia\.com)\//.test(row.repository) && row.files?.length > 0 && row.files.length <= 32 &&
  row.files.every(file => safe(file.file) && /^https:\/\//.test(file.url) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= Models.MAX_WEIGHTS &&
    (/^[a-f0-9]{64}$/.test(file.sha256 || '') || /^[a-f0-9]{40}$/.test(file.gitBlobSha1 || '') ||
      file.sha256===undefined&&Boolean(Upstream.readDigest(file.digest)) || file.sha256===undefined&&file.digest===undefined&&
      ['archive-model','prepared-model-archive'].includes(row.kind)&&file.file===row.archiveFile&&file.integrity==='recorded-local'));
function read(userDataDir) { return Cache.readRuntimeCatalog({userDataDir, managerId: Models.ID, sourceId: 'upstream', validateEntry: validEntry}); }
function sources(userDataDir) { const rows = read(userDataDir)?.entries || [];return [...rows, ...Static.sources.filter(source => !rows.some(row => row.version === source.version))]; }
async function checkpointFile(base, revision, tree, repository, dependencies) {
  const match = RAW.exec(base.url);
  if (!match || match[1] !== repository) return {...base};
  const item = tree.find(row => row.path === match[3] && row.type === 'blob' && /^[a-f0-9]{40}$/.test(row.sha || ''));
  if (!item || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > Models.MAX_WEIGHTS) throw Error('This commit does not contain the declared checkpoint files.');
  const file = {...base, url: 'https://raw.githubusercontent.com/' + repository + '/' + revision + '/' + match[3], bytes: item.size, gitBlobSha1: item.sha};
  delete file.sha256;
  // Git LFS publishes its SHA-256 and byte length in a small committed pointer.
  // Read only that pointer from the Git object API, never weights during Refresh.
  if (item.size <= 1024 && base.bytes > 1024) {
    const pointerBytes = await (dependencies.blob || Upstream.githubBlob)({repository, sha: item.sha, signal: dependencies.signal});
    if (pointerBytes.length !== item.size) throw Error('The checkpoint pointer differs from its committed Git object.');
    const pointer = pointerBytes.toString('utf8');
    const hash = /^oid sha256:([a-f0-9]{64})$/m.exec(pointer)?.[1], size = Number(/^size (\d+)$/m.exec(pointer)?.[1]);
    if (!pointer.startsWith('version https://git-lfs.github.com/spec/v1\n') || !hash || !Number.isSafeInteger(size) || size < 1 || size > Models.MAX_WEIGHTS) throw Error('The checkpoint pointer is invalid.');
    file.sha256 = hash;file.bytes = size;delete file.gitBlobSha1;
  }
  return file;
}
async function refresh(context = {}, dependencies = {}) {
  const signal = context.signal, groups = new Map(), entries = [], failures = [];
  for (const base of Static.sources) {
    const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(base.repository)?.[1];
    if (!repository || !base.files?.some(file => RAW.exec(file.url)?.[1] === repository) || base.files.some(file => file.transport)) continue;
    if (!groups.has(repository)) groups.set(repository, []);groups.get(repository).push(base);
  }
  for (const [repository, profiles] of groups) try {
    const source = Upstream.githubCommits({repository, limit: 8});
    const commits = await (dependencies.discoverCommits || source.discover)({signal});
    for (const commit of commits) {
      if (!/^[a-f0-9]{40}$/.test(commit.revision || '')) continue;
      const listing = await (dependencies.tree || Upstream.githubTree)({repository, revision: commit.revision, signal});
      if (listing.truncated || !Array.isArray(listing.tree)) throw Error('The checkpoint repository tree is incomplete.');
      for (const base of profiles) try {
        const files = await Promise.all(base.files.map(file => checkpointFile(file, commit.revision, listing.tree, repository, {...dependencies, signal})));
        entries.push({...base, version: base.version + '-git-' + commit.revision,
          label: base.label + ' · ' + commit.revision.slice(0, 12), revision: commit.revision,
          releaseUrl: commit.sourceUrl, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0)});
      } catch (error) { signal?.throwIfAborted();failures.push(base.label + ': ' + error.message); }
    }
  } catch (error) { signal?.throwIfAborted();failures.push(repository + ': ' + error.message); }
  try {
    const base = Static.sources.find(row => !row.files), source = Upstream.github({repository: 'Mappsnet7/DLSSMac', prerelease: true, allArchitectures: true,
      recognize: release => ({version: release.tag_name, assets: (release.assets || []).filter(asset => /^DLSSMac-.+-macos\.zip$/i.test(asset.name))})});
    for (const release of await (dependencies.discoverReleases || source.discover)({signal})) for (const file of release.files) {
      const version = 'dlssmac-release-' + release.version;
      entries.push({...base, version, label: 'DLSSMac ' + release.version, releaseUrl: release.sourceUrl,
        revision: release.revision, kind: 'prepared-model-archive', archiveFile:file.name, entry: file.name, bytes: file.bytes,
        files: [{file: file.name, url: file.url, bytes: file.bytes,
          ...(file.digest?.algorithm==='sha256'?{sha256:file.digest.value}:file.digest?{digest:file.digest}:{integrity:'recorded-local'}),...(file.id?{assetId:file.id}:{})}]});
    }
  } catch (error) { signal?.throwIfAborted();failures.push('DLSSMac: ' + error.message); }
  for (const base of Static.sources.filter(row => require('./hub-source').HUGGING_FACE.test(row.repository))) try {
    const source = require('./hub-source').create(base);
    for (const row of await source.discover({signal})) if (validEntry(row.details?.profile)) entries.push(row.details.profile);
  } catch (error) { signal?.throwIfAborted();failures.push(base.label + ': ' + error.message); }
  try {const found=await require('./package-catalog').discover(context);entries.push(...found.entries);failures.push(...found.failures);}
  catch(error) {signal?.throwIfAborted();failures.push('Model archives: ' + error.message);}
  if (!entries.length && groups.size) throw Error(failures[0] || 'No compatible checkpoint versions were returned. Existing model sources remain available.');
  const previous = read(context.userDataDir)?.entries || [];
  const unique = new Map(entries.filter(validEntry).map(row => [row.version, row]));
  const merged = [...unique.values(), ...previous.filter(row => !unique.has(row.version))].slice(0, 500);
  const record = Cache.writeRuntimeCatalog({userDataDir: context.userDataDir, managerId: Models.ID, sourceId: 'upstream',
    source: 'https://github.com/', entries: merged, sourceStates: {upstream: {status: failures.length ? 'error' : 'success', error: failures.join('\n').slice(0, 4096) || null}}});
  return record;
}
module.exports = {read, sources, refresh, validEntry, checkpointFile};
