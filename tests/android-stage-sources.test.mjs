import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {sourceInventory, sourceIdentity, snapshotSources} from '../src/modules/android/native/build-sources.mjs';
import {verifyAndroidSourceSnapshot, copyAndroidSourceSnapshot, archiveAndroidUpstreamSource, archiveAndroidSourceTree, filterAndroidSourceArchive} from '../scripts/android-stage-sources.mjs';
import Content from '../scripts/runtime-content.cjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-stage-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
  const module=path.join(root,'module'),snapshot=path.join(root,'build/source');
  write(path.join(module,'native/bionic/build.mjs'),"import {prepareAimSource} from '../../art/source.mjs'; export const owner=prepareAimSource();\n");
  write(path.join(module,'profile.js'),'module.exports={};\n');
  write(path.join(module,'art/source.mjs'),"import {owner} from './adapter.mjs';export function prepareAimSource(){return owner;}\n");
  write(path.join(module,'art/adapter.mjs'),"export const owner='frozen-original';\n");
  write(path.join(module,'art/native/boundary.rs'),'original owned boundary\n');
  write(path.join(module,'art/launch.mjs'),'launcher-only source\n');
  snapshotSources(path.join(module,'native'),snapshot);
  write(path.join(snapshot,'build-tools/src/modules/shared/runtime/helper.js'),'module.exports={};\n');
  const native=sourceInventory(path.join(snapshot,'native')),profile=fs.readFileSync(path.join(snapshot,'profile.js'));
  const tools=sourceInventory(path.join(snapshot,'build-tools')),art=sourceInventory(path.join(snapshot,'art'));
  return {root,module,snapshot,write,receipt:sourceIdentity(native,profile,tools,art),legacy:sourceIdentity(native,profile,tools)};
}
function copy(input,output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(input,output);}

test('Android staging retains the frozen ART build closure and its relative Bionic import in the source archive',async t=>{
  const f=fixture(t),identity=verifyAndroidSourceSnapshot(f.snapshot,f.receipt);
  assert.deepEqual(identity,f.receipt);
  assert.deepEqual(identity.artSources.map(row=>row.path),['adapter.mjs','native/boundary.rs','source.mjs']);
  f.write(path.join(f.module,'art/adapter.mjs'),"export const owner='later-checkout';\n");
  assert.deepEqual(verifyAndroidSourceSnapshot(f.snapshot,f.receipt),identity,'The live checkout does not replace a completed build snapshot');
  const sources=path.join(f.root,'sources');
  copyAndroidSourceSnapshot(f.snapshot,identity,sources,copy);
  assert.equal(fs.existsSync(path.join(sources,'src/modules/android/art/launch.mjs')),false,'Unconsumed launcher orchestration is not added');
  const archive=path.join(f.root,'source.tar.gz'),extracted=path.join(f.root,'extracted');fs.mkdirSync(extracted);
  execFileSync('/usr/bin/tar',['-czf',archive,'-C',sources,'.']);
  execFileSync('/usr/bin/tar',['-xzf',archive,'-C',extracted]);
  const consumer=await import(pathToFileURL(path.join(extracted,'src/modules/android/native/bionic/build.mjs')));
  assert.equal(consumer.owner,'frozen-original','The actual archived relative import resolves its original owned adapter');
  assert.equal(fs.readFileSync(path.join(extracted,'src/modules/android/art/native/boundary.rs'),'utf8'),'original owned boundary\n');
  assert.equal(fs.existsSync(path.join(extracted,'src/modules/shared/runtime/helper.js')),true);
});

test('Android staging rejects changed or added recorded ART inputs and preserves legacy source identities',t=>{
  const f=fixture(t),adapter=path.join(f.snapshot,'art/adapter.mjs'),original=fs.readFileSync(adapter);
  fs.appendFileSync(adapter,'// changed after build\n');
  assert.throws(()=>verifyAndroidSourceSnapshot(f.snapshot,f.receipt),/source identity is invalid/);
  fs.writeFileSync(adapter,original);
  f.write(path.join(f.snapshot,'art/new-boundary.rs'),'unrecorded input');
  assert.throws(()=>verifyAndroidSourceSnapshot(f.snapshot,f.receipt),/source identity is invalid/);
  fs.unlinkSync(path.join(f.snapshot,'art/new-boundary.rs'));
  assert.deepEqual(verifyAndroidSourceSnapshot(f.snapshot,f.receipt),f.receipt);
  assert.deepEqual(verifyAndroidSourceSnapshot(f.snapshot,f.legacy),f.legacy,'Completed legacy receipts keep their original three-part identity');
  const legacy=path.join(f.root,'legacy-sources');copyAndroidSourceSnapshot(f.snapshot,f.legacy,legacy,copy);
  assert.equal(fs.existsSync(path.join(legacy,'src/modules/android/art')),false,'A legacy receipt does not silently acquire new source inputs');
  assert.throws(()=>verifyAndroidSourceSnapshot(f.snapshot,{...f.receipt,artSources:'invalid'}),/source identity is invalid/);
});

test('Android source publication omits recorded test-only inputs without changing completed build identities',t=>{
  const f=fixture(t);
  f.write(path.join(f.snapshot,'native/bionic/jit-view-test.rs'),'#[cfg(test)] mod fixture {}\n');
  f.write(path.join(f.snapshot,'native/tests/probe.c'),'test-only source\n');
  f.write(path.join(f.snapshot,'art/fixtures/probe.rs'),'test-only source\n');
  f.write(path.join(f.snapshot,'build-tools/src/modules/shared/runtime/helper.test.js'),'test-only helper\n');
  f.write(path.join(f.snapshot,'native/decompiler/testcasedecompiler.py'),'production decompiler\n');
  f.write(path.join(f.snapshot,'native/NOTICE'),'required notice\n');
  const receipt=sourceIdentity(sourceInventory(path.join(f.snapshot,'native')),
    fs.readFileSync(path.join(f.snapshot,'profile.js')),sourceInventory(path.join(f.snapshot,'build-tools')),
    sourceInventory(path.join(f.snapshot,'art')));
  const before=JSON.stringify(receipt),identity=verifyAndroidSourceSnapshot(f.snapshot,receipt);
  const sources=path.join(f.root,'production-sources');copyAndroidSourceSnapshot(f.snapshot,identity,sources,copy);
  assert.equal(JSON.stringify(receipt),before);
  assert.deepEqual(verifyAndroidSourceSnapshot(f.snapshot,receipt),receipt);
  const published=sourceInventory(sources).map(row=>row.path);
  assert.deepEqual(published.filter(name=>Content.excludedReason(name)),[]);
  assert.ok(published.includes('src/modules/android/native/decompiler/testcasedecompiler.py'));
  assert.ok(published.includes('src/modules/android/native/NOTICE'));
  assert.ok(published.includes('src/modules/android/art/native/boundary.rs'));
  assert.ok(published.includes('src/modules/shared/runtime/helper.js'));
  assert.equal(published.some(name=>name.includes('jit-view-test')),false);
});

test('embedded pinned source archives omit test trees and retain production helpers and notices',t=>{
  const f=fixture(t),checkout=path.join(f.root,'supplier');fs.mkdirSync(checkout);
  for(const [name,bytes]of Object.entries({
    'src/original.c':'production source\n','tools/source-helper.py':'required build helper\n',
    'decompiler/testcasedecompiler.py':'production decompiler\n','LICENSE':'required license\n',
    'NOTICE':'required notice\n','tests/probe.c':'test-only source\n',
    'AGENTS.md':'process-only instructions\n',
    'src/fixtures/input.c':'test-only fixture\n','src/owner_test.cc':'test-only source\n',
    'src/literal[abc]/tests/probe.c':'test-only literal path\n',
    'torch/testsuites/examples/model.yml':'unused test suite data\n',
    'src/literala/original.c':'production literal neighbor\n',
    'bundler/templates/newgem/test/test_helper.rb.tt':'consumed generator template\n'
  }))f.write(path.join(checkout,name),bytes);
  execFileSync('git',['-C',checkout,'init','--quiet']);
  execFileSync('git',['-C',checkout,'add','.']);
  const revision=execFileSync('git',['-C',checkout,'write-tree'],{encoding:'utf8'}).trim();
  const index=fs.readFileSync(path.join(checkout,'.git/index'));
  const archive=path.join(f.root,'supplier.tar'),result=archiveAndroidUpstreamSource(checkout,revision,archive);
  assert.ok(result.excludedMembers.includes('tests'));
  assert.ok(result.excludedMembers.includes('src/literal[abc]/tests'));
  const extracted=path.join(f.root,'supplier-extracted');fs.mkdirSync(extracted);
  execFileSync('/usr/bin/tar',['-xf',archive,'-C',extracted]);
  const published=sourceInventory(extracted).map(row=>row.path);
  assert.deepEqual(published.filter(name=>Content.excludedReason(name)),[]);
  assert.deepEqual(published,[
    'bundler/templates/newgem/test/test_helper.rb.tt','decompiler/testcasedecompiler.py',
    'LICENSE','NOTICE','src/literala/original.c','src/original.c','tools/source-helper.py'
  ].sort((a,b)=>a.localeCompare(b)));
  assert.deepEqual(fs.readFileSync(path.join(checkout,'.git/index')),index);
  assert.equal(fs.existsSync(path.join(checkout,'tests/probe.c')),true);
});

test('pinned release source archives omit unused tests without changing original archives or production bytes',t=>{
  const f=fixture(t),source=path.join(f.root,'release'),archive=path.join(f.root,'original.tar.gz'),output=path.join(f.root,'published.tar.gz');
  for(const [name,bytes]of Object.entries({'src/original.c':'original codec source\n','cmake/FindCodec.cmake':'consumed build helper\n',
    'decompiler/testcasedecompiler.py':'production converter\n','LICENSE':'license\n','tests/probe.c':'unused test\n',
    'agents.MD':'process-only instructions\n',
    'dnn/torch/testsuite/examples/model.yml':'unused test suite configuration\n',
    'src/literal[abc]/tests/probe.c':'unused literal-path test\n','src/literala/original.c':'retained literal neighbor\n'}))f.write(path.join(source,name),bytes);
  execFileSync('/usr/bin/tar',['-czf',archive,'-C',source,'.']);const before=fs.readFileSync(archive);
  const result=filterAndroidSourceArchive(archive,output);assert.ok(result.excludedMembers.length);
  assert.deepEqual(fs.readFileSync(archive),before,'The pinned input archive stays immutable');
  const extracted=path.join(f.root,'release-extracted');fs.mkdirSync(extracted);execFileSync('/usr/bin/tar',['-xf',output,'-C',extracted]);
  const published=sourceInventory(extracted).map(row=>row.path);
  assert.deepEqual(published,['cmake/FindCodec.cmake','decompiler/testcasedecompiler.py','LICENSE','src/literala/original.c','src/original.c'].sort((a,b)=>a.localeCompare(b)));
  for(const name of published)assert.deepEqual(fs.readFileSync(path.join(extracted,name)),fs.readFileSync(path.join(source,name)));
  assert.throws(()=>filterAndroidSourceArchive(archive,archive),/requires a new archive/);
});

test('Android source tree and filtered gzip archives remain identical across creation seconds',async t=>{
  const f=fixture(t),release=path.join(f.root,'release'),original=path.join(f.root,'original.tar.gz');
  const contents={'src/nested/original.c':'production source\n','LICENSE':'required license\n'};
  for(const [name,bytes]of Object.entries({...contents,'tests/probe.c':'unused test\n'}))f.write(path.join(release,name),bytes);
  execFileSync('/usr/bin/tar',['-czf',original,'-C',release,'.']);const input=fs.readFileSync(original);
  const publish=label=>{
    const tree=path.join(f.root,'tree-'+label),archive=path.join(f.root,'tree-'+label+'.tar.gz');
    for(const [name,bytes]of Object.entries(contents))f.write(path.join(tree,name),bytes);
    archiveAndroidSourceTree(tree,archive);
    const filtered=path.join(f.root,'filtered-'+label+'.tar.gz');filterAndroidSourceArchive(original,filtered);
    return [archive,filtered].map(file=>fs.readFileSync(file));
  };
  const first=publish('first');await new Promise(resolve=>setTimeout(resolve,1100));const second=publish('second');
  for(let index=0;index<first.length;index++){
    assert.equal(first[index].readUInt32LE(4),0,'gzip header contains no wall-clock timestamp');
    assert.deepEqual(second[index],first[index],'unchanged source content keeps its archive bytes');
  }
  assert.deepEqual(fs.readFileSync(original),input,'The pinned input archive remains unchanged');
});
