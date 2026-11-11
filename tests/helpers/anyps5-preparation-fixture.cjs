const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {image}=require('../fixtures/macho-image');
function guest(type=0xfe00){const bytes=Buffer.alloc(128);Buffer.from([127,69,76,70,2,1,1]).copy(bytes);bytes.writeUInt16LE(type,16);bytes.writeUInt16LE(62,18);bytes.writeUInt16LE(64,52);bytes.writeUInt16LE(56,54);bytes.writeUInt16LE(1,56);return bytes;}
function fixture(t,{prepared=true,override=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'anyps5-original-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const game=path.join(root,'game'),profile=path.join(root,'profile'),programs=prepared?path.join(game,'source'):game,assets=prepared?path.join(game,'app0'):game,runtime=path.join(root,'runtime');for(const directory of [profile,programs,path.join(assets,'assets'),path.join(runtime,'libs')])fs.mkdirSync(directory,{recursive:true});
 fs.mkdirSync(path.join(runtime,'tools'));fs.writeFileSync(path.join(runtime,'relinker'),'fixture converter');fs.writeFileSync(path.join(runtime,'tools','unwrap-self.cjs'),'module.exports = {};\n');
 const executable=path.join(programs,'eboot.bin');fs.writeFileSync(executable,guest());fs.mkdirSync(path.join(programs,'sce_module'));fs.writeFileSync(path.join(programs,'sce_module','helper.prx'),guest(0xfe18));fs.writeFileSync(path.join(assets,'assets','data.bin'),'original game data');
 const entry={name:'Fixture Game',gameId:'fixture',gamePath:game,contentRootDir:game,moduleData:{executablePath:executable,inputLayout:prepared?'anyps5-prepared':'unpacked'},...(override?{saveDirOverride:path.join(root,'custom-saves')}:{})},context={userDataDir:profile},install={version:'fixture-runtime',executablePath:path.join(runtime,'relinker'),payloadRoot:runtime,manifestSha256:'a'.repeat(64)};let calls=0;
 const runCommand=async(_command,args)=>{calls++;assert.ok(args.includes('--macos')&&args.includes('--to-rosetta'));const output=path.dirname(args.at(-1));fs.mkdirSync(path.join(output,'sce_module'),{recursive:true});fs.writeFileSync(path.join(output,'eboot'),image({cpu:0x01000007,fileType:2,installName:null}));fs.writeFileSync(path.join(output,'sce_module','helper.guest.prx'),image({cpu:0x01000007,fileType:6}));fs.writeFileSync(path.join(output,'eboot.registry.json'),'[]');};
 return{root,game,profile,programs,assets,runtime,entry,context,install,runCommand,calls:()=>calls};
}

module.exports={fixture};
