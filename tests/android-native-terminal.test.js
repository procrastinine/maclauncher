const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original Bionic terminal family uses shared physical ioctl translation',t=>{
  const output=process.env.ANDROID_TERMINAL_BUILD;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!output)return t.skip('Requires the original compiled terminal family');
  const prepared=path.resolve(output),result=JSON.parse(fs.readFileSync(path.join(prepared,'result.json')));
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-terminal-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  fs.writeFileSync(path.join(temporary,'exports.h'),'inline constexpr const char *exports[]={'+result.names.map(JSON.stringify).join(',')+'};\n');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  const bridge=path.join(temporary,'ioctl.c');
  const adapted=fs.readFileSync(path.join(prepared,'libc-source.c'),'utf8'),start=adapted.indexOf('#define LX_FIONREAD'),entry=adapted.indexOf('int kl_ioctl(',start),end=adapted.indexOf('\n}',entry);
  assert.ok(start>=0&&entry>start&&end>entry,'The actual adapted original ioctl owner is available');
  fs.writeFileSync(bridge,'#include <stdint.h>\n#include <errno.h>\n#include <sys/ioctl.h>\nextern int klj_terminal_ioctl_dispatch(int,unsigned long,uintptr_t,int *);\nstatic void fcntl_warn_once(const char *name,long request){(void)name;(void)request;}\n'+adapted.slice(start,end+2)+'\n');
  const library=path.join(temporary,'terminal.dylib'),binary=path.join(temporary,'terminal');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-dynamiclib',bridge,...result.objects,'-o',library]);
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+result.output,'-I'+temporary,path.join(__dirname,'fixtures/android-native-terminal.cpp'),'-o',binary]);
  assert.match(run(binary,[library]),/PASS original terminal family, exact Android records, physical flags, control indices, speeds and ioctl routing/);
});
