const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createProjectNativePackage}=require('../src/modules/shared/runtime/project-native-package');
const {image,ARM64}=require('./fixtures/macho-image');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,{prefixed=false,primary,primaryField='executable',fallback='libbridge.dylib',missing=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'project-primary-fallback-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=image({cpu:ARM64}),name=primary||'libbridge.dylib',file=path.join(root,prefixed?'files':'',name);
 fs.mkdirSync(path.dirname(file),{recursive:true});if(!missing)fs.writeFileSync(file,bytes,{mode:0o755});
 const manifest={schemaVersion:1,id:'sample-helper',version:'1.0.0',arch:'arm64',minimumMacOS:'13.0',protocolABI:1,
  files:[{path:name,size:bytes.length,sha256:sha(bytes),mode:0o755,architectures:['arm64']}],...(primary?{[primaryField]:name}:{})};
 const text=JSON.stringify(manifest);fs.writeFileSync(path.join(root,'helper.json'),text);
 const project={schemaVersion:2,id:'sample-helper',version:'1.0.0',arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'13.0',manifestRelative:'helper.json',manifestSha256:sha(text),sourceSha256:sha(text),updatePolicy:'manual',tag:'sample-helper/v1.0.0/arm64',
  asset:{filename:'sample-helper-1.0.0-arm64.tar.gz',sha256:'a'.repeat(64),bytes:1,url:'https://github.com/ExampleOwner/runtime-builds/releases/download/sample-helper%2Fv1.0.0%2Farm64/sample-helper-1.0.0-arm64.tar.gz'}};
 const adapter=createProjectNativePackage({projectId:'sample-helper',repository:'ExampleOwner/runtime-builds',executableRelative:fallback},{id:'sample-helper',catalog:[],nativeLibrary:true});
 return{root,file,adapter,pin:{version:'1.0.0',upstreamRevision:'b'.repeat(40),projectPackage:project},manifest};
}
test('project native protocol manifests use the configured direct-root primary',t=>{
 const f=fixture(t),selected=f.adapter.inspect(f.root,f.pin);assert.equal(selected.executablePath,f.file);assert.equal(selected.manifest.protocolABI,1);
 assert.equal(Object.hasOwn(selected.manifest,'executableRelative'),false,'protocol metadata is not rewritten');
});
test('project native fallback retains legacy files prefix and manifest primary precedence',t=>{
 const legacy=fixture(t,{prefixed:true});assert.equal(legacy.adapter.inspect(legacy.root,legacy.pin).executablePath,legacy.file);
 const own=fixture(t,{primary:'owned.dylib',fallback:'absent-fallback.dylib'});assert.equal(own.adapter.inspect(own.root,own.pin).executablePath,own.file);
 const explicit=fixture(t,{primary:'explicit.dylib',primaryField:'executableRelative',fallback:'absent-fallback.dylib'});assert.equal(explicit.adapter.inspect(explicit.root,explicit.pin).executablePath,explicit.file);
});
test('project native fallback refuses missing and escaping primary paths',t=>{
 const missing=fixture(t,{missing:true});assert.throws(()=>missing.adapter.inspect(missing.root,missing.pin),/ENOENT|unavailable|regular|missing/);
 const escaping=fixture(t,{fallback:'../outside.dylib'});assert.throws(()=>escaping.adapter.inspect(escaping.root,escaping.pin),/relative|path|invalid/i);
});
