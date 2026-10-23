const assert = require('node:assert/strict');
const test = require('node:test');
const S = require('../scripts/native-supplementals.cjs');
const Modules = require('../src/modules/registry');
const fs = require('node:fs');
const path = require('node:path');

test('registered supplemental declarations have pure module exports and complete pinned inventories', () => {
  const declarations = S.declarations();
  const exported = Modules.listModules().flatMap(info => Modules.getModule(info.id)?.distributionSupplementals || []);
  for (const submodule of Modules.listSharedSubmodules()) {
    const declaration = path.join(submodule.dir, 'distribution-supplementals.json');
    if (fs.existsSync(declaration)) exported.push(...JSON.parse(fs.readFileSync(declaration, 'utf8')));
  }
  assert.deepEqual(declarations, exported);
  assert.ok(declarations.length);
  for (const item of declarations) {
    if (item.sourceRelative) {
      assert.ok(item.files.some(file => file.path === item.sourceRelative && file.sha256 === item.sourceSha256));
    } else {
      const sources = require('../scripts/native-source-artifacts.cjs').requirements([], new Map(), [item]);
      assert.deepEqual(sources, item.sourceArtifact ? [{ managerId: item.id, version: item.version, ...item.sourceArtifact }] : []);
      assert.equal(item.files.some(file => file.path.endsWith('-source.tar.gz')), false);
    }
    assert.ok(item.files.some(file => file.path === item.manifestRelative && file.sha256 === item.manifestSha256));
    assert.ok(item.files.some(file => file.architectures));
    assert.ok(item.notices.every(notice => item.files.some(file => file.path === notice.path)));
  }
});
test('release verification refuses a backend missing from the resilient runtime registry', () => {
  const lookup = Modules.getModule, missing = Modules.listModules()[0].id;
  Modules.getModule = id => id === missing ? null : lookup(id);
  try { assert.throws(() => S.declarations(), /Backend module failed to load for release verification/); }
  finally { Modules.getModule = lookup; }
});
test('experimental graphics helpers are excluded from the release resource selection', () => {
  assert.equal(S.declarations().some(item => item.id === 'gamemaker-opengl-helper'), false);
  const distribution = require('../scripts/distribution-model.cjs');
  const plan = distribution.createPlan({ arch: 'arm64', maximumMacOS: '13.0' });
  const resources = distribution.resourceRules(plan).find(rule => rule.from === 'src/resources');
  assert.equal(resources.filter.some(pattern => pattern.includes('gamemaker-opengl-helper')), false);
});
