import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const options={};
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('Expected --option value');options[process.argv[i].slice(2)]=process.argv[i+1];}
for(const key of ['aim-source','registry-source','registry-cache','rust-distribution','maclauncher-license','build','output'])if(!options[key])throw Error('Missing --'+key);
const specification=JSON.parse(fs.readFileSync(new URL('./sources.json',import.meta.url)));
const aim=fs.realpathSync(options['aim-source']),registry=fs.realpathSync(options['registry-source']),cache=fs.realpathSync(options['registry-cache']),rust=fs.realpathSync(options['rust-distribution']);
const build=JSON.parse(fs.readFileSync(path.join(options.build,'BUILD.json'))),output=path.resolve(options.output),temporary=path.join(output,'corresponding-source');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(fs.existsSync(temporary))throw Error('Source destination already exists');
fs.mkdirSync(temporary,{recursive:true});
const excluded=new Set(['tests','test','fixtures','benches','examples','fuzz','target','_build','.git','.github','.cargo-ok','.cargo-checksum.json']);
const copy=(source,target)=>{const stat=fs.lstatSync(source);if(stat.isSymbolicLink())throw Error('Source aliases are not supported: '+source);if(stat.isDirectory()){fs.mkdirSync(target,{recursive:true});for(const name of fs.readdirSync(source).sort())if(!excluded.has(name))copy(path.join(source,name),path.join(target,name));}else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}};
for(const row of [...build.originals,...build.dependencies.originalSources||[]]){if(sha(path.join(aim,row.path))!==row.sha256)throw Error('Parser source checksum changed: '+row.path);}
for(const name of ['Cargo.toml','Cargo.lock','LICENSE','NOTICE','LICENSING.md','THIRD_PARTY_NOTICES.md',...specification.aim.paths])copy(path.join(aim,name),path.join(temporary,'upstream/aim',name));
copy(import.meta.dirname,path.join(temporary,'maclauncher/apk-metadata'));

const blocks=fs.readFileSync(path.join(aim,'Cargo.lock'),'utf8').split('[[package]]').slice(1);
const packages=blocks.map(text=>{const field=name=>new RegExp('^'+name+' = "([^\"]+)"','m').exec(text)?.[1];return {name:field('name'),version:field('version'),checksum:field('checksum'),source:field('source'),dependencies:[...( /dependencies = \[([\s\S]*?)\]/.exec(text)?.[1]||'').matchAll(/"([^"]+)"/g)].map(m=>m[1])};});
const dependencies=new Map();
function visit(dependency){const [name,version]=dependency.split(' '),matches=packages.filter(p=>p.name===name&&(!version||p.version===version));if(matches.length!==1)throw Error('Ambiguous locked dependency: '+dependency);const item=matches[0],key=item.name+'-'+item.version;if(dependencies.has(key))return;dependencies.set(key,item);for(const child of item.dependencies)visit(child);}
for(const dependency of specification.registryDependencies)visit(dependency);
const notices=path.join(output,'licenses');fs.mkdirSync(notices,{recursive:true});
copy(fs.realpathSync(options['maclauncher-license']),path.join(notices,'maclauncher/LICENSE'));
copy(path.join(aim,'LICENSE'),path.join(notices,'aim/LICENSE'));
copy(path.join(aim,'NOTICE'),path.join(notices,'aim/NOTICE'));
const records=[];
for(const [key,item] of [...dependencies].sort(([a],[b])=>a.localeCompare(b))){
  const directory=path.join(registry,key),archive=path.join(cache,key+'.crate');
  if(!item.checksum||sha(archive)!==item.checksum)throw Error('Registry archive checksum changed: '+key);
  const verified=path.join(output,'registry-check');fs.mkdirSync(verified,{recursive:true});
  execFileSync('/usr/bin/tar',['-xzf',archive,'-C',verified]);
  const verify=(from,relative='')=>{for(const name of fs.readdirSync(from)){const file=path.join(from,name),entry=path.join(relative,name);if(fs.statSync(file).isDirectory())verify(file,entry);else if(sha(file)!==sha(path.join(directory,entry)))throw Error('Registry source differs: '+key+'/'+entry);}};
  verify(path.join(verified,key));fs.rmSync(verified,{recursive:true});
  copy(directory,path.join(temporary,'upstream/crates',key));
  const licenseFiles=fs.readdirSync(directory).filter(name=>/^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)([.\-_]|$)/i.test(name)&&fs.statSync(path.join(directory,name)).isFile());
  if(!licenseFiles.length)throw Error('Dependency has no license notice: '+key);
  for(const name of licenseFiles)copy(path.join(directory,name),path.join(notices,'crates',key,name));
  records.push({name:item.name,version:item.version,source:item.source,checksum:item.checksum,licensePaths:licenseFiles.map(name=>'licenses/crates/'+key+'/'+name)});
}
copy(path.join(rust,'share/doc/rust/COPYRIGHT-library.html'),path.join(notices,'rust/COPYRIGHT-library.html'));
copy(path.join(rust,'share/doc/rust/licenses'),path.join(notices,'rust/licenses'));
copy(notices,path.join(temporary,'licenses'));
const owned=fs.readdirSync(import.meta.dirname).sort().map(name=>({path:'maclauncher/apk-metadata/'+name,sha256:sha(path.join(import.meta.dirname,name))}));
const provenance={schemaVersion:1,id:'android-apk-metadata',aim:specification.aim,minimumMacOS:'13.0',architecture:'arm64',compiler:build.compiler,originalParser:[...build.originals,...build.dependencies.originalSources||[]],owned,registryDependencySources:records,cargoLockSha256:sha(path.join(aim,'Cargo.lock')),binary:{sha256:build.binary.sha256,size:build.binary.bytes},dependencyArchives:Object.fromEntries(Object.entries(build.dependencies).filter(([,input])=>typeof input?.sha256==='string').map(([name,input])=>[name,{sha256:input.sha256}]))};
fs.writeFileSync(path.join(temporary,'source.json'),JSON.stringify(provenance,null,2)+'\n');
execFileSync('/usr/bin/tar',['-czf',path.join(output,'source.tar.gz'),'-C',temporary,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
fs.writeFileSync(path.join(output,'source.json'),JSON.stringify(provenance,null,2)+'\n');
fs.writeFileSync(path.join(output,'NOTICE.txt'),'Android APK Metadata\n\nAPK/resource/drawable parsing: AIM '+specification.aim.revision+' (Apache-2.0).\nMacLauncher metadata protocol and locale/split adaptation: MIT.\nOwned source/build entries and component identities are described in README.md and source.json. The complete corresponding-source archive is distributed separately.\nRust standard library, registry dependency and MacLauncher license notices are included under licenses/.\n');
const result={schemaVersion:1,source:{path:path.join(output,'source.tar.gz'),sha256:sha(path.join(output,'source.tar.gz')),size:fs.statSync(path.join(output,'source.tar.gz')).size},sourceMetadata:{path:path.join(output,'source.json'),sha256:sha(path.join(output,'source.json'))},registryCrates:records.length,owned,licenses:notices};
fs.writeFileSync(path.join(output,'SOURCE-RESULT.json'),JSON.stringify(result,null,2)+'\n');
fs.rmSync(temporary,{recursive:true});
console.log(JSON.stringify(result));
