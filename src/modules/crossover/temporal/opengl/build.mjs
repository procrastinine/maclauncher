// Build against the same configured Wine tree and compiler set as WineVulkan.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname;
export function buildOpenGL({winebuild,output,compilers,clang='/usr/bin/clang',minimumMacOS='15.0'}) {
  const run=(tool,args,options={})=>execFileSync(tool,args,{stdio:'inherit',...options});
  const build=path.resolve(path.dirname(winebuild),'../..'),source=path.resolve(build,'../source');
  const objects={};
  for(const [cpu,compiler] of [['aarch64','aarch64-w64-mingw32-clang'],['arm64ec','arm64ec-w64-mingw32-clang'],['i386','i686-w64-mingw32-clang']]) {
    const object=path.join(output,cpu+'-loader.o');objects[cpu]=object;
    run(path.join(compilers,compiler),['-c','-O2','-D__WINESRC__','-I'+path.join(build,'include'),'-I'+path.join(source,'include'),path.join(here,'loader.c'),'-o',object]);
  }
  for(const [directory,target,compiler,cpus,flags] of [
    ['aarch64-windows','arm64ec-windows','arm64ec-w64-mingw32-clang',['aarch64','arm64ec'],['-marm64x']],
    ['i386-windows','i686-windows','i686-w64-mingw32-clang',['i386'],[]]]) {
    const folder=path.join(output,directory);fs.mkdirSync(folder,{recursive:true});const cpu=cpus[0];
    const libs=['libs/winecrt0','libs/compiler-rt','dlls/ucrtbase','dlls/kernel32','dlls/ntdll'].map(name=>path.join(build,name,cpu+'-windows','lib'+path.basename(name)+'.a'));
    run(path.join(build,'tools/winegcc/winegcc'),['-o',path.join(folder,'maclauncher-opengl32.dll'),'--wine-objdir',build,'--cc-cmd='+path.join(compilers,compiler),'-b',target,...flags,'-Wl,--wine-builtin','-shared',path.join(here,'maclauncher-opengl32.spec'),...cpus.map(cpu=>objects[cpu]),...libs],{cwd:build});
  }
  for(const object of Object.values(objects))fs.unlinkSync(object);
  const folder=path.join(output,'aarch64-unix');fs.mkdirSync(folder,{recursive:true});
  run(clang,['-arch','arm64','-mmacosx-version-min='+minimumMacOS,'-dynamiclib','-O2','-Wl,-install_name,@rpath/maclauncher-opengl32.so','-I',path.resolve(here,'../../../shared/reshade/native'),path.join(here,'attach.c'),'-o',path.join(folder,'maclauncher-opengl32.so')]);
}
