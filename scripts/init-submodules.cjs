#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const LIMITS = Object.freeze({ modules: 512, output: 2 * 1024 * 1024 });

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || path.isAbsolute(value) ||
      /[\\\x00-\x1f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Submodule paths must be safe repository-relative paths.');
  }
  return value;
}

function boolean(value, key) {
  if (/^(true|yes|on|1)$/i.test(value) || value === '') return true;
  if (/^(false|no|off|0)$/i.test(value)) return false;
  throw new Error('Invalid boolean in submodule ' + key + '.');
}

function parseGitModules(output) {
  const declarations = new Map();
  for (const row of output.split('\0').filter(Boolean)) {
    const newline = row.indexOf('\n');
    const key = row.slice(0, newline), value = row.slice(newline + 1);
    const match = /^submodule\.(.+)\.(path|url|maclauncher-init|maclauncher-recursive)$/i.exec(key);
    if (newline < 0 || !match) throw new Error('Invalid Git submodule metadata.');
    const [, name, rawField] = match, field = rawField.toLowerCase();
    const declaration = declarations.get(name) || { name };
    if (Object.hasOwn(declaration, field)) throw new Error('Duplicate submodule metadata: ' + name + '.' + field + '.');
    declaration[field] = value;
    declarations.set(name, declaration);
  }
  if (declarations.size > LIMITS.modules) throw new Error('Too many submodule declarations.');
  const seen = new Set();
  return [...declarations.values()].map(item => {
    const location = relativePath(item.path), folded = location.toLowerCase();
    if (seen.has(folded)) throw new Error('Duplicate submodule checkout path.');
    seen.add(folded);
    if (typeof item.url !== 'string' || !item.url || /[\x00-\x1f]/.test(item.url)) throw new Error('Submodule URL is missing or invalid.');
    return { name: item.name, path: location, url: item.url,
      initialize: item['maclauncher-init'] === undefined || boolean(item['maclauncher-init'], 'maclauncher-init'),
      recursive: item['maclauncher-recursive'] === undefined || boolean(item['maclauncher-recursive'], 'maclauncher-recursive') };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function gitEnvironment(environment = process.env) {
  const env = { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  return env;
}

async function runGit(args, { cwd, mutation = false, signal, environment } = {}) {
  return execute('git', ['-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false', '--literal-pathspecs', ...args], {
    cwd, env: gitEnvironment(environment), encoding: 'utf8', maxBuffer: LIMITS.output,
    timeout: mutation ? 20 * 60 * 1000 : 60000, signal
  });
}

function origin(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x20]/.test(value)) throw new Error('Invalid source mirror URL.');
  const url = new URL(value);
  if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Source mirror URLs must be public repository URLs without credentials.');
  return url.href.replace(/\.git\/?$/, '').replace(/\/$/, '');
}

function readMirrors(root, declarations, modules) {
  const file = path.join(root, 'scripts/upstream-overlays.json');
  if (!fs.existsSync(file)) return [];
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > LIMITS.output)
    throw new Error('Source inventory must be a bounded regular file.');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(inventory.projects) || inventory.projects.length > LIMITS.modules)
    throw new Error('Invalid source inventory projects.');
  const projects = new Map(inventory.projects.map(project => [project.id, project]));
  if (projects.size !== inventory.projects.length) throw new Error('Duplicate source inventory project.');
  const mirrors = [], urls = new Map();
  for (const project of inventory.projects.filter(item => item.checkoutOrigin !== undefined)) {
    const location = relativePath(project.path);
    const top = modules.find(item => location === item.path || item.recursive && location.startsWith(item.path + '/'));
    if (!top) continue;
    const repository = origin(project.repository), checkoutOrigin = origin(project.checkoutOrigin);
    if (!/^[a-f0-9]{40}$/.test(project.revision || '') || !project.checkoutOriginReason?.trim())
      throw new Error('A source mirror requires an exact revision and origin reason.');
    if (urls.has(repository) && urls.get(repository) !== checkoutOrigin) throw new Error('Conflicting source mirrors.');
    urls.set(repository, checkoutOrigin);
    let parent;
    if (location === top.path) {
      if (project.revision !== top.revision || repository !== origin(declarations.find(item => item.path === location).url))
        throw new Error('Source mirror differs from its top-level Gitlink.');
    } else {
      const ancestor = projects.get(project.parent);
      if (!ancestor || !/^[a-f0-9]{40}$/.test(ancestor.revision || '') ||
          !location.startsWith(relativePath(ancestor.path) + '/') ||
          ancestor.path !== top.path && !ancestor.path.startsWith(top.path + '/'))
        throw new Error('Nested source mirror requires its pinned parent.');
      parent = { path: ancestor.path, revision: ancestor.revision, relative: location.slice(ancestor.path.length + 1) };
    }
    mirrors.push({ path: location, revision: project.revision, repository, checkoutOrigin, ...(parent ? { parent } : {}) });
  }
  return mirrors;
}

function containedPath(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Submodule checkout paths must not traverse symbolic links.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function readPlan({ repoRoot = ROOT, paths = [], all = false, run = runGit, signal } = {}) {
  const root = fs.realpathSync(repoRoot);
  const top = (await run(['rev-parse', '--show-toplevel'], { cwd: root, signal })).stdout.trim();
  if (fs.realpathSync(top) !== root) throw new Error('Submodule initialization requires the repository root.');
  if (!fs.lstatSync(path.join(root, '.gitmodules')).isFile()) throw new Error('.gitmodules must be a regular file.');
  let output;
  try {
    output = (await run(['config', '--null', '--file', '.gitmodules', '--get-regexp',
      '^submodule\\..*\\.(path|url|maclauncher-init|maclauncher-recursive)$'], { cwd: root, signal })).stdout;
  } catch (error) { if (error.code === 1) output = ''; else throw error; }
  const declarations = parseGitModules(output);
  const requested = new Set(paths.map(relativePath));
  for (const location of requested) if (!declarations.some(item => item.path === location)) throw new Error('Unknown top-level submodule path: ' + location + '.');
  if (!declarations.length) return { modules: [], skipped: [], mirrors: [] };
  const indexed = (await run(['ls-files', '--stage', '-z', '--', ...declarations.map(item => item.path)], { cwd: root, signal })).stdout;
  const links = new Map();
  for (const row of indexed.split('\0').filter(Boolean)) {
    const match = /^160000 ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/.exec(row);
    if (!match || links.has(match[2])) throw new Error('Submodule declarations require unambiguous staged Gitlinks.');
    links.set(match[2], match[1]);
  }
  const modules = [], skipped = [];
  for (const item of declarations) {
    const revision = links.get(item.path);
    if (!revision) throw new Error('Missing pinned Gitlink for ' + item.path + '.');
    const selected = requested.size ? requested.has(item.path) : all || item.initialize;
    const record = { path: item.path, revision, recursive: item.recursive };
    if (selected) { containedPath(root, item.path); modules.push(record); }
    else skipped.push({ ...record, reason: requested.size ? 'not-selected' : 'reference-only' });
  }
  return { modules, skipped, mirrors: readMirrors(root, declarations, modules) };
}

async function restoreMirrorOrigins(root, mirrors, run, signal) {
  for (const mirror of mirrors) {
    containedPath(root, mirror.path);
    const directory = path.join(root, mirror.path);
    const top = (await run(['rev-parse', '--show-toplevel'], { cwd: directory, signal })).stdout.trim();
    if (fs.realpathSync(top) !== fs.realpathSync(directory) ||
        (await run(['rev-parse', 'HEAD'], { cwd: directory, signal })).stdout.trim() !== mirror.revision)
      throw new Error('Source mirror checkout differs from its pinned Gitlink.');
    if (mirror.parent) {
      containedPath(root, mirror.parent.path);
      const parent = path.join(root, mirror.parent.path);
      if ((await run(['rev-parse', 'HEAD'], { cwd: parent, signal })).stdout.trim() !== mirror.parent.revision)
        throw new Error('Source mirror parent differs from its pinned revision.');
      const link = (await run(['ls-tree', '-z', mirror.parent.revision, '--', mirror.parent.relative], { cwd: parent, signal })).stdout;
      if (link !== '160000 commit ' + mirror.revision + '\t' + mirror.parent.relative + '\0')
        throw new Error('Nested source mirror differs from its parent Gitlink.');
      const metadata = (await run(['config', '--null', '--blob', mirror.parent.revision + ':.gitmodules', '--get-regexp',
        '^submodule\\..*\\.(path|url)$'], { cwd: parent, signal })).stdout;
      const declaration = parseGitModules(metadata).find(item => item.path === mirror.parent.relative);
      if (!declaration || origin(declaration.url) !== mirror.repository)
        throw new Error('Nested source mirror differs from its upstream declaration.');
    }
    await run(['config', '--local', 'remote.origin.url', mirror.checkoutOrigin], { cwd: directory, mutation: true, signal });
  }
}

async function initSubmodules({ repoRoot = ROOT, paths = [], all = false, jobs = 4, dryRun = false,
  run = runGit, signal, onProgress } = {}) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 16) throw new Error('Submodule jobs must be an integer from 1 to 16.');
  const plan = await readPlan({ repoRoot, paths, all, run, signal });
  if (dryRun) return plan;
  const cwd = fs.realpathSync(repoRoot);
  const mirrorConfig = [...new Map(plan.mirrors.map(item => [item.repository, item.checkoutOrigin]))]
    .flatMap(([repository, checkoutOrigin]) => ['-c', 'url.' + checkoutOrigin + '.insteadOf=' + repository]);
  for (const recursive of [false, true]) {
    const selected = plan.modules.filter(item => item.recursive === recursive);
    if (!selected.length) continue;
    const recursion = recursive ? ['--recursive'] : [];
    onProgress?.({ recursive, paths: selected.map(item => item.path) });
    await run([...mirrorConfig, 'submodule', 'sync', ...recursion, '--', ...selected.map(item => item.path)], { cwd, mutation: true, signal });
    await run([...mirrorConfig, 'submodule', 'update', '--init', '--checkout', '--jobs', String(jobs), ...recursion,
      '--', ...selected.map(item => item.path)], { cwd, mutation: true, signal });
  }
  await restoreMirrorOrigins(cwd, plan.mirrors, run, signal);
  return plan;
}

function parseArgs(argv) {
  const options = { paths: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { options.paths.push(...argv.slice(index + 1)); break; }
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--jobs') options.jobs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('Use -- before selected submodule paths.');
  }
  return options;
}

if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: node scripts/init-submodules.cjs [--dry-run] [--all] [--jobs N] [-- PATH ...]\n' +
        'Initialize pinned build inputs. --all includes reference-only sources; explicit paths select individual top-level sources.\n' +
        '.gitmodules controls recursive versus primary-only checkout. --dry-run performs no initialization or fetching.\n');
      return;
    }
    const result = await initSubmodules({ ...options, onProgress: value => process.stdout.write(
      'Initializing ' + value.paths.length + ' pinned submodule' + (value.paths.length === 1 ? '' : 's') +
      (value.recursive ? ' with nested dependencies.\n' : ' without nested dependencies.\n')) });
    if (options.dryRun) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else process.stdout.write('Initialized ' + result.modules.length + ' pinned sources; skipped ' + result.skipped.length + ' sources.\n');
  })().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

module.exports = { ROOT, LIMITS, relativePath, parseGitModules, readPlan, initSubmodules, parseArgs, runGit };
