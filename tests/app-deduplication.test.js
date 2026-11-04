const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const D=require('../scripts/app-deduplication.cjs'),B=require('../src/modules/shared/runtime/bundled-native');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'app-dedup-')),app=path.join(root,'MacLauncher.app');fs.mkdirSync(app);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,app};}
function write(root,name,bytes,mode=0o644){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode});return file;}
test('app assembly stores one binary across included packages, unpacked ASAR and Python while preserving logical bytes',t=>{
 const {app}=fixture(t),bytes=Buffer.from('PK\x03\x04one shared jar');
 const names=['Contents/Resources/native-runtimes/java/profile-a/steam-agent.jar','Contents/Resources/native-runtimes/java/profile-b/steam-agent.jar','Contents/Resources/app.asar.unpacked/agent.jar','Contents/Resources/python/lib/helper.jar'];
 for(const name of names)write(app,name,bytes);
 write(app,'Contents/Resources/licenses/LICENSE','same notice');write(app,'Contents/Resources/notices/LICENSE','same notice');
 write(app,'Contents/Resources/one.png','artwork');write(app,'Contents/Resources/two.png','artwork');
 const result=D.collapse(app);assert.equal(result.aliases,3);assert.equal(result.bytesRemoved,bytes.length*3);
 assert.equal(names.filter(name=>fs.lstatSync(path.join(app,name)).isFile()).length,1);
 for(const name of names){const file=path.join(app,name);assert.deepEqual(fs.readFileSync(file),bytes);if(fs.lstatSync(file).isSymbolicLink()){assert.equal(path.isAbsolute(fs.readlinkSync(file)),false);assert.ok(fs.realpathSync(file).startsWith(app+path.sep));}}
 const record={files:[{path:'steam-agent.jar',size:bytes.length,mode:0o644,sha256:B.digest(bytes)}]};
 for(const profile of ['profile-a','profile-b'])assert.equal(B.withAppBundle(app,()=>B.verifyPayload(path.join(app,'Contents/Resources/native-runtimes/java',profile),record)),true);
 assert.deepEqual(D.collapse(app),{aliases:0,bytesRemoved:0});
});
test('canonical storage retains executable mode and bundle aliases cannot escape or introduce extras',t=>{
 const {root,app}=fixture(t),bytes=Buffer.from('binary\0 executable');
 const regular=write(app,'Contents/Resources/a/tool.bin',bytes),executable=write(app,'Contents/Resources/z/tool.bin',bytes,0o755);
 D.collapse(app);assert.equal(fs.lstatSync(executable).isFile(),true);assert.ok(fs.statSync(regular).mode&0o111);
 const manifest={files:[{path:'tool.bin',size:bytes.length,mode:0o644,sha256:B.digest(bytes)}]};
 assert.equal(B.withAppBundle(app,()=>B.verifyPayload(path.dirname(regular),manifest)),true);
 write(app,'Contents/Resources/a/extra.bin',bytes);assert.throws(()=>B.withAppBundle(app,()=>B.verifyPayload(path.dirname(regular),manifest)),/inventory differs/);
 fs.unlinkSync(regular);const outside=write(root,'outside.bin',bytes);fs.symlinkSync(outside,regular);assert.throws(()=>B.withAppBundle(app,()=>B.readRegular(regular,bytes.length)),/relative/);
 fs.unlinkSync(regular);fs.symlinkSync(path.relative(path.dirname(regular),outside),regular);assert.throws(()=>B.withAppBundle(app,()=>B.readRegular(regular,bytes.length)),/escapes/);
});
test('packed ASAR binary collisions are retained, and preparation requests actual selected binary unpacking',async t=>{
 const {root,app}=fixture(t),source=path.join(root,'source'),resources=path.join(app,'Contents/Resources');
 const binary=write(source,'agent.jar',Buffer.from('PK\x03\x04one agent'));
 fs.mkdirSync(resources,{recursive:true});await require('@electron/asar').createPackage(source,path.join(resources,'app.asar'));
 write(resources,'copy.jar',fs.readFileSync(binary));
 assert.deepEqual(D.collapse(app),{aliases:0,bytesRemoved:0});
 assert.deepEqual(fs.readFileSync(path.join(resources,'copy.jar')),fs.readFileSync(binary));
 write(source,'tests/unshipped.jar',fs.readFileSync(binary));
 write(source,'node_modules/example/dependency.jar',fs.readFileSync(binary));
 const packageConfig={build:{files:['agent.jar'],directories:{output:'dist'},mac:{}}};
 assert.deepEqual(D.unpackPatterns({projectDir:source,packageConfig}),['agent.jar','node_modules/**/example/dependency.jar']);
});

test('incompatible duplicate permissions and existing external aliases are retained',t=>{
 const {root,app}=fixture(t),bytes=Buffer.from('PK\x03\x04data');
 const first=write(app,'a.jar',bytes,0o600),second=write(app,'b.jar',bytes,0o644),outside=write(root,'outside.jar',bytes);
 fs.symlinkSync(outside,path.join(app,'outside-link.jar'));
 assert.deepEqual(D.collapse(app),{aliases:0,bytesRemoved:0});
 assert.equal(fs.lstatSync(first).isFile(),true);assert.equal(fs.lstatSync(second).isFile(),true);
 assert.equal(fs.readlinkSync(path.join(app,'outside-link.jar')),outside);assert.deepEqual(fs.readFileSync(outside),bytes);
});

test('unpack preparation retains input path containment and rejects cyclic source aliases',t=>{
 const {root}=fixture(t),source=path.join(root,'source');fs.mkdirSync(source);
 write(source,'one.jar',Buffer.from('PK\x03\x04data'));
 const packageConfig={build:{files:['**/*'],directories:{output:'dist'},mac:{}}};
 fs.symlinkSync('.',path.join(source,'cycle'));
 assert.throws(()=>D.unpackPatterns({projectDir:source,packageConfig}),/escaping or cyclic/);
 fs.unlinkSync(path.join(source,'cycle'));
 packageConfig.build.files=[{from:'../outside',to:'.',filter:['**/*']}];
 assert.throws(()=>D.unpackPatterns({projectDir:source,packageConfig}),/checkout-relative/);
});
