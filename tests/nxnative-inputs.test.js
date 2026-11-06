const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {inspectBinary}=require('../src/modules/nxnative/detect');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nx-nup-metadata-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'arbitrary-name.bin');}
test('NUP magic recognizes truncated and unavailable metadata without reading payload',t=>{
 const file=fixture(t);for(const length of [4,127,128]){const bytes=Buffer.alloc(length);bytes.set([78,85,80,1]);fs.writeFileSync(file,bytes);const result=inspectBinary(file);assert.equal(result.format,'nup');assert.equal(result.keyRequirement,'none');assert.equal(result.titleId,null);assert.deepEqual(result.versions,[]);assert.equal(result.selectedUpdate,null);}
});
test('NUP metadata tolerates upstream flags, codecs and TOC changes and reads only package identity',t=>{
 const file=fixture(t),bytes=Buffer.alloc(128+48+128);bytes.set([78,85,80,1]);bytes.writeBigUInt64LE(128n,8);bytes.writeUInt32LE(2,72);
 const base=128+48,update=base+64;bytes.writeBigUInt64LE(0x0100000000010000n,base);bytes.writeBigUInt64LE(0x0100000000010800n,update);bytes[update+24]=1;bytes.writeUInt32LE(7,update+20);
 // Everything unrelated to package identity is deliberately invalid for the old app parser.
 bytes.writeUInt32LE(0xffffffff,76);bytes[base+25]=255;bytes[base+26]=255;bytes.write('NEW!',128);
 fs.writeFileSync(file,bytes);const result=inspectBinary(file);assert.equal(result.titleId,'0100000000010000');assert.deepEqual(result.versions,['v0','v7']);assert.equal(result.selectedUpdate,'v7');assert.equal(result.generation,null);
 bytes.writeBigUInt64LE(2n**63n,8);fs.writeFileSync(file,bytes);assert.equal(inspectBinary(file).format,'nup');assert.deepEqual(inspectBinary(file).versions,[]);
 bytes.writeUInt32LE(0xffffffff,72);fs.writeFileSync(file,bytes);assert.equal(inspectBinary(file).titleId,null);
});
const Inputs=require('../src/modules/nxnative/inputs'),Prepare=require('../src/modules/nxnative/prepare'),Settings=require('../src/modules/nxnative/settings');
function npdm(){const bytes=Buffer.alloc(0x98);bytes.write('META');bytes.writeUInt32LE(0x80,0x70);bytes.writeUInt32LE(24,0x74);bytes.write('ACI0',0x80);bytes.writeBigUInt64LE(0x0100000000010000n,0x90);return bytes;}
function dump(t){const root=path.dirname(fixture(t)),game=path.join(root,'game');fs.mkdirSync(game+'/base/exefs',{recursive:true});fs.mkdirSync(game+'/base/romfs');fs.writeFileSync(game+'/base/exefs/main.npdm',npdm());return{root:fs.realpathSync(root),game:fs.realpathSync(game)};}
test('dump detection accepts base, root and update-only layouts and keeps generation unknown',t=>{
 const f=dump(t);assert.equal(Inputs.dump(f.game).selectedUpdate,'v0');fs.renameSync(f.game+'/base',f.root+'/root-dump');assert.equal(Inputs.dump(f.root+'/root-dump').titleId,'0100000000010000');
 fs.mkdirSync(f.game+'/updates/7',{recursive:true});fs.renameSync(f.root+'/root-dump/exefs',f.game+'/updates/7/exefs');fs.renameSync(f.root+'/root-dump/romfs',f.game+'/updates/7/romfs');const input=Inputs.dump(f.game);assert.deepEqual(input.versions,['v7']);assert.equal(input.generation,null);assert.equal(input.keyRequirement,'none');
 fs.rmSync(f.game+'/updates/7/romfs',{recursive:true});fs.symlinkSync(f.root,f.game+'/updates/7/romfs');assert.throws(()=>Inputs.dump(f.game),/escapes/);
});
test('Game update choices exist before preparation, persist and reject unavailable selections',async t=>{
 const f=dump(t),entry={gameId:'fixture',moduleData:{...Inputs.dump(f.game),versions:['v0','v7']}};let update;const context={userDataDir:f.root+'/profile',onEntryChange:value=>update=value};
 const before=await Settings.read(entry,{},context);assert.deepEqual(before.schema.fields[0].options.map(o=>o.value),['latest','v0','v7']);await Settings.write(entry,{values:{packageVersion:'v7'}},context);assert.equal(update.runtimeSettings.nxnative.packageVersion,'v7');await assert.rejects(Settings.write(entry,{values:{packageVersion:'v8'}},context),/available/);
});
test('keyless preparation passes the update without accessing a keys setting and clears stale state',async t=>{
 const f=dump(t),settings={packageVersion:'v0'};Object.defineProperty(settings,'keysPath',{get(){throw Error('keyless preparation accessed keys');}});
 const entry={gameId:'fixture',contentRootDir:f.game,moduleData:{...Inputs.dump(f.game),keysRequired:true},runtimeSettings:{nxnative:settings}};
 const host=f.root+'/host';fs.writeFileSync(host,'synthetic host never executed');const runtime={root:f.root,host,cli:host,config:{capabilities:{keylessInputs:['dump'],packageSelection:true}}};
 const selection={runtime,version:'fixture',install:{manifestSha256:'fixture'}},context={userDataDir:f.root+'/profile',runtimeSettings:{},onEntryChange(){}};let calls=0;
 const runCommand=async(_command,args,options)=>{calls++;assert.equal(args.includes('--keys'),false);assert.equal(args[args.indexOf('--package')+1],'v0');const prepared=args[args.indexOf('--output')+1],elf=prepared+'/generated.elf';fs.writeFileSync(elf,'synthetic executable metadata');fs.writeFileSync(prepared+'/launch.json',JSON.stringify({schemaVersion:1,command:host,args:[elf],cwd:prepared,env:{},inputFacts:{generation:2,titleId:'0100000000010000',selectedUpdate:'v0'}}));fs.writeFileSync(options.logPath,JSON.stringify({ev:'prepared',launchFile:prepared+'/launch.json'})+'\n');};
 await Prepare.prepareGame(entry,context,selection,{runCommand});assert.equal(entry.moduleData.keysRequired,false);assert.equal(entry.moduleData.generation,2);await Prepare.prepareGame(entry,context,selection,{runCommand});assert.equal(calls,1);
});
