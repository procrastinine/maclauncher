import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const [sourceArg,archiveArg,outputArg,option]=process.argv.slice(2);
if(!sourceArg||!archiveArg||!outputArg||(option&&option!=='--universal')||process.argv.length>6)
  throw new Error('Usage: node build-retroarch.mjs <original librashader source> <official arm64 archive or -> <new output> [--universal]');
const source=path.resolve(sourceArg),archive=archiveArg==='-'?null:path.resolve(archiveArg),output=path.resolve(outputArg);
const declaration=JSON.parse(fs.readFileSync(new URL('./retroarch-source.json',import.meta.url)));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:'pipe',timeout:180000,...options});
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==declaration.commit)throw new Error('The original librashader source pin differs.');
if(hash(path.join(source,'include/librashader.h'))!==declaration.headerSha256)throw new Error('The original librashader C API header differs.');
if(archive&&hash(archive)!==declaration.artifacts.arm64?.sha256)throw new Error('The official librashader archive checksum differs.');
if(!archive&&declaration.sourceBuilds?.arm64?.commit!==declaration.commit)throw new Error('The selected librashader version needs a pinned ARM64 source build.');
if(fs.existsSync(output))throw new Error('Use a new RetroArch shader output directory.');
fs.mkdirSync(output,{recursive:true});
const library=path.join(output,'librashader.dylib');
const project=path.join(output,'prepare-source');fs.mkdirSync(project);
for(const file of ['main.rs','Cargo.lock'])fs.copyFileSync(new URL('./retroarch-prepare/'+file,import.meta.url),path.join(project,file));
const manifest=fs.readFileSync(new URL('./retroarch-prepare/Cargo.toml',import.meta.url),'utf8');
fs.writeFileSync(path.join(project,'Cargo.toml'),manifest.replaceAll('../../../../../external/librashader',source));
const env={...process.env,MACOSX_DEPLOYMENT_TARGET:'13.0',CFLAGS:[process.env.CFLAGS||'','-ffile-prefix-map='+os.homedir()+'=BuildHome'].join(' '),CXXFLAGS:[process.env.CXXFLAGS||'','-ffile-prefix-map='+os.homedir()+'=BuildHome'].join(' '),RUSTFLAGS:[process.env.RUSTFLAGS||'', '--remap-path-prefix='+os.homedir()+'=BuildHome','--remap-path-prefix='+source+'=librashader','--remap-path-prefix='+project+'=retroarch-prepare'].join(' ')};
const capiTarget=process.env.MACLAUNCHER_LIBRASHADER_TARGET||path.join(output,'capi-target');
if(archive)run('/usr/bin/unzip',['-q',archive,'librashader.dylib','-d',output]);
else{
 run(process.env.CARGO||'cargo',['build','--release','--locked','--offline','--target','aarch64-apple-darwin','--no-default-features','--features','runtime-metal','--package','librashader-capi','--manifest-path',path.join(source,'Cargo.toml'),'--target-dir',capiTarget,'--jobs','2'],{env,timeout:900000});
 fs.copyFileSync(path.join(capiTarget,'aarch64-apple-darwin/release/liblibrashader_capi.dylib'),library);
}
if(run('/usr/bin/lipo',['-archs',library]).trim()!=='arm64')throw new Error('The library has an unexpected architecture.');
run('/usr/bin/install_name_tool',['-id','@rpath/librashader.dylib',library]);
run(process.env.CARGO||'cargo',['build','--release','--locked','--manifest-path',path.join(project,'Cargo.toml'),'--target-dir',path.join(output,'target')],{env});
const helper=path.join(output,'retroarch-prepare');fs.copyFileSync(path.join(output,'target/release/retroarch-prepare'),helper);fs.chmodSync(helper,0o755);
run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',helper]);
if(option==='--universal'){
 const cross={...env,RUSTC_BOOTSTRAP:'1'};
 run(process.env.CARGO||'cargo',['build','-Z','build-std=std,panic_abort','--release','--locked','--offline','--target','x86_64-apple-darwin','--no-default-features','--features','runtime-metal','--package','librashader-capi','--manifest-path',path.join(source,'Cargo.toml'),'--target-dir',capiTarget,'--jobs','2'],{env:cross,timeout:900000});
 const capi=path.join(capiTarget,'x86_64-apple-darwin/release/liblibrashader_capi.dylib');
 run('/usr/bin/lipo',['-create',library,capi,'-output',library+'.universal']);fs.renameSync(library+'.universal',library);run('/usr/bin/install_name_tool',['-id','@rpath/librashader.dylib',library]);
 run(process.env.CARGO||'cargo',['build','-Z','build-std=std,panic_abort','--release','--locked','--offline','--target','x86_64-apple-darwin','--manifest-path',path.join(project,'Cargo.toml'),'--target-dir',capiTarget,'--jobs','2'],{env:cross,timeout:900000});
 const intel=path.join(capiTarget,'x86_64-apple-darwin/release/retroarch-prepare');run('/usr/bin/lipo',['-create',helper,intel,'-output',helper+'.universal']);fs.renameSync(helper+'.universal',helper);
}
for(const file of [library,helper]){run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);run('/usr/bin/codesign',['--verify','--strict',file]);}
const notice=path.join(output,'notices/librashader');fs.mkdirSync(notice,{recursive:true});
fs.copyFileSync(path.join(source,'LICENSE.md'),path.join(notice,'LICENSE.md'));
fs.writeFileSync(path.join(notice,'source.json'),JSON.stringify(declaration,null,2)+'\n');
const files=[library,helper,...['LICENSE.md','source.json'].map(file=>path.join(notice,file))].map(file=>({path:path.relative(output,file),source:file,size:fs.statSync(file).size,mode:fs.statSync(file).mode&0o777,sha256:hash(file)}));
fs.writeFileSync(path.join(output,'runtime-files.json'),JSON.stringify({files},null,2)+'\n');
console.log(JSON.stringify({output,files}));
