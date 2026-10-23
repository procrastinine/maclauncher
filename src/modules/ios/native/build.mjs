import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const source = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] || path.join(source, 'arm64'));
fs.mkdirSync(output, {recursive:true});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-ios-build-'));
const object = path.join(temporary, 'playtools-interpose.o');
const identity = path.join(temporary, 'device-identity.o');
const library = path.join(output, 'libplaytools-paths.dylib');
const run = (tool, args) => execFileSync(tool, args, {stdio:'inherit'});
try {
run('/usr/bin/xcrun', ['clang', '-target', 'arm64-apple-macos12', '-fPIC', '-c', path.join(source,'playtools-interpose.c'), '-o', object]);
run('/usr/bin/xcrun', ['clang', '-target', 'arm64-apple-macos12', '-fobjc-arc', '-fPIC', '-c', path.join(source,'device-identity.m'), '-o', identity]);
run('/usr/bin/xcrun', ['swiftc', '-target', 'arm64-apple-macosx12.0', '-module-cache-path', path.join(temporary,'modules'), '-O', '-emit-library', '-module-name', 'MacLauncherPlayToolsPaths',
  path.join(source,'playtools-paths.swift'), object, identity, '-Xlinker', '-install_name', '-Xlinker', '@rpath/libplaytools-paths.dylib', '-o', library]);
run('/usr/bin/codesign', ['--force', '--sign', '-', library]);
console.log(library);
} finally { fs.rmSync(temporary, {recursive:true,force:true}); }
