import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),here=import.meta.dirname,source=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,all)=>index%2?rows:[...rows,[value.replace(/^--/,''),all[index+1]]],[]));
if(!['xess-source','dxmt-source','compiler','out'].every(key=>args[key]))throw Error('Use --xess-source SDK --dxmt-source DXMT --compiler CLANG++ --out DIRECTORY');
const xess=fs.realpathSync(args['xess-source']),dxmt=fs.realpathSync(args['dxmt-source']),output=path.resolve(args.out),compiler=path.resolve(args.compiler);
fs.accessSync(compiler,fs.constants.X_OK);
for(const [directory,pin] of [[xess,source.xess],[dxmt,source.dxmt]])if(execFileSync('git',['-C',directory,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==pin.revision)throw Error('Initialize the exact XeSS adapter source commit: '+pin.repository);
fs.mkdirSync(output,{recursive:true});
const headers=['inc/xess/xess.h','inc/xess/xess_d3d11.h'];
const hooks=new Set(headers.flatMap(file=>[...fs.readFileSync(path.join(xess,file),'utf8').matchAll(/XESS_API\s+xess_result_t\s+(xess\w+)\s*\(/g)].map(row=>row[1])));
const owned=fs.readFileSync(path.join(here,'proxy.cpp'),'utf8');
for(const hook of hooks)if(!new RegExp('XESS_API\\s+xess_result_t\\s+'+hook+'\\s*\\(').test(owned))throw Error('The selected public XeSS API is not implemented: '+hook);
const reference=JSON.parse(fs.readFileSync(path.join(here,'reference-exports.json'))),original=reference.exports;
if(reference.revision!==source.xess.revision||reference.repository!==source.xess.repository)throw Error('The reference XeSS export profile does not match the declared SDK');
if(!original?.length)throw Error('The pinned XeSS D3D11 export profile is unavailable');
const exports=[...original];let ordinal=Math.max(...exports.map(row=>row.ordinal));
for(const name of hooks)if(!exports.some(row=>row.name===name))exports.push({name,ordinal:++ordinal});
fs.writeFileSync(path.join(output,'exports.hpp'),'#pragma once\nconstexpr unsigned maclauncherExportCount='+exports.length+';\nstatic const char *maclauncherExportNames[]={'+exports.map(row=>JSON.stringify(row.name)).join(',')+'};\n');
fs.writeFileSync(path.join(output,'exports.def'),'LIBRARY libxess_dx11\nEXPORTS\n'+exports.map(row=>row.name+' @'+row.ordinal).join('\n')+'\n');
fs.writeFileSync(path.join(output,'forwarders.S'),exports.flatMap(({name},index)=>hooks.has(name)?[]:[`
.text
.p2align 4
.globl ${name}
.def ${name}; .scl 2; .type 32; .endef
.seh_proc ${name}
${name}:
    movq maclauncherTargets+${index*8}(%rip), %rax
    testq %rax, %rax
    jne .Lready${index}
    subq $168, %rsp
    .seh_stackalloc 168
    .seh_endprologue
    movq %rcx, 32(%rsp)
    movq %rdx, 40(%rsp)
    movq %r8, 48(%rsp)
    movq %r9, 56(%rsp)
    movups %xmm0, 64(%rsp)
    movups %xmm1, 80(%rsp)
    movups %xmm2, 96(%rsp)
    movups %xmm3, 112(%rsp)
    movups %xmm4, 128(%rsp)
    movups %xmm5, 144(%rsp)
    movl $${index}, %ecx
    call maclauncherResolveExport
    movq 32(%rsp), %rcx
    movq 40(%rsp), %rdx
    movq 48(%rsp), %r8
    movq 56(%rsp), %r9
    movups 64(%rsp), %xmm0
    movups 80(%rsp), %xmm1
    movups 96(%rsp), %xmm2
    movups 112(%rsp), %xmm3
    movups 128(%rsp), %xmm4
    movups 144(%rsp), %xmm5
    addq $168, %rsp
.Lready${index}:
    jmp *%rax
.seh_endproc
`]).join('\n'));
const library=path.join(output,source.library),repository=path.resolve(here,'../../../../..');
execFileSync(compiler,['-std=c++17','-O2','-shared','-static','-Wl,--file-alignment=4096','-Wl,--exclude-all-symbols','-Wl,--no-insert-timestamp',
  '-ffile-prefix-map='+repository+'=MacLauncher','-ffile-prefix-map='+output+'=XeSSBuild',
  '-I'+path.join(xess,'inc'),'-I'+path.join(dxmt,'src/d3d11'),'-I'+path.join(dxmt,'src/util'),'-I'+path.join(here,'../dxmt'),'-I'+path.resolve(here,'../../../shared/reshade/temporal'),'-I'+output,
  path.join(here,'proxy.cpp'),path.join(output,'forwarders.S'),path.join(output,'exports.def'),'-ldxguid','-ld3d11','-ld3dcompiler','-o',library],{stdio:'inherit'});
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const actual=require('../streamline/pe-exports').inspect(library);
if(JSON.stringify(actual)!==JSON.stringify([...exports].sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'variant'})))){
  const supplied=new Map(actual.map(row=>[row.name,row.ordinal]));if(exports.some(row=>supplied.get(row.name)!==row.ordinal)||actual.length!==exports.length)throw Error('The XeSS export names or ordinals changed');
}
for(const [input,name] of [[path.join(xess,'inc/MIT.txt'),'XeSS-Headers-LICENSE.txt'],[path.join(dxmt,'LICENSE'),'DXMT-LICENSE.txt']])fs.copyFileSync(input,path.join(output,name));
const metadata={schema:1,profile:source.profile,version:'1',library:source.library,sha256:hash(library),exports:actual,
  sources:source,compiler:execFileSync(compiler,['--version'],{encoding:'utf8'}).split('\n')[0],
  owned:Object.fromEntries(['source.json','proxy.cpp','build.mjs','reference-exports.json','export-profile.js'].map(file=>[file,hash(path.join(here,file))])),
  dependencies:{'dxmt/camera-transport.hpp':hash(path.join(here,'../dxmt/camera-transport.hpp')),
    'temporal/camera.h':hash(path.resolve(here,'../../../shared/reshade/temporal/camera.h')),
    'temporal/frame.h':hash(path.resolve(here,'../../../shared/reshade/temporal/frame.h'))},
  inputs:{color:true,depth:true,motion:true,jitter:true,exposure:true,cameraProjection:false},
  execution:{renderer:'dxmt',api:'d3d11',algorithm:'selected-native-provider',offsets:'gpu-copy',history:'per-context',readback:false},
  unavailable:['external-descriptor-heap'],
  reactiveMask:{implementation:'native-guide',minimumMacOS:'14.4',feature:1},
};
fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify(metadata,null,2)+'\n');
console.log(JSON.stringify({library,sha256:metadata.sha256,exports:exports.length}));
