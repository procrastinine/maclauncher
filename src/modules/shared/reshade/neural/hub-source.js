// Copyright (c) MacLauncher contributors. MIT license.
const Upstream = require('../../runtime/upstream');
const HUGGING_FACE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)$/;
const FILE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[a-f0-9]{40}\/(.+)$/;
function create(base) {
  const repository = HUGGING_FACE.exec(base.repository)?.[1];
  if (!repository) throw Error('Choose a Hugging Face model repository.');
  const api = 'https://huggingface.co/api/models/' + repository;
  return Upstream.index({locations: [api + '/refs'], hosts: ['huggingface.co'], allArchitectures: true,
    parse: async ([document], {fetch}) => {
      const refs = JSON.parse(document.text), commits = [...new Set([...(refs.tags || []), ...(refs.branches || [])]
        .map(row => row.targetCommit).filter(sha => /^[a-f0-9]{40}$/.test(sha || '')))].slice(0, 32), rows = [];
      for (const revision of commits) {
        const response = await fetch(api + '/revision/' + revision + '?blobs=true');
        if (response?.status !== 200) throw Error('The model revision metadata is unavailable.');
        const metadata = JSON.parse(response.text);
        if (metadata.sha !== revision || !Array.isArray(metadata.siblings)) throw Error('The model revision metadata differs from the requested commit.');
        const files = base.files.map(original => {
          const match = FILE.exec(original.url);if (!match || match[1] !== repository) return {...original};
          const item = metadata.siblings.find(row => row.rfilename === match[2]), size = item?.lfs?.size || item?.size;
          if (!item || !Number.isSafeInteger(size) || size < 1) throw Error('The model revision has no declared checkpoint file.');
          const file = {...original, bytes: size, url: 'https://huggingface.co/' + repository + '/resolve/' + revision + '/' + match[2]};
          if (/^[a-f0-9]{64}$/.test(item.lfs?.sha256 || '')) file.sha256 = item.lfs.sha256;
          else if (/^[a-f0-9]{40}$/.test(item.blobId || '') && !original.transport) {delete file.sha256;file.gitBlobSha1 = item.blobId;}
          else throw Error('The checkpoint revision supplies no usable content identity.');
          return file;
        });
        const profile = {...base, version: base.version + '-hf-' + revision, revision, label: base.label + ' · ' + revision.slice(0, 12),
          releaseUrl: base.repository + '/tree/' + revision, files, bytes: files.reduce((sum, row) => sum + row.bytes, 0)};
        rows.push({version: profile.version, details: {profile}, files: []});
      }
      return rows;
    }});
}
module.exports = {create, HUGGING_FACE};
