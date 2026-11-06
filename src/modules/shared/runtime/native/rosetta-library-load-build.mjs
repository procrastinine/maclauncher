// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** Build-time only; the installed launcher runs the packaged x64 helper. */
export function buildRosettaLibraryLoader({output, compiler = '/usr/bin/clang'}) {
  if (typeof output !== 'string' || !path.isAbsolute(output))
    throw new Error('The helper output path must be absolute.');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const temporary = fs.mkdtempSync(path.join(path.dirname(output), '.rosetta-library-load-'));
  const executable = path.join(temporary, 'rosetta-library-load');
  try {
    const source = fileURLToPath(new URL('./rosetta-library-load.c', import.meta.url));
    execFileSync(compiler, ['-arch', 'x86_64', '-mmacosx-version-min=11.0', '-std=c11',
      '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], {stdio: 'inherit'});
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', executable], {stdio: 'inherit'});
    fs.renameSync(executable, output);
    return {executablePath: output, architecture: 'x86_64'};
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}
