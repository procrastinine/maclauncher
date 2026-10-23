'use strict';

// Developer/test data only. Never imported by Android preparation or a guest.
function compositionProblems(universe, decisions, suppliers) {
  const problems = [];
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..');
  const unique = (rows, label) => {
    const result = new Map();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id) { problems.push(`${label}: missing identity`); continue; }
      if (result.has(row.id)) problems.push(`${label}: duplicate ${row.id}`);
      result.set(row.id, row);
    }
    return result;
  };
  const components = unique(universe.components, 'inventory');
  const choices = unique(decisions, 'decision');
  const delivered = unique(suppliers, 'supplier');
  const ownership = new Map();
  for (const id of choices.keys()) if (!components.has(id)) problems.push(`Unknown decision: ${id}`);
  for (const [id, component] of components) {
    const choice = choices.get(id);
    if (!choice) { problems.push(`Missing decision: ${id}`); continue; }
    if (choice.include !== true && choice.include !== false) problems.push(`Unresolved decision: ${id}`);
    if (typeof choice.reason !== 'string' || !choice.reason.trim()) problems.push(`Missing reason: ${id}`);
    if (typeof choice.action !== 'string' || !choice.action.trim()) problems.push(`Missing action: ${id}`);
    if (choice.include !== true) continue;
    const supplier = delivered.get(choice.supplier);
    if (!supplier) { problems.push(`Missing supplier: ${id}`); continue; }
    const witness = supplier.components?.find(row => row.id === id);
    if (!witness) { problems.push(`Supplier does not contain component: ${id}`); continue; }
    if (typeof component.revision !== 'string' || !component.revision || witness.revision !== component.revision) problems.push(`Supplier revision mismatch: ${id}`);
    if (!Array.isArray(witness.products) || witness.products.length === 0) problems.push(`No delivered product: ${id}`);
    for (const product of witness.products || []) {
      if (!safePath(product.path) || !digest(product.sha256)) problems.push(`Invalid product identity: ${id}:${product.path}`);
      const actual = supplier.products?.find(item => item.path === product.path);
      if (!actual || !digest(actual.sha256) || actual.sha256 !== product.sha256) problems.push(`Missing or changed product: ${id}:${product.path}`);
    }
    for (const dependency of component.dependencies || []) {
      if (!components.has(dependency)) { problems.push(`Dependency absent from inventory: ${id}->${dependency}`); continue; }
      const target = choice.dependencies?.[dependency] || dependency;
      if (!choices.get(target)?.include) problems.push(`Dependency has no included owner: ${id}->${dependency}`);
      if (target !== dependency && !choice.boundaries?.some(b => b.dependency === dependency && b.owner === target && b.reason?.trim())) {
        problems.push(`Dependency substitution lacks boundary: ${id}->${dependency}`);
      }
    }
    for (const symbol of component.exports || []) if (!witness.exports?.includes(symbol)) problems.push(`Missing export: ${id}:${symbol}`);
    for (const member of component.javaMembers || []) if (!witness.javaMembers?.includes(member)) problems.push(`Missing Java member: ${id}:${member}`);
    for (const resource of choice.owns || []) {
      if (ownership.has(resource)) problems.push(`Competing resource owners: ${resource}:${ownership.get(resource)},${id}`);
      else ownership.set(resource, id);
    }
  }
  // The baseline comes from the original artifact, not the decisions being checked.
  const suppliedMembers = new Set(suppliers.flatMap(s => (s.components || []).flatMap(c => c.javaMembers || [])));
  for (const member of universe.javaMembers || []) if (!suppliedMembers.has(member)) problems.push(`Original Java baseline omitted: ${member}`);
  return problems;
}

function assertComposition(universe, decisions, suppliers) {
  const problems = compositionProblems(universe, decisions, suppliers);
  if (problems.length) throw new Error('Android component composition is incomplete:\n' + problems.join('\n'));
}
module.exports = { compositionProblems, assertComposition };

// Read delivered Mach-O load commands instead of trusting a declared dependency list.
// The staging reader is shared; this collector neither copies nor changes binaries.
function nativeArtifactEvidence(runtime, products) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const Native = require('../../src/modules/shared/runtime/local-native');
  const Stage = require('../../scripts/stage-native-runtimes.cjs');
  const actualRoot = fs.realpathSync(runtime), artifacts = [], problems = [];
  const files = new Map();
  for (const product of products) {
    const file = path.resolve(actualRoot, product.path);
    if (!file.startsWith(actualRoot + path.sep)) throw new Error('Product escapes runtime: ' + product.path);
    try { files.set(fs.realpathSync(file), product); } catch { continue; }
    let architectures;
    try { architectures = Native.readMachOArchitectures(file, { allowLibrary: true }); } catch { continue; }
    const selected = architectures.includes('arm64') ? 'arm64' : architectures[0];
    const commands = Stage.loadCommands(file, selected);
    const ids = Stage.libraryIds(file, selected);
    const links = Stage.links(file, selected).filter(link => !ids.includes(link));
    const symbols = execFileSync('/usr/bin/nm', ['-arch', selected, '-gUj', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n').filter(s => s.startsWith('_')).map(s => s.slice(1));
    artifacts.push({ path: product.path, sha256: product.sha256, architectures, minimumMacOS: commands.minimumMacOS,
      rpaths: commands.rpaths, installNames: ids, links, symbols: [...new Set(symbols)].sort(), dependencies: [] });
  }
  // Runtime executable load commands are the only inherited search roots. Do not
  // resolve missing libraries by searching arbitrary developer filesystem paths.
  const executables = artifacts.filter(a => !a.installNames.length);
  for (const artifact of artifacts) for (const link of artifact.links) {
    if (link.startsWith('/usr/lib/') || link.startsWith('/System/Library/')) {
      artifact.dependencies.push({ link, owner: 'macOS' }); continue;
    }
    const source = path.join(actualRoot, artifact.path), attempts = executables.length ? executables : [artifact];
    let dependency, lastError;
    for (const executable of attempts) {
      try {
        dependency = Stage.resolveLink(link, source, path.join(actualRoot, executable.path), executable.rpaths,
          artifact.architectures.includes('arm64') ? 'arm64' : artifact.architectures[0]);
        if (dependency) break;
      } catch (error) { lastError = error.message; }
    }
    const product = dependency && files.get(dependency);
    if (!product) {
      problems.push('Native dependency lacks a delivered product: ' + artifact.path + ' -> ' + link + (lastError ? ': ' + lastError : ''));
      artifact.dependencies.push({ link, owner: null, resolved: dependency || null });
    } else artifact.dependencies.push({ link, owner: product.path, sha256: product.sha256 });
  }
  return { artifacts, problems };
}
module.exports.nativeArtifactEvidence = nativeArtifactEvidence;
