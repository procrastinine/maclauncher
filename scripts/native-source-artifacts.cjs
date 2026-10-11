// Corresponding source travels with release inputs, separately from app data.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const B = require('../src/modules/shared/runtime/bundled-native');
const S = require('./native-supplementals.cjs');

function validate(item) {
  if (!item || Object.keys(item).some(key => !['managerId', 'version', 'directoryRelative', 'sha256', 'bytes'].includes(key)) ||
      !/^[a-z0-9-]+$/.test(item.managerId || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.version || '') ||
      !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > B.LIMITS.fileBytes ||
      B.relativeFile(item.directoryRelative) !== item.directoryRelative || !item.directoryRelative.endsWith('-source.tar.gz') ||
      item.directoryRelative !== `${item.managerId}/${item.version}-source.tar.gz`) {
    throw new Error('Invalid corresponding-source archive identity.');
  }
  S.validatePublicMetadata(item);
  return item;
}

function requirements(required, managers, supplementals = []) {
  const result = new Map();
  function add(managerId, version, archive) {
    const item = validate({ managerId, version, ...archive });
    if (item.managerId !== managerId || item.version !== version) throw new Error('Source archive does not match its runtime catalog entry.');
    const previous = result.get(item.directoryRelative);
    if (previous && !isDeepStrictEqual(previous, item)) throw new Error('Conflicting corresponding-source archive identities.');
    result.set(item.directoryRelative, item);
  }
  for (const runtime of required) {
    const pin = managers.get(runtime.managerId)?.core.catalog.find(item => item.version === runtime.version);
    if (!pin?.sourceArtifact) continue;
    add(runtime.managerId, runtime.version, pin.sourceArtifact);
  }
  if (!Array.isArray(supplementals)) throw new Error('Source requirements need an explicit supplemental resource list.');
  for (const item of supplementals) if (item.sourceArtifact) add(item.id, item.version, item.sourceArtifact);
  return [...result.values()].sort((a, b) => a.directoryRelative.localeCompare(b.directoryRelative));
}

function validateInventory(items, required, managers, supplementals = []) {
  const expected = requirements(required, managers, supplementals);
  if (!isDeepStrictEqual(items || [], expected)) throw new Error('Corresponding-source archives differ from the runtime catalogs.');
  return expected;
}

function verify(root, items) {
  return items.map(item => {
    validate(item);
    const file = path.join(root, item.directoryRelative), content = B.readRegular(file, item.bytes);
    if (content.size !== item.bytes || content.sha256 !== item.sha256 || content.mode !== 0o644) throw new Error('Corresponding-source archive checksum, size or permissions changed.');
    return { item, file };
  });
}

// Source archives are immutable. Existing identical files are reused; unrelated
// archives are left alone. New files roll back if native publication fails.
function preparePublication(sourceRoot, destination, items) {
  const jobs = [], created = [];
  try {
    for (const { item, file } of verify(sourceRoot, items)) {
      const target = path.join(destination, item.directoryRelative);
      B.realDirectory(path.dirname(target), { create: true });
      if (fs.existsSync(target)) { verify(destination, [item]); continue; }
      const temporary = path.join(path.dirname(target), `.source-${process.pid}-${require('node:crypto').randomUUID()}`);
      jobs.push({ target, temporary });
      const content = B.readRegular(file, item.bytes);
      if (content.sha256 !== item.sha256 || content.size !== item.bytes) throw new Error('Corresponding source changed during publication.');
      fs.writeFileSync(temporary, content.bytes, { flag: 'wx', mode: 0o644 });
      fs.chmodSync(temporary, 0o644);
    }
    for (const job of jobs) {
      // Hard-link publication refuses a concurrent writer without overwriting.
      fs.linkSync(job.temporary, job.target); created.push(job.target);
      fs.unlinkSync(job.temporary);
    }
    verify(destination, items);
    return { rollback() { for (const file of created) fs.unlinkSync(file); } };
  } catch (error) {
    for (const file of created) fs.unlinkSync(file);
    throw error;
  } finally {
    for (const job of jobs) fs.rmSync(job.temporary, { force: true });
  }
}

module.exports = { validate, requirements, validateInventory, verify, preparePublication };
