const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const B = require('../src/modules/shared/runtime/bundled-native');
const {packageFor} = require('./helpers/managed-tool-fixture.cjs');
const {image, ARM64, X64} = require('./fixtures/macho-image');

for (const kind of ['project', 'native']) test(`${kind} managed installs accept independently described inventories and archive metadata`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-inventory-')));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  for (const placement of ['none', 'wrapper', 'inner', 'unlisted', 'beside', 'changed', 'omitted']) await t.test(placement, async () => {
    const id = 'sample-inventory', directory = path.join(root,placement), prefix = kind === 'native' ? 'files/' : '';
    const fixture = packageFor(directory, {id, version:'9.0', architecture:process.arch, filesPrefix:prefix,
      manifest:{managerId:id, platform:'darwin', executableRelative:'bin/host', upstreamRevision:'a'.repeat(40),
        provenance:{sourceRevision:'a'.repeat(40)}, dependencies:[]},
      entries:[{path:'bin/host', bytes:image({cpu:process.arch === 'x64' ? X64 : ARM64, fileType:2, installName:null}),
        mode:0o755, architectures:[process.arch === 'x64' ? 'x86_64' : 'arm64']},
        {path:'optional.txt',bytes:Buffer.from('optional data'),mode:0o644}]});
    const stage = path.join(directory,'archive-input'), payload = path.join(stage,'files');
    const wrapperFile = path.join(stage,'runtime-package.json'), wrapper = JSON.parse(fs.readFileSync(wrapperFile));
    for (const name of ['none','changed','omitted'].includes(placement) ? [] : ['build-definition.json','build-inputs.json']) {
      const bytes = Buffer.from('{}\n'), relative = prefix + name;
      fs.writeFileSync(placement === 'beside' ? path.join(stage,name) : path.join(payload,relative), bytes);
      const fact = {path:name,size:bytes.length,mode:0o644,sha256:B.digest(bytes)};
      if (placement === 'wrapper') wrapper.files.push({...fact,path:relative});
      if (placement === 'inner') fixture.manifest.files.push(fact);
    }
    if (placement === 'changed') {
      const file = path.join(payload,prefix,'optional.txt');
      fs.writeFileSync(file,Buffer.alloc(fs.statSync(file).size,0x58));
    }
    if (placement === 'omitted') fs.unlinkSync(path.join(payload,prefix,'optional.txt'));
    if (placement === 'inner') {
      const bytes = Buffer.from(JSON.stringify(fixture.manifest));
      fs.writeFileSync(path.join(payload,'manifest.json'),bytes);
      wrapper.manifestSha256 = fixture.record.manifestSha256 = B.digest(bytes);
      Object.assign(wrapper.files.find(file=>file.path==='manifest.json'),{sha256:B.digest(bytes),size:bytes.length});
    }
    fs.writeFileSync(wrapperFile,JSON.stringify(wrapper));
    execFileSync('/usr/bin/tar',['-czf',fixture.archive,'-C',stage,...fs.readdirSync(stage).sort()]);
    Object.assign(fixture.record.asset,{sha256:B.digest(fs.readFileSync(fixture.archive)),bytes:fs.statSync(fixture.archive).size});
    fixture.record.source = {repository:'procrastinine/maclauncher-builds',revision:'b'.repeat(40)};
    let corrupt = false;
    const dependencies = {systemVersionSync:()=> '27.0',
      fetchUrlBuffer:async()=>({status:200,body:Buffer.from(JSON.stringify(fixture.catalog))}),
      downloadToFile:async(_url,destination)=>{fs.copyFileSync(fixture.archive,destination);if(corrupt)fs.appendFileSync(destination,'corrupt transport');}};
    const inspectRuntime = ({runtimePath,runtimeVersion})=>({runtimePath,executablePath:runtimePath,runtimeVersion,architecture:process.arch,ready:true});
    const manager = kind === 'project'
      ? require('../src/modules/shared/runtime/project-build-manager').createProjectBuildManager({projectId:id,label:'Fixture',
        repository:'procrastinine/maclauncher-builds',manifestRelative:'manifest.json',sourceRelative:null,
        executableRelative:'bin/host',inspectRuntime,verifyPayload:selected=>B.verifyPayload(selected.root,selected.declaration),dependencies})
      : require('../src/modules/shared/runtime/pinned-native-manager').createPinnedNativeManager({id,label:'Fixture',
        projectBuilds:{projectId:id,repository:'procrastinine/maclauncher-builds'},inspectRuntime,
        dependencies:{...dependencies,projectBuilds:{...dependencies,verifySignatures:async()=>{}}}});
    const userDataDir = path.join(directory,'profile');
    await manager.refreshCatalog({userDataDir,force:true});
    const installed = await manager.installRuntime({userDataDir,version:fixture.record.version});
    assert.equal(installed.version,fixture.record.version);
    assert.equal(manager.resolveSelection({}, {}, userDataDir).ready,true);
    if (placement === 'none') {
      corrupt = true;
      await assert.rejects(manager.installRuntime({userDataDir:path.join(directory,'corrupt-profile'),version:fixture.record.version}),/checksum|SHA-256|size/i);
    }
    if (['unlisted','changed','omitted'].includes(placement)) {
      assert.throws(()=>B.verifyPayload(payload,wrapper),/inventory|checksum|permissions/,'Bundled declarations still enforce their exact inventory and bytes');
      const verifier = require('../src/modules/android/runtime-verifier');
      t.after(()=>verifier.close());
      await verifier.verifyPayload(payload,B.managedDeclaration({...wrapper}));
      await assert.rejects(verifier.verifyPayload(payload,wrapper),/inventory|checksum|permissions/,'Worker verification preserves the bundled boundary too');
    }
  });
});
