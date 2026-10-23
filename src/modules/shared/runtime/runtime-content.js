// Shared development/import and packaged-runtime boundary. A source archive
// declared by the delivery model is an opaque corresponding-source input;
// it is not an executable/importable test directory.
const path = require('node:path');
const fs = require('node:fs');

const testDirectories = ['test', 'tests', 'testsuite', 'testsuites', 'spec', 'specs', '__tests__', 'fixture', 'fixtures', '__fixtures__', 'testcases', 'testdata', 'test-data', '__mocks__'];
const generatedDirectories = ['.build', '.swiftpm', 'CMakeFiles', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'test-results', 'playwright-report'];
const generatedFiles = new Set(['CMakeCache.txt', 'CTestTestfile.cmake', 'build.ninja', '.ninja_log', '.ninja_deps', 'compile_commands.json']);
const instructionFiles = ['AGENTS.md'];
// A gem "spec" is a runtime package specification, and e.g. Ruby's
// rdoc/markup/to_test.rb is a production converter. Use test-source naming
// conventions, not arbitrary words or substring matches in vendor assets.
const sourceExtensions = ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'm', 'mm', 'swift', 'js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'mts', 'cts', 'py', 'rs', 'java', 'fx', 'sh', 'go'];
const namedTest = new RegExp('(?:^tests?(?:$|[-_.])|[-_]tests?(?:$|\\.(?:' + sourceExtensions.join('|') + ')(?:\\.|$))|\\.(?:test|spec)\\.(?:' + sourceExtensions.join('|') + ')(?:\\.|$))', 'i');
const insensitive = value => [...value].map(char => /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char).join('');
const testNames = `{${['test', 'tests'].map(insensitive).join(',')}}`;
const extensions = `{${sourceExtensions.join(',')}}`;
const excludedGlobs = Object.freeze([
  ...[...testDirectories, ...generatedDirectories].flatMap(name => [`**/${insensitive(name)}`, `**/${insensitive(name)}/**`]),
  '**/*.xctest', '**/*.xctest/**', '**/*.dSYM', '**/*.dSYM/**',
  `**/${testNames}{,[-_.]*}`, `**/*[-_]${testNames}`, `**/*[-_]${testNames}.${extensions}{,.*}`,
  `**/*.{${['test', 'spec'].map(insensitive).join(',')}}.${extensions}{,.*}`,
  ...generatedFiles.values(), ...instructionFiles.map(insensitive)
].map(pattern => '!' + (pattern.includes('/') ? pattern : '**/' + pattern)));

function excludedReason(file) {
  const parts = String(file).replaceAll('\\', '/').split('/').filter(Boolean);
  // Bundler::CLI::Gem copies these templates into generated gems. They are
  // production generator inputs, including its test-framework templates.
  const templates = parts.findIndex((part, index) => part === 'bundler' && parts[index + 1] === 'templates' && parts[index + 2] === 'newgem');
  const executableParts = templates < 0 ? parts : parts.slice(0, templates + 3);
  if (parts.some(part => instructionFiles.some(name => name.toLowerCase() === part.toLowerCase()))) return 'process instruction file';
  if (executableParts.some(part => testDirectories.some(name => name.toLowerCase() === part.toLowerCase()) || /\.xctest$/i.test(part))) return 'test directory or fixture';
  if (parts.some(part => generatedDirectories.includes(part) || /\.dSYM$/.test(part)) || generatedFiles.has(parts.at(-1))) return 'generated build or test output';
  if (executableParts.some(part => namedTest.test(part))) return 'test source or runner filename';
  return null;
}
function assertRuntimePath(file) {
  const reason = excludedReason(file);
  if (reason) throw new Error(`Runtime content excludes ${reason}: ${file}`);
  return file;
}
function withExclusions(filter = ['**/*']) { return [...new Set([...filter, ...excludedGlobs])]; }
function applyBuildPolicy(build) {
  return { ...build,
    files: [...(build.files || []).map(rule => typeof rule === 'string' ? rule : { ...rule, filter: withExclusions(rule.filter) }), ...excludedGlobs],
    extraResources: (build.extraResources || []).map(rule => typeof rule === 'string' ? rule : { ...rule, filter: withExclusions(rule.filter) })
  };
}
function ownedPath(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && relative !== '..' ? relative : null;
}
function assertOwnedImport(root, file) {
  // No filesystem operations for external packages, third-party games or node
  // builtins. A development guard never owns those namespaces.
  const relative = ownedPath(root, file);
  if (!relative || !relative.startsWith('src' + path.sep)) return;
  assertRuntimePath(relative);
  // The resolved path can still name a source symlink. Check its real target
  // once per module resolution, including aliases into a fixture directory.
  let real;
  try { real = fs.realpathSync(file); } catch { return; }
  const target = ownedPath(root, real);
  if (target) assertRuntimePath(target);
}

module.exports = { testDirectories, generatedDirectories, excludedGlobs, excludedReason,
  assertRuntimePath, withExclusions, applyBuildPolicy, ownedPath, assertOwnedImport };
