import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [source, destination, ...arguments_] = process.argv.slice(2), options={};
for(let i=0;i<arguments_.length;i+=2){const key=arguments_[i];if(!['--shaderc','--shaderc-library'].includes(key)||!arguments_[i+1]||options[key])throw Error('Choose explicit shader compiler inputs.');options[key]=path.resolve(arguments_[i+1]);}
if (!source || !destination || !options['--shaderc'] || !options['--shaderc-library']) throw Error('Usage: node build.mjs <pinned Godot source> <output directory> --shaderc <compiler> --shaderc-library <library>');
const specification = JSON.parse(fs.readFileSync(new URL('./source.json', import.meta.url)));
const header = path.resolve(source, specification.header), output = path.resolve(destination);
if (crypto.createHash('sha256').update(fs.readFileSync(header)).digest('hex') !== specification.headerSha256) throw Error('Godot extension header differs from the supported version.');
if (fs.existsSync(output)) throw Error('The Godot graphics output already exists; choose a new directory.');
fs.mkdirSync(output, {recursive:true});
const library = path.join(output, 'libmaclauncher-godot-camera.dylib');
execFileSync('/usr/bin/c++', ['-std=c++17','-O2','-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0','-dynamiclib','-Wl,-install_name,@rpath/libmaclauncher-godot-camera.dylib',
  '-ffile-prefix-map='+path.resolve(import.meta.dirname,'../../../..')+'=MacLauncher',
  '-I'+path.dirname(header),path.join(import.meta.dirname,'bridge.cpp'),'-o',library], {stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',library],{stdio:'inherit'});
fs.copyFileSync(path.join(source,'LICENSE.txt'),path.join(output,'GODOT-LICENSE.txt'));
for (const script of ['autoload.gd','camera-effect.gd','aov-effect.gd']) fs.copyFileSync(path.join(import.meta.dirname,script),path.join(output,script));
const capturePrograms=[];
for(let variant=0;variant<4;++variant){
  const file=`aov-capture-${variant}.spv`,args=['--library',options['--shaderc-library'],'--input','aov-capture.glsl','--output',path.join(output,file),'--language','glsl','--stage','compute'];
  if(variant&1)args.push('--define','CAPTURE_NORMAL=1');if(variant&2)args.push('--define','CAPTURE_SPECULAR=1');
  execFileSync(options['--shaderc'],args,{cwd:import.meta.dirname,stdio:'inherit'});
  const bytes=fs.readFileSync(path.join(output,file));if(bytes.length<20||bytes.readUInt32LE(0)!==0x07230203)throw Error('The capture shader compiler did not produce SPIR-V.');
  capturePrograms.push({variant,file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
const ownedFiles = ['bridge.cpp','autoload.gd','camera-effect.gd','aov-effect.gd','aov-capture.glsl','../../shared/reshade/temporal/camera.h','../../shared/reshade/temporal/frame.h','../../shared/reshade/temporal/scene.h','../../shared/reshade/temporal/scene-matrices.h','../../shared/reshade/temporal/scene-destination.h','../../shared/reshade/temporal/scene-aovs.h','../../shared/reshade/temporal/scene-copy-boundary.h','../../shared/reshade/native/image-color.h'];
const ownedSourceSha256 = Object.fromEntries(ownedFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(import.meta.dirname,file))).digest('hex')]));
fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify({abi:1,complete:true,sourceResolutionAPI:1,sourceResolutionLiveAPI:1,sceneDemandAPI:1,sceneDestinationAPI:1,sceneAovAPI:1,sceneCopyBoundaryAPI:1,aovCapture:{version:1,programs:capturePrograms},sourceCommit:specification.commit,
  sourceHeaderSha256:specification.headerSha256,ownedSourceSha256,
  minimumGodot:'4.4',minimumMacOS:'13.0',architectures:['arm64','x86_64'],library:path.basename(library)},null,2)+'\n');
