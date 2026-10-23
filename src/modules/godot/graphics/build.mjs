import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [source, destination] = process.argv.slice(2);
if (!source || !destination || process.argv.length !== 4) throw Error('Usage: node build.mjs <pinned Godot source> <output directory>');
const specification = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url)));
const header = path.resolve(source, specification.header), output = path.resolve(destination);
if (crypto.createHash('sha256').update(fs.readFileSync(header)).digest('hex') !== specification.headerSha256) throw Error('Godot extension header differs from the supported version.');
fs.mkdirSync(output, {recursive:true});
const library = path.join(output, 'libmaclauncher-godot-camera.dylib');
execFileSync('/usr/bin/c++', ['-std=c++17','-O2','-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0','-dynamiclib','-Wl,-install_name,@rpath/libmaclauncher-godot-camera.dylib',
  '-ffile-prefix-map='+path.resolve(import.meta.dirname,'../../../..')+'=MacLauncher',
  '-I'+path.dirname(header),path.join(import.meta.dirname,'bridge.cpp'),'-o',library], {stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',library],{stdio:'inherit'});
fs.copyFileSync(path.join(source,'LICENSE.txt'),path.join(output,'GODOT-LICENSE.txt'));
for (const script of ['autoload.gd','camera-effect.gd']) fs.copyFileSync(path.join(import.meta.dirname,script),path.join(output,script));
const ownedFiles = ['bridge.cpp','autoload.gd','camera-effect.gd','../../shared/reshade/temporal/camera.h','../../shared/reshade/temporal/frame.h'];
const ownedSourceSha256 = Object.fromEntries(ownedFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(import.meta.dirname,file))).digest('hex')]));
fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify({abi:1,complete:true,sourceResolutionAPI:1,sourceResolutionLiveAPI:1,sourceCommit:specification.commit,
  sourceHeaderSha256:specification.headerSha256,ownedSourceSha256,
  minimumGodot:'4.4',minimumMacOS:'13.0',architectures:['arm64','x86_64'],library:path.basename(library)},null,2)+'\n');
