const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('localeconv preserves original Bionic layout over existing native thread locales',t=>{
  const output=process.env.ANDROID_LOCALE_BUILD,ast=process.env.ANDROID_ARM32_IMPORTS;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!output||!ast)return t.skip('Requires the compiled locale boundary and original declarations');
  const result=JSON.parse(fs.readFileSync(path.resolve(output,'result.json'))),declarations=JSON.parse(fs.readFileSync(path.resolve(ast,'host-ast.json')));
  const record=declarations.types['struct lconv'];assert.ok(record);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-native-locale-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  fs.writeFileSync(path.join(temporary,'locale-layout.h'),'#include <cstddef>\nstatic_assert(sizeof(klj_android_lconv)=='+record.size+');\n'+record.fields.map(field=>'static_assert(offsetof(klj_android_lconv,'+field.name+')=='+field.offset/8+');').join('\n')+'\n');
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  const library=path.join(temporary,'locale.dylib'),binary=path.join(temporary,'locale');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0','-dynamiclib',...result.objects,'-o',library]);
  run('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+result.output,'-I'+temporary,path.join(__dirname,'fixtures/android-native-locale.cpp'),'-o',binary]);
  assert.match(run(binary,[library]),/PASS original Android locale layout, every native field, monetary ordering, thread locale and string ownership/);
});
