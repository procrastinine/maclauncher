#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url)), build = path.resolve(process.argv[2]);
const output = path.join(build, 'forwarder-test'); fs.mkdirSync(output, { recursive: true });
const source = path.join(build, 'source');
const args = ['clang', '-arch', 'x86_64', '-mmacosx-version-min=14.0', '-std=c2x',
  '-I' + path.join(source, 'include'), '-I' + path.join(source, 'src/winemetal'),
  path.join(here, 'forwarder-test.c')];
const base = path.join(output, 'base.dylib'), test = path.join(output, 'test');
execFileSync('xcrun', [...args, '-DML_TEST_BASE', '-dynamiclib', '-o', base], { stdio: 'inherit' });
execFileSync('xcrun', [...args, '-Wl,-export_dynamic', '-o', test], { stdio: 'inherit' });
execFileSync(test, [path.join(build, 'payload/x86_64-unix/winemetal.so'), base], { stdio: 'inherit' });
