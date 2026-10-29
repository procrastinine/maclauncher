// Bind application selections to source, locked packages and build outputs.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const B = require('../src/modules/shared/runtime/bundled-native');
const Content = require('./runtime-content.cjs');
const ROOT = path.resolve(__dirname, '..');
const RENDERER = 'dist/renderer-inputs.json';
const pending = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function binaryKind(name, bytes) {
  const magic = bytes.subarray(0, 4).toString('hex');
  if (['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic)) return 'Mach-O or Java bytecode';
  if (magic === '7f454c46' || magic === '0061736d' || bytes[0] === 0x4d && bytes[1] === 0x5a) return 'native executable or WebAssembly';
  if (['504b0304','504b0506','504b0708','377abcaf','fd377a58'].includes(magic) || bytes[0] === 0x1f && bytes[1] === 0x8b ||
      bytes.subarray(0, 8).toString('ascii') === '!<arch>\n') return 'archive';
  if (/\.(?:jar|class|dex|odex|vdex|art|dll|dylib|so|node|exe|wasm|luac|pyc|pyo|rpyc|rpyb|zip|tar|tgz|gz|xz|7z)$/i.test(name)) return 'compiled code or archive';
  if (bytes.subarray(0, 4).toString('ascii') === '\x1bLua' || bytes.subarray(0, 3).toString('ascii') === '\x1bLJ') return 'Lua bytecode';
  return null;
}
function regular(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > B.LIMITS.fileBytes) throw new Error('Application inputs require bounded regular files.');
  const bytes = fs.readFileSync(file);
  return { size: bytes.length, sha256: sha(bytes), binary: binaryKind(file, bytes) };
}
function walk(root, filter, visit, relative = '', seen = new Set()) {
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const item = relative ? relative + '/' + name : name, file = path.join(root, item);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    // Like electron-builder, an alias outside the selection is skipped by
    // itself, so development links into unfetched checkouts do not matter.
    if (!stat) {
      if (filter && !filter(file, fs.lstatSync(file))) continue;
      throw new Error(`Application inputs contain an alias without a target: ${item}.`);
    }
    if (filter && !filter(file, stat)) continue;
    if (stat.isDirectory()) {
      const real = fs.realpathSync(file);
      if (!inside(fs.realpathSync(root), real) || seen.has(real)) throw new Error('Application input directories contain an escaping or cyclic alias.');
      seen.add(real); walk(root, filter, visit, item, seen); seen.delete(real);
    } else if (stat.isFile()) visit(file, item);
    else throw new Error('Application inputs contain a special file.');
  }
}
function lockfile(repoRoot) {
  const lock = require('js-yaml').load(fs.readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  if (!lock?.packages || !lock.importers?.['.']) throw new Error('Application dependencies require an exact pnpm lockfile.');
  return lock;
}
function supplierIdentity(pkg, lock) {
  const key = `${pkg.name}@${pkg.version}`, integrity = lock.packages[key]?.resolution?.integrity;
  if (!/^(?:sha256|sha512)-[A-Za-z0-9+/=]+$/.test(integrity || '')) throw new Error(`Missing exact locked supplier identity: ${key}.`);
  return { name: pkg.name, version: pkg.version, integrity };
}
function dependencyDirectory(name, from) {
  for (let directory = path.resolve(from); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (path.dirname(directory) === directory) break;
  }
  return null;
}
function dependencySources(repoRoot, packageConfig, lock) {
  const suppliers = new Map(), directories = new Set();
  function visit(name, from, optional) {
    const directory = dependencyDirectory(name, from);
    if (!directory) { if (optional) return; throw new Error(`Missing application dependency source: ${name}.`); }
    if (directories.has(directory)) return;
    directories.add(directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))), identity = supplierIdentity(pkg, lock), key = `${pkg.name}@${pkg.version}`;
    if (!suppliers.has(key)) {
      const files = new Map();
      walk(directory, (file, stat) => path.basename(file) !== 'node_modules' && path.basename(file) !== '.git', (file, relative) => files.set(relative, { ...regular(file), source: file }));
      suppliers.set(key, { ...identity, directory, files });
    }
    for (const dependency of Object.keys(pkg.dependencies || {})) visit(dependency, directory, Object.hasOwn(pkg.optionalDependencies || {}, dependency));
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) visit(dependency, directory, true);
    for (const dependency of Object.keys(pkg.peerDependencies || {})) visit(dependency, directory, true);
  }
  for (const name of Object.keys(packageConfig.dependencies || {})) visit(name, repoRoot, false);
  return suppliers;
}
function buildsSources({ repoRoot, plan, packageLock }) {
  packageLock ||= JSON.parse(fs.readFileSync(path.join(repoRoot, 'build/runtime-packages.json')));
  require('./runtime-packages.cjs').validateLock(packageLock, { plan });
  if (plan.packages.length) throw new Error('Application engine payloads must use managed delivery.');
  const files = new Map();
  for (const item of plan.supplementals) {
    const root = path.join(repoRoot, 'src/resources/native-runtimes', item.directoryRelative);
    B.verifyPayload(root, item);
    const record = packageLock.packages.find(record => record.id === item.id && record.version === item.version && record.arch === item.arch);
    if (!record) throw new Error('An included package has no locked Builds record.');
    for (const file of item.files) files.set(path.resolve(root, file.path), { ...file, owner: 'builds', package: `${record.id}/${record.version}/${record.arch}`,
      assetSha256: record.asset.sha256, manifestSha256: record.manifestSha256 });
  }
  return files;
}
function rendererSources(repoRoot, { required = true } = {}) {
  const file = path.join(repoRoot, RENDERER);
  if (!fs.existsSync(file)) { if (!required) return null; throw new Error('Renderer input identity is missing. Run the renderer build before packaging.'); }
  const record = JSON.parse(fs.readFileSync(file));
  if (record.schemaVersion !== 1 || !Array.isArray(record.inputs) || !record.inputs.length || !Array.isArray(record.outputs) || !record.outputs.length)
    throw new Error('The renderer build input map is invalid.');
  for (const input of record.inputs) {
    const relative = B.relativeFile(input.path); Content.assertRuntimePath(relative);
    if (regular(path.join(repoRoot, relative)).sha256 !== input.sha256) throw new Error(`Renderer source changed after its build: ${relative}.`);
  }
  const digest = sha(Buffer.from(JSON.stringify(record.inputs)));
  if (digest !== record.inputSha256) throw new Error('The renderer build input digest changed.');
  const outputs = new Map();
  for (const output of record.outputs) {
    const relative = B.relativeFile(output.path);
    if (!relative.startsWith('dist/renderer/') || outputs.has(relative) || regular(path.join(repoRoot, relative)).sha256 !== output.sha256)
      throw new Error('Renderer outputs differ from their source-bound build map.');
    outputs.set(relative, { ...output, owner: 'renderer', inputSha256: digest, source: path.join(repoRoot, relative) });
  }
  return { ...record, outputs };
}
function rendererPlugin() {
  let repoRoot, outputDirectory, publicDirectory; const consumed = new Set(), captured = new Map();
  const configurationInputs = ['package.json','pnpm-lock.yaml','vite.config.mjs','tsconfig.json','scripts/app-inputs.cjs','scripts/runtime-content.cjs','scripts/runtime-content-vite.mjs'];
  function capture(id) {
    if (typeof id !== 'string' || id.startsWith('\0')) return;
    const file = id.replace(/[?#].*$/, '');
    if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const real = fs.realpathSync(file), digest = regular(real).sha256;
      if (captured.has(real) && captured.get(real) !== digest) throw new Error('Renderer source changed while it was being built.');
      captured.set(real, digest);
    }
  }
  return { name: 'maclauncher-renderer-inputs', apply: 'build', enforce: 'pre',
    configResolved(config) {
      const lexicalRoot = path.resolve(config.root, '../..'); repoRoot = fs.realpathSync(lexicalRoot);
      outputDirectory = path.resolve(repoRoot, path.relative(lexicalRoot, path.resolve(config.root, config.build.outDir)));
      publicDirectory = typeof config.publicDir === 'string' ? config.publicDir : null;
    },
    buildStart() {
      consumed.clear(); captured.clear();
      for (const relative of [...configurationInputs, 'src/renderer/index.html']) capture(path.join(repoRoot, relative));
      if (publicDirectory && fs.existsSync(publicDirectory)) walk(publicDirectory, null, file => capture(file));
    },
    load(id) { capture(id); return null; },
    transform(_code, id) { capture(id); consumed.add(id); return null; },
    moduleParsed(info) { consumed.add(info.id); },
    writeBundle(_options, bundle) {
      const emittedSources = Object.values(bundle).flatMap(item => item.type === 'chunk' ? Object.keys(item.modules || {}) : item.originalFileNames || []);
      const candidates = new Set([...consumed, ...emittedSources,
        ...(typeof this.getModuleIds === 'function' ? this.getModuleIds() : []),
        ...(typeof this.getWatchFiles === 'function' ? this.getWatchFiles() : []),
        path.join(repoRoot, 'src/renderer/index.html'),
        ...configurationInputs.map(file => path.join(repoRoot, file))]);
      const publicFiles = [];
      if (publicDirectory && fs.existsSync(publicDirectory)) walk(publicDirectory, null, (file, relative) => { candidates.add(file); publicFiles.push([file, relative]); });
      const inputs = [];
      for (let file of candidates) {
        if (typeof file !== 'string' || file.startsWith('\0')) continue;
        file = file.replace(/[?#].*$/, '');
        if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        file = fs.realpathSync(file);
        if (!inside(repoRoot, file)) throw new Error('Renderer build inputs must belong to the declared checkout or dependency tree.');
        const relative = slash(path.relative(repoRoot, file)); Content.assertRuntimePath(relative);
        const digest = regular(file).sha256;
        if (captured.has(file) && captured.get(file) !== digest) throw new Error(`Renderer source changed while it was being built: ${relative}.`);
        inputs.push({ path: relative, sha256: digest });
      }
      const unique = [...new Map(inputs.map(input => [input.path, input])).values()].sort((a, b) => a.path.localeCompare(b.path));
      const outputNames = new Set(Object.keys(bundle));
      for (const [file, relative] of publicFiles) {
        if (regular(path.join(outputDirectory, relative)).sha256 !== regular(file).sha256) throw new Error('Renderer public output differs from its source.');
        outputNames.add(relative);
      }
      const outputs = [...outputNames].sort().map(name => ({ path: slash(path.relative(repoRoot, path.join(outputDirectory, B.relativeFile(name)))), sha256: regular(path.join(outputDirectory, name)).sha256 }));
      fs.writeFileSync(path.join(repoRoot, RENDERER), JSON.stringify({ schemaVersion: 1, inputSha256: sha(Buffer.from(JSON.stringify(unique))), inputs: unique, outputs }, null, 2) + '\n');
    } };
}
function hostSources(repoRoot, packageConfig, { required = true, arch = process.arch } = {}) {
  if (!required && !fs.existsSync(path.join(repoRoot, 'node_modules/electron/package.json'))) return null;
  const Host = require('./app-host.cjs'), selected = Host.readHost({ repoRoot, arch }), { record, inventory } = selected;
  const sourceRoot = path.join(repoRoot, Host.sourceAppRelative(record));
  Host.verifyElectronApp(sourceRoot, inventory);
  const files = new Map(), aliases = new Map();
  for (const input of inventory.files) {
    const relative = B.relativeFile(input.path), source = path.join(sourceRoot, relative);
    if (input.type === 'symlink') { aliases.set(relative, input); continue; }
    files.set(relative, { ...input, owner: 'upstream-host', source, package: [record.id, record.version, record.arch].join('/'),
      unsignedSha256: input.architectures ? unsignedMachO(fs.readFileSync(source)) : null });
  }
  for (const notice of inventory.notices) {
    const source = path.join(path.dirname(sourceRoot), notice.path);
    if (regular(source).sha256 !== notice.sha256) throw new Error('Electron license notices differ from their publisher archive.');
    files.set('Contents/Resources/' + notice.resource, { ...notice, source, owner: 'upstream-host',
      package: [record.id, record.version, record.arch].join('/') });
  }
  return { record, root: selected.root, sourceRoot, files, aliases };
}
// Signing may append a signature command and alignment padding to unsigned
// supplier slices. Compare all executable bytes after normalizing those fields.
function unsignedMachO(bytes) {
  function thin(input) {
    const magic = input.readUInt32LE(0);
    if (![0xfeedface,0xfeedfacf].includes(magic)) throw new Error('Unsupported application host Mach-O encoding.');
    const header = magic === 0xfeedfacf ? 32 : 28, commands = input.readUInt32LE(16), size = input.readUInt32LE(20);
    if (commands > 4096 || header + size > input.length) throw new Error('Invalid application host Mach-O commands.');
    let cursor = header, end = input.length, signature = false; const copy = Buffer.from(input), retained = [];
    for (let index = 0; index < commands; index++) {
      const command = input.readUInt32LE(cursor), length = input.readUInt32LE(cursor + 4);
      if (length < 8 || cursor + length > header + size) throw new Error('Invalid application host Mach-O command size.');
      if (command === 0x1d) {
        if (signature || length !== 16) throw new Error('Invalid application host Mach-O signature command.');
        signature = true; end = input.readUInt32LE(cursor + 8);
      }
      if (command === 0x19 && input.subarray(cursor + 8, cursor + 24).toString('ascii').replace(/\0.*$/, '') === '__LINKEDIT') {
        copy.fill(0, cursor + 32, cursor + 40); copy.fill(0, cursor + 48, cursor + 56);
      }
      if (command !== 0x1d) retained.push(Buffer.from(copy.subarray(cursor, cursor + length)));
      cursor += length;
    }
    if (cursor !== header + size) throw new Error('Invalid application host Mach-O command boundary.');
    if (end < header + size || end > input.length) throw new Error('Invalid application host Mach-O signature boundary.');
    copy.fill(0, header, header + size); cursor = header;
    for (const command of retained) { command.copy(copy, cursor); cursor += command.length; }
    copy.writeUInt32LE(retained.length, 16); copy.writeUInt32LE(cursor - header, 20);
    while (end > header + size && copy[end - 1] === 0) end--;
    return sha(copy.subarray(0, end));
  }
  const magic = bytes.readUInt32BE(0);
  if ([0xcafebabe,0xcafebabf].includes(magic)) {
    const count = bytes.readUInt32BE(4), wide = magic === 0xcafebabf, stride = wide ? 32 : 20, values = [];
    if (!count || count > 8 || 8 + count * stride > bytes.length) throw new Error('Invalid universal application host.');
    for (let index = 0; index < count; index++) {
      const position = 8 + index * stride, offset = wide ? Number(bytes.readBigUInt64BE(position + 8)) : bytes.readUInt32BE(position + 8),
        size = wide ? Number(bytes.readBigUInt64BE(position + 16)) : bytes.readUInt32BE(position + 12);
      if (!Number.isSafeInteger(offset + size) || offset < 0 || size < 32 || offset + size > bytes.length) throw new Error('Invalid universal application host slice.');
      values.push([bytes.readUInt32BE(position), thin(bytes.subarray(offset, offset + size))]);
    }
    return sha(Buffer.from(JSON.stringify(values)));
  }
  return thin(bytes);
}
function expectedSelections({ repoRoot = ROOT, plan, packageConfig = require('../package.json'), packageLock, requireRenderer = true } = {}) {
  const Check = require('./check-packaging.cjs'), selection = Check.applicationMatchers(packageConfig, { repoRoot });
  const builds = buildsSources({ repoRoot, plan, packageLock }), renderer = requireRenderer ? rendererSources(repoRoot) : null;
  const asar = new Map(), resources = new Map(), sources = new Map(), upstream = new Map();
  for (const relative of ['package.json','pnpm-lock.yaml','build/entitlements.mac.plist',
    'scripts/before-pack.js','scripts/after-pack.js','scripts/check-packaging.cjs','scripts/app-inputs.cjs','scripts/distribution-model.cjs','scripts/runtime-content.cjs',
    'scripts/python-resources.cjs','src/modules/shared/runtime/embedded-python.json']) {
    const file = path.join(repoRoot, relative);
    if (fs.existsSync(file)) sources.set(file, { ...regular(file), source: file, owner: 'packaging-source' });
  }
  function supplier(relative) {
    const kind = relative.startsWith('src/resources/python/') ? 'python' : relative.startsWith('src/resources/7zip/') ? '7zip' : null;
    if (!kind) {
      const key = 'file:' + relative;
      if (upstream.has(key)) return upstream.get(key);
      const metadata = path.join(repoRoot, path.dirname(relative), 'binary.json');
      if (!fs.existsSync(metadata)) return null;
      const stored = regular(metadata), identity = JSON.parse(fs.readFileSync(metadata));
      const entries = identity.files?.filter(file => file.path === path.basename(relative));
      if (!entries?.length) return null;
      const entry = entries[0];
      if (entries.length !== 1 || !identity.version || !/^https:\/\//.test(identity.url || '') ||
          !Number.isSafeInteger(entry.size) || entry.size < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))
        throw new Error('A bundled upstream file identity is invalid.');
      sources.set(metadata, { ...stored, source: metadata, owner: 'supplier-metadata' });
      const record = { ...identity, name: 'declared-upstream', file: entry };
      upstream.set(key, record);
      return record;
    }
    if (upstream.has(kind)) return upstream.get(kind);
    const metadata = path.join(repoRoot, 'src/resources', kind, kind === 'python' ? 'runtime.json' : 'source.json');
    const identity = JSON.parse(fs.readFileSync(metadata));
    if (!identity.version || !/^https:\/\//.test(identity.url || '') || !/^[a-f0-9]{64}$/.test(identity.sha256 || ''))
      throw new Error(`A bundled upstream supplier identity is invalid: ${kind}.`);
    sources.set(metadata, { ...regular(metadata), source: metadata, owner: 'supplier-metadata' });
    if (kind === 'python') {
      const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/modules/shared/runtime/embedded-python.json')));
      for (const key of ['version','abi','architecture','publisher','release','url','sha256','packages'])
        if (JSON.stringify(identity[key]) !== JSON.stringify(profile[key])) throw new Error('Bundled Python differs from its upstream supplier profile.');
      require('./python-resources.cjs').verifySourcePython({ sourceRoot: path.dirname(metadata) });
    }
    const record = { name: kind, ...identity };
    upstream.set(kind, record);
    return record;
  }
  function source(file, relative) {
    const record = regular(file), declared = builds.get(path.resolve(file));
    if (declared) {
      if (record.sha256 !== declared.sha256 || record.size !== declared.size) throw new Error('A selected Builds input differs from its locked declaration.');
      return { ...declared, source: file };
    }
    if (relative.startsWith('dist/renderer/')) {
      const output = renderer?.outputs.get(relative);
      if (!output || output.sha256 !== record.sha256) throw new Error(`An application renderer file is absent from its build map: ${relative}.`);
      return output;
    }
    const publisher = supplier(relative);
    if (publisher) {
      if (publisher.file && (record.sha256 !== publisher.file.sha256 || record.size !== publisher.file.size))
        throw new Error('Bundled upstream file differs from its declared supplier identity.');
      if (publisher.name === '7zip' && relative === 'src/resources/7zip/7zz' && record.sha256 !== publisher.executableSha256)
        throw new Error('Bundled 7-Zip differs from its official supplier executable.');
      const bytes = record.binary ? fs.readFileSync(file) : null;
      const magic = bytes?.subarray(0, 4).toString('hex');
      return { ...record, owner: 'upstream', source: file, sourceRelative: relative, supplier: publisher,
        unsignedSha256: ['cefaedfe','cffaedfe','cafebabe','cafebabf'].includes(magic) ? unsignedMachO(bytes) : null };
    }
    if (record.binary) throw new Error(`Missing source, upstream supplier or Builds record for ${record.binary}: ${relative}.`);
    if (!inside(path.resolve(repoRoot), path.resolve(file))) throw new Error('Application source inputs must belong to the declared checkout.');
    Content.assertRuntimePath(relative);
    return { ...record, owner: 'source', source: file, sourceRelative: relative };
  }
  function add(map, name, record) {
    name = B.relativeFile(name);
    if (map.has(name) && map.get(name).source !== record.source) throw new Error(`Application inputs overlap: ${name}.`);
    map.set(name, record); sources.set(record.source, record);
  }
  for (const matcher of selection.matchers) {
    const filter = matcher.createFilter(), prefix = slash(path.relative(selection.destination, matcher.to));
    if (!inside(path.resolve(repoRoot), path.resolve(matcher.from))) throw new Error('Application FileSets require checkout-relative sources.');
    if (!fs.existsSync(matcher.from)) throw new Error('An application FileSet source is missing.');
    walk(matcher.from, filter, (file, relative) => {
      const sourceRelative = slash(path.relative(repoRoot, file));
      if (sourceRelative.startsWith('node_modules/')) return;
      if (!requireRenderer && sourceRelative.startsWith('dist/renderer/')) return;
      add(asar, prefix ? prefix + '/' + relative : relative, source(file, sourceRelative));
    });
  }
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  for (const rule of require('./distribution-model.cjs').resourceRules(plan, selection.build.extraResources)) {
    const root = path.resolve(repoRoot, rule.from);
    if (!inside(path.resolve(repoRoot), root)) throw new Error('Application resources require checkout-relative sources.');
    const matcher = new FileMatcher(root, '/resources', value => value, rule.filter);
    if (!fs.existsSync(root)) throw new Error(`An application resource source is missing: ${rule.from}.`);
    walk(root, matcher.createFilter(), (file, relative) => add(resources, rule.to == null || rule.to === '.' ? relative : rule.to + '/' + relative,
      source(file, slash(path.relative(repoRoot, file)))));
  }
  const python = require('./python-resources.cjs').configuration();
  const interpreter = resources.get('python/' + python.interpreter);
  if (interpreter) for (const [alias, target] of Object.entries(python.aliases))
    resources.set('python/' + alias, { ...interpreter, aliasTarget: target });
  return { repoRoot, packageConfig, plan, asar, resources, sources, renderer,
    suppliers: dependencySources(repoRoot, packageConfig, lockfile(repoRoot)), lock: lockfile(repoRoot) };
}
async function prepare(options) {
  const selected = expectedSelections(options);
  selected.host = hostSources(selected.repoRoot, selected.packageConfig, { required: options.requireHost !== false, arch: selected.plan.launcherArch });
  for (const supplier of selected.suppliers.values()) for (const record of supplier.files.values()) selected.sources.set(record.source, record);
  const transform = require('app-builder-lib/out/fileTransformer').createTransformer(selected.repoRoot, selected.packageConfig.build, selected.packageConfig.build.extraMetadata);
  for (const record of [...selected.asar.values(), ...[...selected.suppliers.values()].flatMap(item => [...item.files.values()])]) {
    if (path.basename(record.source) !== 'package.json') continue;
    const transformed = await transform(record.source);
    if (transformed != null) record.outputSha256 = sha(Buffer.from(transformed));
  }
  return selected;
}
function assertUnchanged(selected) {
  for (const [file, record] of selected.sources) if (regular(file).sha256 !== record.sha256) throw new Error(`Application source changed during packaging: ${slash(path.relative(selected.repoRoot, file))}.`);
  if (selected.renderer) rendererSources(selected.repoRoot);
}
function npmRecord(selected, relative, read) {
  const match = /^(.*(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(relative);
  if (!match) return null;
  let pkg; try { pkg = JSON.parse(read(match[1] + '/package.json')); } catch { return null; }
  const supplier = selected.suppliers.get(`${pkg.name}@${pkg.version}`), record = supplier?.files.get(match[2]);
  if (!record) return null;
  const packageName = match[1].replace(/^.*(?:^|\/)node_modules\//, '');
  if (packageName !== pkg.name) return null;
  return { ...record, owner: 'dependency', supplier: { name: supplier.name, version: supplier.version, integrity: supplier.integrity } };
}
function hostRelative(relative, product) {
  return relative.split('/').map(part => part === product ? 'Electron' : part.replace(new RegExp('^' + product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( (?:Helper|Login Helper)(?:[^/]*))$'), 'Electron$1')).join('/');
}
function verifyHostMember(selected, file, relative) {
  const product = selected.packageConfig.build.productName, host = selected.host;
  if (!host) throw new Error('An application file has no verified Electron publisher supplier.');
  const original = hostRelative(relative, product), record = host.files.get(original), alias = host.aliases.get(original), stat = fs.lstatSync(file);
  if (alias) {
    if (!stat.isSymbolicLink() || hostRelative(fs.readlinkSync(file), product) !== alias.target) throw new Error(`Application host link differs from its publisher archive: ${relative}.`);
    return;
  }
  if (/(?:^|\/)\_CodeSignature\/CodeResources$/.test(relative)) {
    const directory = original.slice(0, -'_CodeSignature/CodeResources'.length);
    if (record || host.files.has(directory + 'Info.plist') || host.files.has(directory + 'Resources/Info.plist')) return;
  }
  if (record && /(?:^|\/)Info\.plist$/.test(relative)) {
    if (sha(fs.readFileSync(file)) === record.sha256) return;
    const parse = input => JSON.parse(require('node:child_process').execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', input], { encoding: 'utf8', timeout: 30000 }));
    const originalInfo = parse(record.source), info = parse(file), allowed = new Set(['CFBundleDisplayName','CFBundleExecutable','CFBundleIdentifier','CFBundleName',
      'CFBundleShortVersionString','CFBundleVersion','CFBundleIconFile','NSHumanReadableCopyright','LSApplicationCategoryType','LSMinimumSystemVersion',
      'CFBundleURLTypes','CFBundleDocumentTypes','NSAppTransportSecurity','ElectronAsarIntegrity', ...Object.keys(selected.packageConfig.build.mac.extendInfo || {})]);
    for (const key of new Set([...Object.keys(originalInfo), ...Object.keys(info)])) if (!allowed.has(key) && JSON.stringify(info[key]) !== JSON.stringify(originalInfo[key]))
      throw new Error(`Application host metadata has an undeclared transformation: ${relative}:${key}.`);
    if (relative === 'Contents/Info.plist' && (info.CFBundleIdentifier !== selected.packageConfig.build.appId || info.CFBundleDisplayName !== product ||
        info.CFBundleShortVersionString !== selected.packageConfig.version)) throw new Error('Application host metadata differs from its launcher source.');
    return;
  }
  if (relative === 'Contents/Resources/icon.icns') {
    const icon = selected.packageConfig.build.mac.icon;
    if (!icon || !inside(selected.repoRoot, path.resolve(selected.repoRoot, icon)) || sha(fs.readFileSync(file)) !== regular(path.resolve(selected.repoRoot, icon)).sha256) throw new Error('Application icon differs from its launcher source.');
    return;
  }
  if (!record) throw new Error(`Application contains an unlisted host or resource file: ${relative}.`);
  const bytes = fs.readFileSync(file), digest = record.unsignedSha256 ? unsignedMachO(bytes) : sha(bytes);
  if (digest !== (record.unsignedSha256 || record.sha256)) throw new Error(`Application host file differs from its publisher supplier: ${relative}.`);
}
function checkMember(selected, relative, bytes, { resource = false, read } = {}) {
  const record = (resource ? selected.resources : selected.asar).get(relative) || (!resource && npmRecord(selected, relative, read));
  if (!record) throw new Error(`Application contains an input without a source, supplier or Builds record: ${relative}.`);
  const digest = record.unsignedSha256 ? unsignedMachO(bytes) : sha(bytes);
  if (digest !== (record.unsignedSha256 || record.outputSha256 || record.sha256)) throw new Error(`Application file differs from its source, supplier or Builds record: ${relative}.`);
  return record.owner;
}
function verifyContents(selected, { archive, resources, appPath, requireHost = true }) {
  assertUnchanged(selected);
  resources = fs.realpathSync(resources);
  if (appPath) appPath = fs.realpathSync(appPath);
  const asar = require('@electron/asar'); asar.uncache(archive);
  const read = name => asar.extractFile(archive, name), files = asar.listPackage(archive).map(name => name.replace(/^\//, ''));
  const unpacked = new Set(); let archiveFiles = 0, resourceFiles = 0;
  for (const relative of files) {
    const item = asar.statFile(archive, relative, false);
    if (item.files) continue;
    if (item.link && !selected.asar.has(relative) && !npmRecord(selected, relative, read))
      throw new Error(`Application archive link has no source or Builds record: ${relative}.`);
    if (item.unpacked) unpacked.add(relative);
    checkMember(selected, relative, read(relative), { read }); archiveFiles++;
  }
  walk(resources, null, (file, relative) => {
    if (relative === 'app.asar') return;
    if (relative.startsWith('app.asar.unpacked/')) {
      const name = relative.slice('app.asar.unpacked/'.length);
      if (!unpacked.has(name)) throw new Error(`Application contains an unlisted unpacked file: ${name}.`);
      return;
    }
    if (!selected.resources.has(relative)) { if (requireHost) verifyHostMember(selected, file, 'Contents/Resources/' + relative); else throw new Error(`Application contains an unlisted resource: ${relative}.`); return; }
    const record = selected.resources.get(relative);
    if (record.aliasTarget && (!fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== record.aliasTarget ||
        fs.realpathSync(file) !== path.join(path.dirname(file), record.aliasTarget))) throw new Error(`Application resource alias differs from its source projection: ${relative}.`);
    checkMember(selected, relative, fs.readFileSync(file), { resource: true }); resourceFiles++;
  });
  if (requireHost) {
    if (!appPath) throw new Error('Application host tracing requires its actual bundle.');
    const tree = require('./check-packaging.cjs').appTree(appPath);
    for (const relative of tree.files) if (!relative.startsWith('Contents/Resources/')) verifyHostMember(selected, path.join(appPath, relative), relative);
  }
  return { archiveFiles, resourceFiles };
}
function verifySource(options) {
  const selected = expectedSelections({ ...options, requireRenderer: false });
  selected.host = hostSources(selected.repoRoot, selected.packageConfig, { arch: selected.plan.launcherArch });
  let compiledDependencies = 0;
  const included = require('./check-packaging.cjs').applicationFileSelector(selected.packageConfig);
  for (const supplier of selected.suppliers.values()) for (const [file, record] of supplier.files) {
    const name = 'node_modules/' + supplier.name + '/' + file;
    if (record.binary && included(name)) compiledDependencies++;
  }
  return { sourceFiles: selected.asar.size, resourceFiles: selected.resources.size, dependencySuppliers: selected.suppliers.size,
    hostPackage: `${selected.host.record.id}/${selected.host.record.version}/${selected.host.record.arch}`, compiledDependencies };
}
module.exports = { RENDERER, binaryKind, regular, expectedSelections, prepare, verifySource, assertUnchanged, checkMember, verifyContents, rendererPlugin, dependencySources, lockfile, hostSources, unsignedMachO, pending };
