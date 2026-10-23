#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyCameraOverlay } from './patch.mjs';
import Production from '../../../shared/runtime/production-source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [upstreamArg, vendorArg, compilerArg, outputArg] = process.argv.slice(2);
const nativeOnly = process.argv.includes('--native-only');
if (!outputArg) throw new Error('Usage: build.mjs DXMT_SOURCE DXMT_WINE_DIRECTORY LLVM_MINGW_BIN OUTPUT [--native-only]');
const [upstream, vendor, toolchain, output] = [upstreamArg, vendorArg, compilerArg, outputArg].map(p => path.resolve(p));
const revision = '7c8dee1c2d73415301ceb7d1fa810861cef4cd67';
let sourceRevision;
try { sourceRevision = JSON.parse(fs.readFileSync(path.join(upstream, '.maclauncher-upstream.json'), 'utf8')).revision; }
catch { sourceRevision = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
if (sourceRevision !== revision)
  throw new Error('DXMT camera adaptation requires its recorded source revision.');
const source = path.join(output, 'source'), objects = path.join(output, 'objects'), payload = path.join(output, 'payload');
fs.mkdirSync(output, { recursive: true });
fs.cpSync(upstream, source, { recursive: true, filter: p => !p.split(path.sep).includes('.git') });
fs.mkdirSync(objects, { recursive: true });
for (const arch of ['x86_64-windows', 'x86_64-unix']) fs.mkdirSync(path.join(payload, arch), { recursive: true });
const shared = path.resolve(here, '../../../shared/reshade/temporal');
for (const file of ['camera.h', 'frame.h']) fs.copyFileSync(path.join(shared, file), path.join(source, 'include', file));
fs.copyFileSync(path.join(here, 'camera-transport.hpp'), path.join(source, 'include/camera-transport.hpp'));
applyCameraOverlay(source);
fs.writeFileSync(path.join(source, 'include/version.h'), `#pragma once\n#define DXMT_VERSION "v0.80-244-g7c8dee1-maclauncher-camera1"\n`);

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (nativeOnly) {
  const previous = JSON.parse(fs.readFileSync(path.join(payload, 'camera-bridge.json'), 'utf8'));
  if (previous.source?.revision !== revision || ['d3d11', 'dxgi', 'nvngx'].some(name => {
    const file = 'x86_64-windows/' + name + '.dll';return sha(path.join(payload, file)) !== previous.files?.[file];
  })) throw new Error('Native-only builds require the unchanged PE libraries from an existing complete build.');
}
const vendorPE = path.join(vendor, 'x86_64-windows'), vendorUnix = path.join(vendor, 'x86_64-unix/winemetal.so');
// The unchanged portable command library is taken from the installed renderer.
// This does not rebuild its shader compiler or introduce a Metal toolchain at play.
const original = fs.readFileSync(path.join(vendorPE, 'd3d11.dll'));
const libs = [];
for (let at = original.indexOf('MTLB'); at >= 0; at = original.indexOf('MTLB', at + 4)) {
  if (at + 24 > original.length) continue;
  const length = Number(original.readBigUInt64LE(at + 16));
  if (length >= 100 && length < original.length - at) libs.push(original.subarray(at, at + length));
}
if (libs.length !== 1) throw new Error(`Expected one DXMT portable command library, found ${libs.length}`);
fs.writeFileSync(path.join(output, 'dxmt_command.metallib'), libs[0]);
execFileSync('xxd', ['-n', 'dxmt_command', '-i', path.join(output, 'dxmt_command.metallib'), path.join(source, 'include/dxmt_command.h')]);

const cc = path.join(toolchain, 'x86_64-w64-mingw32-clang');
const cxx = path.join(toolchain, 'x86_64-w64-mingw32-clang++');
const ar = path.join(toolchain, 'llvm-ar');
const readobj = path.join(toolchain, 'llvm-readobj');
const imports = execFileSync(readobj, ['--coff-exports', path.join(vendorPE, 'winemetal.dll')], { encoding: 'utf8' });
const exportNames = [...imports.matchAll(/^  Name: (.+)$/gm)].map(m => m[1]);
if (!exportNames.includes('MTLCommandBuffer_encodeTemporalScale')) throw new Error('Renderer lacks temporal scaling exports.');
const def = path.join(objects, 'winemetal.def');
fs.writeFileSync(def, `LIBRARY winemetal.dll\nEXPORTS\n${exportNames.join('\n')}\n`);
const wineImport = path.join(objects, 'libwinemetal.a');
execFileSync(path.join(toolchain, 'x86_64-w64-mingw32-dlltool'), ['-d', def, '-l', wineImport]);

const include = ['include', 'libs', 'src/util', 'src/airconv', 'src/winemetal', 'src/dxmt', 'src/dxgi', 'src/d3d11'].map(p => '-I' + path.join(source, p));
const common = ['-O2', '-DNDEBUG', '-DNOMINMAX', '-D_WIN32_WINNT=0xa00', '-DDXMT_PAGE_SIZE=4096',
  '-fblocks', '-Wno-unused-parameter', '-Wno-unused-private-field', '-Wno-missing-field-initializers',
  '-Wno-microsoft-exception-spec', '-Wno-extern-c-compat', '-Wno-missing-braces',
  '-ffile-prefix-map=' + source + '=dxmt', ...include];
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(log) : reject(new Error(`${exe} ${args.join(' ')}\n${log}`)));
  });
}
function list(dir, variable) {
  const meson = fs.readFileSync(path.join(source, dir, 'meson.build'), 'utf8');
  const start = meson.indexOf(variable + ' = '), begin = meson.indexOf('[', start), end = meson.indexOf(']', begin);
  if (start < 0) throw new Error(`Missing source list ${variable}`);
  return [...meson.slice(begin, end).split('\n').filter(s => !s.trim().startsWith('#')).join('\n').matchAll(/'([^']+\.(?:cpp|c))'/g)]
      .map(m => path.normalize(path.join(dir, m[1])));
}
const groups = {
  util: [...list('src/util', 'util_src'), 'src/util/wsi_monitor_win32.cpp', 'src/util/wsi_window_win32.cpp', 'src/util/wsi_platform_win32.cpp'],
  dxbc: list('libs/DXBCParser', 'dxbc_parser_src'),
  dxmt: list('src/dxmt', 'dxmt_src'),
  dxgi: list('src/dxgi', 'dxgi_src'),
  d3d11: [...list('src/d3d11', 'd3d11_src'), ...list('src/d3d11', 'd3d10_src')],
  nvngx: list('src/nvngx', 'nvngx_src'),
};
const all = [...new Set(Object.values(groups).flat())];
const objectFor = file => path.join(objects, file.replaceAll('/', '_') + '.o');
let cursor = 0;
if (!nativeOnly) {
await Promise.all(Array.from({ length: Math.min(8, os.availableParallelism()) }, async () => {
  while (cursor < all.length) {
    const file = all[cursor++], c = file.endsWith('.c');
    await run(c ? cc : cxx, [...common, ...(c ? [] : ['-std=c++20']), '-c', path.join(source, file), '-o', objectFor(file)]);
  }
}));
const archive = name => path.join(objects, 'lib' + name + '.a');
for (const name of ['util', 'dxbc', 'dxmt']) execFileSync(ar, ['rcs', archive(name), ...groups[name].map(objectFor)]);
const outPE = path.join(payload, 'x86_64-windows');
for (const name of ['dxgi', 'd3d11', 'nvngx']) {
  const dll = path.join(outPE, name + '.dll');
  const args = ['-shared', '-static', '-Wl,--file-alignment=4096', '-Wl,--out-implib,' + archive(name), '-o', dll,
    ...groups[name].map(objectFor)];
  if (name !== 'nvngx') args.push(path.join(source, 'src', name, name + '.def'));
  else args.push('-Wl,--export-all-symbols');
  if (name !== 'dxgi') args.push(archive('dxgi'));
  args.push(archive('dxmt'), archive('dxbc'), archive('util'), wineImport, '-ldxguid', '-ld3dcompiler', '-luser32', '-lgdi32', '-ladvapi32', '-lsetupapi');
  await run(cxx, args);
  execFileSync(path.join(toolchain, 'llvm-strip'), ['--strip-unneeded', dll]);
  // Wine's builtin marker is in the unused DOS stub, leaving the PE image intact.
  const data = fs.readFileSync(dll);
  if (data.readUInt32LE(0x3c) < 80) throw new Error('PE image has no builtin marker space.');
  data.write('Wine builtin DLL\0', 64, 'ascii'); fs.writeFileSync(dll, data);
}
}

const unixSource = fs.readFileSync(path.join(source, 'src/winemetal/unix/winemetal_unix.c'), 'utf8');
const table = unixSource.match(/const void \*__wine_unix_call_funcs\[\] = \{([\s\S]+?)\};/)[1];
const count = table.split(',').filter(s => s.trim()).length;
const unixOut = path.join(payload, 'x86_64-unix/winemetal.so');
await run('xcrun', ['clang', '-arch', 'x86_64', '-mmacosx-version-min=13.0', '-std=c2x', '-dynamiclib', '-O2',
  '-DML_UNIX_CALL_COUNT=' + count, ...include, '-Wl,-install_name,@rpath/winemetal.so',
  path.join(here, 'unix-forwarder.c'), '-o', unixOut]);
execFileSync('codesign', ['--force', '--sign', '-', unixOut], { stdio: 'pipe' });
for (const name of ['LICENSE', 'COPYING.LIB', 'LICENSE.OLD']) fs.copyFileSync(path.join(upstream, name), path.join(payload, name));
const files = {};
for (const name of ['d3d11', 'dxgi', 'nvngx']) files['x86_64-windows/' + name + '.dll'] = sha(path.join(payload, 'x86_64-windows', name + '.dll'));
files['x86_64-unix/winemetal.so'] = sha(unixOut);
const archiveRoot = path.join(output, 'corresponding-source');
fs.rmSync(archiveRoot, { recursive: true, force: true }); fs.mkdirSync(archiveRoot, { recursive: true });
const archivedSource = path.join(archiveRoot, 'dxmt-source'); fs.mkdirSync(archivedSource);
if (fs.existsSync(path.join(upstream, '.maclauncher-upstream.json'))) {
  fs.cpSync(upstream, archivedSource, { recursive: true, filter: p => !p.split(path.sep).includes('.git') });
} else {
  const tar = path.join(output, 'dxmt-source.tar');
  const fd = fs.openSync(tar, 'w');
  try { execFileSync('git', ['-C', upstream, 'archive', '--format=tar', revision], { stdio: ['ignore', fd, 'pipe'] }); }
  finally { fs.closeSync(fd); }
  execFileSync('tar', ['-xf', tar, '-C', archivedSource]); fs.unlinkSync(tar);
}
fs.writeFileSync(path.join(archivedSource, '.maclauncher-upstream.json'), JSON.stringify({ revision }) + '\n');
const ownedArchive = path.join(archiveRoot, 'maclauncher/src/modules/crossover/temporal/dxmt');
fs.cpSync(here, ownedArchive, { recursive: true });
const sharedArchive = path.join(archiveRoot, 'maclauncher/src/modules/shared/reshade/temporal');
fs.mkdirSync(sharedArchive, { recursive: true });
for (const name of ['camera.h', 'frame.h']) fs.copyFileSync(path.join(shared, name), path.join(sharedArchive, name));
const runtimeArchive = path.join(archiveRoot, 'maclauncher/src/modules/shared/runtime');
fs.mkdirSync(runtimeArchive, { recursive: true });
for (const name of ['production-source.js', 'runtime-content.js'])
  fs.copyFileSync(path.resolve(here, '../../../shared/runtime', name), path.join(runtimeArchive, name));
fs.writeFileSync(path.join(archiveRoot, 'PRODUCTION_SOURCE_PROFILE.json'), JSON.stringify(Production.prune(archiveRoot), null, 2) + '\n');
fs.writeFileSync(path.join(archiveRoot, 'BUILD.md'), `# DXMT camera adaptation source\n\nThe dxmt-source directory contains DXMT ${revision}. The maclauncher directory contains the owned build and camera overlay and shared ABI headers.\n\nOn macOS 14 or later, install the macOS command-line developer tools, Node.js, and LLVM-MinGW 20261006 (universal macOS UCRT). Obtain the matching managed DXMT renderer identified by the base digests in camera-bridge.json. Its unchanged winemetal.dll, winemetal.so and portable command library remain the binary dependencies; no proprietary component is included in this source archive.\n\nRun from this directory:\n\n    node maclauncher/src/modules/crossover/temporal/dxmt/build.mjs dxmt-source /path/to/dxmt/wine /path/to/llvm-mingw/bin /path/to/output\n\nThe output payload can replace the corresponding adapted libraries. Camera metadata transport changes are in patch.mjs, camera-transport.hpp and unix-forwarder.c. DXMT source changes can be made in dxmt-source before building; upstream checkout files are copied before the owned overlay is applied.\n`);
execFileSync('tar', ['-czf', path.join(payload, 'source.tar.gz'), '-C', archiveRoot, '.']);
files['source.tar.gz'] = sha(path.join(payload, 'source.tar.gz'));
fs.writeFileSync(path.join(payload, 'camera-bridge.json'), JSON.stringify({
  schema: 1, id: 'dxmt-camera1', source: { url: 'https://github.com/3Shain/dxmt', revision },
  architecture: 'x86_64', minimumMacOS: '14.0.0', tableCount: count,
  base: { nativeSha256: sha(vendorUnix), thunkSha256: sha(path.join(vendorPE, 'winemetal.dll')),
    commandLibrarySha256: crypto.createHash('sha256').update(libs[0]).digest('hex') }, files,
}, null, 2) + '\n');
console.log(payload);
