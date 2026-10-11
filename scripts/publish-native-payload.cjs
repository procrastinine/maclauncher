#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const Payload = require('./native-payload.cjs');
const run = promisify(execFile);

async function readInventory(archive) {
  const input = fs.createReadStream(archive), stream = zlib.createGunzip();
  input.on('error', error => stream.destroy(error)); input.pipe(stream);
  let bytes = Buffer.alloc(0), header;
  try {
    for await (const chunk of stream) {
      bytes = Buffer.concat([bytes, chunk]);
      if (!header && bytes.length >= 512) {
        header = Payload.parseHeader(bytes.subarray(0, 512));
        if (header.name !== 'native-payload.json' || header.mode !== 0o644 || header.size > Payload.LIMITS.metadataBytes)
          throw new Error('The archive must begin with its bounded native payload inventory.');
      }
      if (header && bytes.length >= 512 + header.size) return JSON.parse(bytes.subarray(512, 512 + header.size));
    }
    throw new Error('The native payload inventory is truncated.');
  } finally { input.destroy(); stream.destroy(); }
}
async function verifyArchive(archive, temporary) {
  const stat = fs.lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size >= 2 * 1024 ** 3)
    throw new Error('Choose a regular payload archive smaller than GitHub’s 2 GiB asset limit.');
  const inventory = await readInventory(archive);
  const config = Payload.configuration({ arch: inventory.launcherArch, maximumMacOS: inventory.maximumMacOS });
  if (config.arch !== 'arm64') throw new Error('Automatic app releases require an Apple Silicon payload.');
  Payload.validateInventory(inventory, config);
  const staging = path.join(temporary, 'verified'); fs.mkdirSync(staging);
  try {
    await Payload.extractPayload(archive, staging, config);
    const resourceRoot = path.join(staging, 'native-runtimes');
    require('./verify-native-runtimes.cjs').verifyPackages({ resourceRoot, architectures: [config.arch],
      maximumMacOS: config.maximumMacOS, requiredOnly: true });
    require('./native-supplementals.cjs').verifySupplementals({ resourceRoot, ...config, items: inventory.supplementals });
    if (!inventory.sourceDownload) require('./native-source-artifacts.cjs').verify(path.join(staging, 'native-sources'), inventory.sourceArtifacts);
    return { inventory, sha256: await Payload.checksum(archive), bytes: stat.size, resourceRoot };
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
}
async function gh(args, options = {}) {
  const result = await run('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, ...options });
  return result.stdout.trim();
}
async function verifyPublishedSources(inventory, command = gh) {
  const source = inventory.sourceDownload;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/download\/([^/]+)\/native-payload\.tar\.gz$/.exec(source?.url || '');
  if (!match || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('Separate sources must reference a checksummed published GitHub native payload.');
  const release = JSON.parse(await command(['api', `repos/${match[1]}/releases/tags/${match[2]}`]));
  const archive = release.assets?.find(item => item.name === 'native-payload.tar.gz');
  const metadata = release.assets?.find(item => item.name === 'native-payload.json');
  if (release.draft || archive?.state !== 'uploaded' || archive.digest !== `sha256:${source.sha256}` ||
      archive.browser_download_url !== source.url || metadata?.state !== 'uploaded' || !Number.isSafeInteger(metadata.id) ||
      metadata.size > Payload.LIMITS.metadataBytes) throw new Error('The matching runtime source download is not published.');
  const text = await command(['api', `repos/${match[1]}/releases/assets/${metadata.id}`, '-H', 'Accept: application/octet-stream']);
  const metadataBytes = Buffer.from(text.endsWith('\n') ? text : text + '\n');
  if (metadataBytes.length !== metadata.size || `sha256:${createHash('sha256').update(metadataBytes).digest('hex')}` !== metadata.digest) throw new Error('Published source inventory checksum or size differs.');
  const sourceInventory = JSON.parse(text);
  if (sourceInventory.sourceDownload || !isDeepStrictEqual(sourceInventory.sourceArtifacts, inventory.sourceArtifacts)) throw new Error('Published runtime sources differ from the selected runtime source pins.');
  return source;
}
function assertAssets(release, expected) {
  if (release.assets.length !== expected.length) throw new Error('The payload release has unexpected or missing assets.');
  for (const item of expected) {
    const remote = release.assets.find(asset => asset.name === item.name);
    if (!remote || remote.state !== 'uploaded' || remote.size !== item.bytes || remote.digest !== `sha256:${item.sha256}`)
      throw new Error('GitHub’s uploaded payload checksum or size does not match the verified file.');
  }
}
async function configureVariables(repository, values, command = gh) {
  const previous = JSON.parse(await command(['variable', 'list', '--repo', repository, '--json', 'name,value']));
  const before = new Map(previous.map(row => [row.name, row.value])), changed = [];
  try {
    for (const [name, value] of Object.entries(values)) {
      if (before.get(name) === value) continue;
      // Record before the request: a lost response can follow a successful write.
      changed.push(name);
      await command(['variable', 'set', name, '--repo', repository, '--body', value]);
    }
    const actual = new Map(JSON.parse(await command(['variable', 'list', '--repo', repository, '--json', 'name,value']))
      .map(row => [row.name, row.value]));
    if (Object.entries(values).some(([name, value]) => actual.get(name) !== value)) throw new Error('GitHub variable verification failed.');
  } catch (error) {
    const failures = [];
    for (const name of changed.reverse()) {
      try {
        if (before.has(name)) await command(['variable', 'set', name, '--repo', repository, '--body', before.get(name)]);
        else {
          const current = JSON.parse(await command(['variable', 'list', '--repo', repository, '--json', 'name,value']));
          if (current.some(row => row.name === name)) await command(['variable', 'delete', name, '--repo', repository]);
        }
      } catch { failures.push(name); }
    }
    if (failures.length) throw new Error(`Payload configuration failed; restore these variables before releasing: ${failures.join(', ')}.`, { cause: error });
    throw error;
  }
}
async function publish({ archive, repository, repoRoot = path.resolve(__dirname, '..'), command = gh,
  verify = verifyArchive, exportRuntime = Payload.exportPayload, log = message => process.stderr.write(message + '\n') } = {}) {
  if (!archive) throw new Error('An exported native payload archive is required.');
  archive = path.resolve(archive);
  const workspace = path.join(repoRoot, '.local', 'payload-publication');
  fs.mkdirSync(workspace, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(workspace, 'publish-'));
  try {
    log('Verifying the payload and native dependencies.');
    const verified = await verify(archive, temporary);
    repository ||= await command(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use an explicit GitHub owner/repository.');
    if (verified.inventory.sourceDownload) await verifyPublishedSources(verified.inventory, command);
    const api = route => command(['api', `repos/${repository}/${route}`]).then(JSON.parse);
    const tag = `native-payload-${verified.inventory.launcherArch}-${verified.sha256.slice(0, 16)}`;
    const pages = JSON.parse(await command(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp']));
    let release = pages.flat().find(row => row.tag_name === tag);
    const upload = path.join(temporary, 'native-payload.tar.gz');
    try { fs.linkSync(archive, upload); } catch (error) { if (error.code !== 'EXDEV') throw error; fs.copyFileSync(archive, upload); }
    const inventoryFile = path.join(temporary, 'native-payload.json');
    fs.writeFileSync(inventoryFile, JSON.stringify(verified.inventory, null, 2) + '\n');
    const sumsFile = path.join(temporary, 'SHA256SUMS.txt');
    fs.writeFileSync(sumsFile, `${verified.sha256}  native-payload.tar.gz\n`);
    const expected = await Promise.all([upload, inventoryFile, sumsFile].map(async file => ({
      name: path.basename(file), file, bytes: fs.statSync(file).size,
      sha256: file === upload ? verified.sha256 : await Payload.checksum(file)
    })));
    if (!release) {
      const repo = JSON.parse(await command(['api', `repos/${repository}`]));
      const reference = await api(`git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
      if (reference.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(reference.object.sha || '')) throw new Error('The default branch commit is unavailable.');
      const notes = path.join(temporary, 'notes.md');
      const sourceText = verified.inventory.sourceDownload
        ? `The archive contains the runtime binaries and notices. [Corresponding sources](${verified.inventory.sourceDownload.url}) are provided separately under \`native-sources/\`.`
        : 'The archive contains the selected runtimes, their license notices and corresponding-source archives under `native-sources/`.';
      fs.writeFileSync(notes, `Native runtime build input for MacLauncher (${verified.inventory.launcherArch}, macOS ${verified.inventory.maximumMacOS}).\n\n${sourceText} The inventory records exact component identities. [Download MacLauncher.app](https://github.com/${repository}/releases/latest).\n\nSHA-256: \`${verified.sha256}\`\n`);
      await command(['release', 'create', tag, '--repo', repository, '--target', reference.object.sha,
        '--draft', '--title', `Native runtime payload (${verified.inventory.launcherArch})`, '--notes-file', notes]);
      const created = JSON.parse(await command(['api', `repos/${repository}/releases?per_page=100`, '--paginate', '--slurp']));
      release = created.flat().find(row => row.tag_name === tag);
      if (!release) throw new Error('The new payload draft is unavailable.');
    }
    if (release.assets.some(asset => !expected.some(item => item.name === asset.name))) throw new Error('The payload release contains unexpected assets.');
    if (release.draft) {
      for (const item of expected) {
        const existing = release.assets.find(asset => asset.name === item.name);
        if (existing) assertAssets({ assets: [existing] }, [item]);
        else { log(`Uploading ${item.name}.`); await command(['release', 'upload', tag, '--repo', repository, item.file]); }
      }
    }
    release = await api(`releases/${release.id}`);
    assertAssets(release, expected);
    if (release.draft) {
      await command(['api', '--method', 'PATCH', `repos/${repository}/releases/${release.id}`,
        '-F', 'draft=false', '-F', 'prerelease=true', '-f', 'make_latest=false']);
      release = await api(`releases/${release.id}`);
    }
    assertAssets(release, expected);
    if (release.draft) throw new Error('The native payload is still unpublished.');
    const url = `https://github.com/${repository}/releases/download/${tag}/native-payload.tar.gz`;
    if (release.assets.find(item => item.name === 'native-payload.tar.gz').browser_download_url !== url)
      throw new Error('The published payload URL differs from its expected release location.');
    if (!verified.inventory.sourceDownload) {
      // Publish sources once per native payload; app builds use the smaller archive.
      log('Creating the runtime-only build download.');
      const runtimeArchive = path.join(temporary, 'runtimes.tar.gz');
      await exportRuntime({ resourceRoot: verified.resourceRoot, output: runtimeArchive,
        arch: verified.inventory.launcherArch, maximumMacOS: verified.inventory.maximumMacOS,
        sourceDownload: { url, sha256: verified.sha256 } });
      return await publish({ archive: runtimeArchive, repository, repoRoot, command, verify, exportRuntime, log });
    }
    const variables = {
      MACLAUNCHER_NATIVE_PAYLOAD_ARCH: verified.inventory.launcherArch,
      MACLAUNCHER_NATIVE_MAXIMUM_MACOS: verified.inventory.maximumMacOS,
      MACLAUNCHER_NATIVE_PAYLOAD_SHA256: verified.sha256,
      MACLAUNCHER_NATIVE_PAYLOAD_URL: url
    };
    log('Updating and verifying the four repository variables.');
    await configureVariables(repository, variables, command);
    return { repository, tag, url, sha256: verified.sha256, variables };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return 'Usage: node scripts/publish-native-payload.cjs --archive <exported.tar.gz> [--repo <owner/repository>]';
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--archive', '--repo'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Use unique --archive and optional --repo arguments.');
    options[args[i]] = args[i + 1];
  }
  return publish({ archive: options['--archive'], repository: options['--repo'] });
}
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { readInventory, verifyArchive, verifyPublishedSources, assertAssets, configureVariables, publish, main };
