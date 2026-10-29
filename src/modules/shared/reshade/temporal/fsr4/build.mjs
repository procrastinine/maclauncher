// Copyright (c) MacLauncher contributors. MIT license.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {adaptHelpers, adaptRuntime} from './adapt-runtime.mjs';

const here = import.meta.dirname,
      pin = JSON.parse(await fs.readFile(path.join(here, 'source.json'))),
      [ sourceArg, destinationArg, ...flags ] = process.argv.slice(2);
if (!sourceArg || !destinationArg)
  throw Error(
      'Usage: build.mjs SOURCE OUTPUT --tools DIR --lite2-weights FILE --lite2-license FILE [--quick]');
const source = path.resolve(sourceArg),
      destination = path.resolve(destinationArg), options = {};
const ownedNames =
          [
            'source.json', 'build.mjs', 'adapt-runtime.mjs', 'provider.mm',
            'index.js', 'NOTICE.md', 'README.md', '../frame.h'
          ],
      ownedSnapshot = new Map(await Promise.all(ownedNames.map(
          async name => [name, await fs.readFile(path.join(here, name))])));
let quick = false, repackage = false;
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === '--repackage') {
    repackage = true;
    continue;
  }
  if (flags[i] === '--quick') {
    quick = true;
    continue;
  }
  if (!['--tools', '--lite2-weights', '--lite2-license', '--base-payload']
           .includes(flags[i]) ||
      !flags[i + 1] || options[flags[i]])
    throw Error('Unknown or repeated build option.');
  options[flags[i]] = path.resolve(flags[++i]);
}
if (quick && repackage)
  throw Error('Repackaging requires an existing complete payload.');
for (const name of ['--tools', '--lite2-weights', '--lite2-license'])
  if (!options[name])
    throw Error('Missing ' + name);
const hash = b => createHash('sha256').update(b).digest('hex'),
      run = (command, args, extra = {}) => new Promise((resolve, reject) => {
        const child = spawn(command, args, {stdio : 'inherit', ...extra});
        child.on('error', reject);
        child.on('close',
                 code => code === 0
                             ? resolve()
                             : reject(Error(command + ' exited ' + code)));
      });
const capture = async (command, args) => {
  let text = '';
  const child = spawn(command, args, {stdio : [ 'ignore', 'pipe', 'inherit' ]});
  for await (const bytes of child.stdout)
    text += bytes;
  await new Promise(
      (resolve, reject) => child.on(
          'close', code => code === 0
                               ? resolve()
                               : reject(Error(command + ' exited ' + code))));
  return text.trim();
};
if (await capture('git', [ '-C', source, 'rev-parse', 'HEAD' ]) !== pin.commit)
  throw Error('FSR4 source pin changed.');
await run('git', [ '-C', source, 'diff', '--exit-code', 'HEAD', '--' ]);
for (const [option, digest] of [[ '--lite2-weights', pin.lite2.sha256 ],
                                [ '--lite2-license', pin.lite2.licenseSha256 ]])
  if (hash(await fs.readFile(options[option])) !== digest)
    throw Error('The pinned Lite2 input changed: ' + option);
const work = path.join(destination, 'source'),
      payload = path.join(destination, 'payload');
await fs.mkdir(work, {recursive : true});
await fs.mkdir(payload, {recursive : true});
const previous =
    repackage
        ? JSON.parse(await fs.readFile(path.join(payload, 'provider.json')))
        : null;

await fs.mkdir(path.join(work, 'owned'), {recursive : true});
for (const [name, bytes] of ownedSnapshot)
  await fs.writeFile(path.join(work, 'owned', name), bytes);

for (const name of ['src', 'tools', 'third_party'])
  await fs.cp(path.join(source, name), path.join(work, name),
              {recursive : true});
const tools = {};
for (const name of ['dxc', 'spirv-cross', 'spirv-val']) {
  const bytes = await fs.readFile(path.join(options['--tools'], name));
  tools[name] = hash(bytes);
  await fs.mkdir(path.join(work, 'tools/bin'), {recursive : true});
  await fs.writeFile(path.join(work, 'tools/bin', name), bytes, {mode : 0o755});
}
const replace = (value, before, after) => {
  if (value.split(before).length !== 2)
    throw Error('FSR4 compiler adaptation changed.');
  return value.replace(before, after);
};
let compiler =
    await fs.readFile(path.join(work, 'tools/compile_fsr411.py'), 'utf8');
compiler =
    replace(compiler, 'digest.update(run(["xcrun", "metal", "--version"]))',
            'digest.update(b"maclauncher-msl-source-v1")');
compiler = replace(
    compiler,
    '        run(["xcrun", "metal", "-std=macos-metal2.3", optimization, *stage_math,\n             "-c", metal, "-o", air], output / f"{name}.metal.log")\n        run(["xcrun", "metallib", air, "-o", lib_path])',
    '        # Portable MSL is compiled by Metal during resource preparation.');
compiler = compiler.replaceAll('.metallib', '.metal');
await fs.writeFile(path.join(work, 'tools/compile_fsr411.py'), compiler);
const runtime = adaptRuntime(
    await fs.readFile(path.join(work, 'src/fsr411_runtime.h'), 'utf8'));
await fs.writeFile(path.join(work, 'src/fsr411_runtime.h'), runtime.source);
await fs.writeFile(path.join(work, 'src/fsr411_helpers.metal'),
                   adaptHelpers(await fs.readFile(
                       path.join(source, 'src/fsr411_helpers.metal'), 'utf8')));
await fs.writeFile(
    path.join(work, 'src/fsr4_log.h'),
    '#pragma once\nstatic inline void fsr4_logf(const char*,...){}\n');
const build = path.join(work, 'build'),
      tiers = quick ? [ 1080 ] : [ 1080, 2160, 4320 ];
await fs.mkdir(build, {recursive : true});
// Optional reuse keeps an existing exact-fast model and shader identity intact.
// The build works without this optimization and never depends on private paths.
if (options['--base-payload']) {
  const base = options['--base-payload'],
        metadata =
            JSON.parse(await fs.readFile(path.join(base, 'provider.json')));
  if (metadata.providerABI !== 1 ||
      !pin.legacyPayloads.some(p => p.commit === metadata.commit) ||
      metadata.profile !== 'exact-fast')
    throw Error('The exact-fast reuse payload has an unknown identity.');
  for (const name of await fs.readdir(path.join(base, 'build'))) {
    if (!/^fsr411_\d.*_fast_pc1_ca1$|^fsr411_native_\d+(?:_ultraperformance)?$|^libraries$/
             .test(name))
      throw Error('Unknown exact-fast cache entry.');
    await fs.cp(path.join(base, 'build', name), path.join(build, name),
                {recursive : true});
  }
  for (const dir of await fs.readdir(build)) {
    if (!/^fsr411_\d.*_fast_pc1_ca1$/.test(dir))
      continue;
    const manifest =
        JSON.parse(await fs.readFile(path.join(build, dir, 'bindings.json')));
    if (manifest.profile !== 'exact-fast')
      throw Error('Reused profile is not exact-fast.');
    for (const entry of Object.values(manifest.kernels))
      for (const [k, digest] of [[ 'library', 'library_sha256' ],
                                 [ 'literal_tables', 'literal_tables_sha256' ]])
        if (entry[k] &&
            hash(await fs.readFile(path.resolve(build, dir, entry[k]))) !==
                entry[digest])
          throw Error('Reused exact-fast shader changed.');
  }
}
// The translation tools use only the standard library; a cache inside the
// output directory keeps uv from writing outside the build.
const python = (script, args) => run(
    'uv',
    [
      'run', '--offline', '--python', '3.12', '--no-project',
      path.join(work, script), ...args
    ],
    {
      env : {
        ...process.env,
        UV_CACHE_DIR : path.join(destination, 'uv-cache'),
        FSR4_LOSSY2_WEIGHTS : options['--lite2-weights']
      }
    });
if (repackage) {
  if (previous.providerABI !== 1 || previous.complete !== true ||
      previous.commit !== pin.commit || previous.model !== pin.model ||
      JSON.stringify(previous.profiles) !== JSON.stringify(pin.profiles) ||
      previous.owned?.['adapt-runtime.mjs'] !==
          hash(ownedSnapshot.get('adapt-runtime.mjs')) ||
      previous.adaptations?.runtime !== hash(runtime.source) ||
      previous.adaptations?.compiler !== hash(compiler) ||
      JSON.stringify(previous.tools) !== JSON.stringify(tools))
    throw Error('Repackaging cannot change compiled shader/model inputs.');
  for (const entry of previous.files) {
    const file = path.join(payload, entry.path);
    if ((await fs.stat(file)).size !== entry.size ||
        hash(await fs.readFile(file)) !== entry.sha256)
      throw Error('A runtime input changed before repackaging: ' + entry.path);
  }
}
if (!repackage)
  for (const tier of tiers)
    for (const ultra of quick ? [ 0 ] : [ 0, 1 ])
      for (const profile of pin.profiles) {
        const suffix = ultra ? '_ultraperformance' : '',
              profileSuffix = profile.id === 'exact-fast'
                                  ? ''
                                  : '_' + profile.upstreamProfile,
              native = path.join(
                  build, `fsr411_native_${tier}${suffix}${profileSuffix}`);
        await python('tools/gen_fsr411_native.py', [
          '--tier', String(tier), '--profile', profile.nativeProfile,
          '--preset', ultra ? 'ultraperformance' : 'normal', '--lossy2-weights',
          options['--lite2-weights'], '--outdir', native
        ]);
        for (const depth of quick ? [ 0 ] : [ 0, 1 ])
          for (const low of quick ? [ 1 ] : [ 0, 1 ])
            for (const jitter of quick ? [ 0 ] : [ 0, 1 ])
              for (const exposure of quick ? [ 0 ] : [ 0, 1 ]) {
                if (options['--base-payload'] && profile.id === 'exact-fast')
                  continue;
                await python('tools/compile_fsr411.py', [
                  '--root',
                  work,
                  '--builddir',
                  build,
                  '--res',
                  String(tier),
                  '--profile',
                  profile.upstreamProfile,
                  '--optimize',
                  '1',
                  '--external-post-cnb',
                  '1',
                  '--post-cnb-alias',
                  '1',
                  '--depth-inverted',
                  String(depth),
                  '--low-res-mv',
                  String(low),
                  '--jittered-mv',
                  String(jitter),
                  '--auto-exposure',
                  String(exposure),
                  '--ultra-performance',
                  String(ultra)
                ]);
              }
      }
if (!repackage) {
  await fs.mkdir(path.join(payload, 'build/libraries'), {recursive : true});
  const copied = new Set();
  for (const dir of await fs.readdir(build)) {
    if (!/^fsr411_\d|^fsr411_native_/.test(dir))
      continue;
    const to = path.join(payload, 'build', dir);
    await fs.mkdir(to, {recursive : true});
    if (/^fsr411_\d/.test(dir)) {
      const manifest =
          JSON.parse(await fs.readFile(path.join(build, dir, 'bindings.json')));
      for (const entry of Object.values(manifest.kernels))
        for (const property of ['library', 'literal_tables']) {
          if (!entry[property])
            continue;
          const bytes =
              await fs.readFile(path.resolve(build, dir, entry[property])),
                name = hash(bytes) + path.extname(entry[property]);
          if (!copied.has(name)) {
            await fs.writeFile(path.join(payload, 'build/libraries', name),
                               bytes);
            copied.add(name);
          }
          entry[property] = '../libraries/' + name;
        }
      await fs.writeFile(path.join(to, 'bindings.json'),
                         JSON.stringify(manifest) + '\n');
    } else
      for (const file of await fs.readdir(path.join(build, dir)))
        if (/\.bin$|^fsr411_native_manifest\.json$/.test(file))
          await fs.copyFile(path.join(build, dir, file), path.join(to, file));
  }
  await fs.mkdir(path.join(payload, 'src'), {recursive : true});
  for (const file
           of ['fsr411_model.h', 'fsr411_helpers.metal', 'fsr411_mpp.metal',
               'fsr411_simd.metal', 'fsr411_reference.metal'])
    await fs.copyFile(path.join(work, 'src', file),
                      path.join(payload, 'src', file));
  await fs.mkdir(path.join(payload, 'third_party/fsr411'), {recursive : true});
  await fs.rm(path.join(payload, 'third_party/fsr411/weights_lossy2.npz'),
              {force : true});
  for (const file of ['initializers.bin', 'initializers-ultraperformance.bin',
                      'LICENSE', 'LICENSE.AMD.md'])
    await fs.copyFile(path.join(work, 'third_party/fsr411', file),
                      path.join(payload, 'third_party/fsr411', file));
  await fs.copyFile(options['--lite2-license'],
                    path.join(payload, 'third_party/fsr411/LICENSE.Lite2.txt'));
}
await fs.mkdir(path.join(destination, 'source-inputs'), {recursive : true});
await fs.copyFile(options['--lite2-weights'],
                  path.join(destination, 'source-inputs/weights_lossy2.npz'));
for (const arch of ['arm64', 'x86_64'])
  await run('xcrun', [
    'clang++',
    '-std=c++17',
    '-O2',
    '-fobjc-arc',
    '-fvisibility=hidden',
    '-dynamiclib',
    '-arch',
    arch,
    '-mmacosx-version-min=13.0',
    '-Werror=unguarded-availability',
    '-I',
    path.join(work, 'src'),
    path.join(work, 'owned/provider.mm'),
    '-framework',
    'Foundation',
    '-framework',
    'Metal',
    '-install_name',
    '@rpath/libmaclauncher-fsr4.dylib',
    '-o',
    path.join(destination, `fsr4-${arch}.dylib`)
  ]);
await run('xcrun', [
  'lipo', '-create', path.join(destination, 'fsr4-arm64.dylib'),
  path.join(destination, 'fsr4-x86_64.dylib'), '-output',
  path.join(payload, 'libmaclauncher-fsr4.dylib')
]);
await run('codesign', [
  '--force', '--sign', '-', path.join(payload, 'libmaclauncher-fsr4.dylib')
]);
await fs.copyFile(path.join(here, 'NOTICE.md'),
                  path.join(payload, 'NOTICE.md'));
const owned = {};
for (const [name, bytes] of ownedSnapshot) {
  owned[name] = hash(bytes);
  if (hash(await fs.readFile(path.join(here, name))) !== owned[name])
    throw Error('An owned FSR4 build input changed during compilation: ' +
                name);
}
const files = [];
for (const relative of (await fs.readdir(payload, {recursive : true})).sort()) {
  if (relative === 'provider.json')
    continue;
  const file = path.join(payload, relative), stat = await fs.stat(file);
  if (stat.isFile())
    files.push({
      path : relative,
      size : stat.size,
      sha256 : hash(await fs.readFile(file))
    });
}
await fs.writeFile(path.join(payload, 'provider.json'), JSON.stringify({
  ...pin,
  providerABI : 1,
  complete : !quick,
  resourcePreparation : 1,
  profilesAPI : 1,
  loadMinimumMacOS : '13.0',
  profile : 'exact-fast',
  colorSpace : 'linear',
  maximumOutput : [ 7680, 4320 ],
  library : 'libmaclauncher-fsr4.dylib',
  sourceInputs : [ {
    path : 'source-inputs/weights_lossy2.npz',
    size : (await fs.stat(options['--lite2-weights'])).size,
    sha256 : pin.lite2.sha256,
    repository : pin.lite2.repository,
    commit : pin.lite2.commit,
    sourceUrl : pin.lite2.url
  } ],
  owned,
  tools,
  adaptations : {runtime : hash(runtime.source), compiler : hash(compiler)},
  files
},
                                                                       null,
                                                                       2) +
                                                            '\n');
console.log(payload);
