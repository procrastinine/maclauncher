// Copyright (c) MacLauncher contributors. MIT license.
const path = require('node:path'), Upstream = require('../../runtime/upstream');
const sources = require('./model-source.json').sources;
function profile(base, file, version, sourceUrl, revision) {
  if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 1) return null;
  const identity = file.digest?.algorithm === 'sha256' ? '-archive-' + file.digest.value : '-asset-' + (file.id || encodeURIComponent(version));
  return {...base, kind: 'archive-model', version: base.version + identity,
    label: base.label + ' · ' + version, releaseUrl: sourceUrl, revision,
    archiveFile: file.name, files: [{file: file.name, url: file.url, bytes: file.bytes,
      ...(file.digest?.algorithm === 'sha256' ? {sha256:file.digest.value} : file.digest ? {digest:file.digest} : {integrity:'recorded-local'}),...(file.id?{assetId:file.id}:{})},
      ...(base.files || []).filter(row => !row.transport)], bytes: file.bytes + (base.files || []).filter(row => !row.transport).reduce((sum, row) => sum + row.bytes, 0)};
}
async function discover(context = {}) {
  const signal = context.signal, entries = [], failures = [], groups = new Map();
  for (const base of sources.filter(row => row.files?.some(file => file.transport === 'zip-entry'))) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(base.repository);if (!match) continue;
    if (!groups.has(match[1])) groups.set(match[1], []);groups.get(match[1]).push(base);
  }
  for (const [repository, bases] of groups) try {
    const names = new Set(bases.flatMap(base => base.files.filter(file => file.transport === 'zip-entry').map(file => path.posix.basename(new URL(file.url).pathname))));
    const source = Upstream.github({repository, prerelease: true, allArchitectures: true,
      recognize: release => ({version: release.tag_name, assets: (release.assets || []).filter(asset => names.has(asset.name))})});
    for (const release of await source.discover({signal})) for (const file of release.files) for (const base of bases) {
      if (!base.files.some(row => row.transport === 'zip-entry' && path.posix.basename(new URL(row.url).pathname) === file.name)) continue;
      const row = profile(base, file, release.version, release.sourceUrl, release.revision);if (row) entries.push(row);
    }
  } catch(error) {signal?.throwIfAborted();failures.push(repository + ': ' + error.message);}
  const base = sources.find(row => row.method === 'mlx-vsr');
  if (base) try {
    const location = 'https://pypi.nvidia.com/nvidia-vfx/';
    const source = Upstream.index({locations: [location], hosts: ['pypi.nvidia.com'], allArchitectures: true,
      parse: async ([document], {fetch}) => {
        const rows = [];
        for (const match of document.text.matchAll(/href=["']([^"']+)["']/g)) {
          const url = new URL(match[1], location), name = path.posix.basename(url.pathname);
          const version = /^nvidia_vfx-([0-9]+(?:\.[0-9]+)+)-cp312-abi3-manylinux_[a-z0-9_.]+\.whl$/.exec(name)?.[1];
          const digest = /^#sha256=([a-f0-9]{64})$/.exec(url.hash)?.[1];
          if (!version || !digest || url.origin !== new URL(location).origin) continue;
          url.hash = '';const head = await fetch(url.href, {method: 'HEAD'});
          const bytes = Number(head?.headers?.['content-length']);if (head?.status !== 200 || !Number.isSafeInteger(bytes) || bytes < 1) continue;
          rows.push({version, sourceUrl: location, files: [{name, url: url.href, bytes, digest}]});
        }
        return rows;
      }});
    for (const release of await source.discover({signal})) for (const file of release.files) {
      const row = profile(base, file, release.version, release.sourceUrl);if (row) entries.push(row);
    }
  } catch(error) {signal?.throwIfAborted();failures.push('NVIDIA VFX: ' + error.message);}
  return {entries, failures};
}
module.exports = {discover, profile};
