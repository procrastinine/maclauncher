import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {adapt} from './adapt.mjs';

const options={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('Expected --option value');options[process.argv[i].slice(2)]=process.argv[i+1];}
for(const name of ['aim-source','dependencies','rustc','output'])if(!options[name])throw Error('Missing --'+name);
const source=fs.realpathSync(options['aim-source']),output=path.resolve(options.output),rustc=fs.realpathSync(options.rustc),dependencies=JSON.parse(fs.readFileSync(options.dependencies));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const native=import.meta.dirname,parser=path.join(output,'source');fs.mkdirSync(parser,{recursive:true});
const originals=[];
function copy(from,to,relative='') {for(const name of fs.readdirSync(from).sort()){const sourceFile=path.join(from,name),target=path.join(to,name),entry=path.posix.join(relative,name),stat=fs.lstatSync(sourceFile);if(stat.isSymbolicLink())throw Error('Parser source cannot use aliases');if(stat.isDirectory()){fs.mkdirSync(target,{recursive:true});copy(sourceFile,target,entry);}else{fs.copyFileSync(sourceFile,target);originals.push({path:'crates/aim-apps/src/'+entry,sha256:sha(sourceFile)});}}}
copy(path.join(source,'crates/aim-apps/src'),parser);adapt(parser);
const library=path.join(output,'libaim_apps.rlib'),binary=path.join(output,'android-apk-metadata'),map=path.join(output,'link-map.txt');
const externs={},search=new Set();for(const name of ['aim_android_xml','android_image_extract','libc','serde_json']){const input=dependencies[name];if(!input||sha(input.path)!==input.sha256)throw Error('Dependency checksum differs: '+name);externs[name]=fs.realpathSync(input.path);search.add(path.dirname(externs[name]));}
for(const directory of dependencies.searchDirectories||[])search.add(fs.realpathSync(directory));
const base=['--edition=2024','-C','opt-level=2','-C','debuginfo=0','--remap-path-prefix',source+'=/aim','--remap-path-prefix',path.resolve(native,'../../../../..')+'=/maclauncher','--remap-path-prefix',output+'=/build'];
for(const directory of search)base.push('-L','dependency='+directory);
const environment={...process.env,MACOSX_DEPLOYMENT_TARGET:'13.0'};
const run=args=>execFileSync(rustc,[...base,...args],{env:environment,stdio:'inherit'});
run(['--crate-name','aim_apps','--crate-type','rlib','--extern','aim_android_xml='+externs.aim_android_xml,'--extern','android_image_extract='+externs.android_image_extract,'--extern','libc='+externs.libc,path.join(parser,'lib.rs'),'-o',library]);
run(['--crate-name','android_apk_metadata','--extern','aim_apps='+library,'--extern','serde_json='+externs.serde_json,'-L','dependency='+output,'-C','link-arg=-Wl,-map,'+map,path.join(native,'main.rs'),'-o',binary]);
fs.chmodSync(binary,0o755);execFileSync('/usr/bin/strip',['-S',binary],{stdio:'pipe'});execFileSync('/usr/bin/codesign',['--force','--sign','-',binary],{stdio:'pipe'});execFileSync('/usr/bin/codesign',['--verify','--strict',binary],{stdio:'pipe'});
const commands=execFileSync('/usr/bin/otool',['-L',binary],{encoding:'utf8'}),versions=execFileSync('/usr/bin/vtool',['-show-build',binary],{encoding:'utf8'});
if(!versions.includes('minos 13.0'))throw Error('APK metadata helper must target macOS 13');
const result={schemaVersion:1,id:'android-apk-metadata',upstreamRevision:'934009283f69c251f57ed95ef1dff296546bb6ad',source,originals,owned:['main.rs','adapt.mjs','build.mjs'].map(file=>({path:file,sha256:sha(path.join(native,file))})),dependencies,compiler:execFileSync(rustc,['-vV'],{encoding:'utf8'}),minimumMacOS:'13.0',architectures:['arm64'],binary:{path:binary,bytes:fs.statSync(binary).size,sha256:sha(binary)},dynamicDependencies:commands,buildVersions:versions};
fs.writeFileSync(path.join(output,'BUILD.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({binary:result.binary,originalFiles:originals.length,minimumMacOS:result.minimumMacOS}));
