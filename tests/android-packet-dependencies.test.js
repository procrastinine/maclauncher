const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('packet GLib headers link the compatible complete published library closure',t=>{
  if(process.platform!=='darwin'||process.arch!=='arm64'||!process.env.ANDROID_GLIB_RECORD)return t.skip('Requires prepared ARM64 GLib supplier');
  const record=JSON.parse(fs.readFileSync(process.env.ANDROID_GLIB_RECORD));
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-packet-glib-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const source=path.join(output,'probe.c'),binary=path.join(output,'probe');
  fs.writeFileSync(source,`#include <glib.h>
#include <assert.h>
#include <string.h>
int main(void){
  assert(GLIB_MAJOR_VERSION==2&&GLIB_MINOR_VERSION==82&&GLIB_MICRO_VERSION==4);
  assert(glib_major_version==2&&glib_minor_version==82&&glib_micro_version==4);
  GError *error=NULL;GRegex *regex=g_regex_new("^[[:alpha:]]+$",0,0,&error);
  assert(regex&&!error&&g_regex_match(regex,"Δοκιμή",0,NULL));g_regex_unref(regex);
  GHashTable *table=g_hash_table_new_full(g_str_hash,g_str_equal,g_free,g_free);
  g_hash_table_insert(table,g_strdup("socket"),g_strdup("peer"));
  assert(!strcmp(g_hash_table_lookup(table,"socket"),"peer"));g_hash_table_unref(table);
  g_print("PASS compatible original GLib and PCRE2 library closure\\n");return 0;
}`);
  const run=(command,args,env=process.env)=>{const result=spawnSync(command,args,{env,encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const env={...process.env,PKG_CONFIG_LIBDIR:record.pkgConfigDirectory,PKG_CONFIG_PATH:record.pkgConfigDirectory};
  assert.equal(run('pkg-config',['--modversion','glib-2.0'],env).trim(),'2.82.4');
  run('clang',['-arch','arm64','-mmacosx-version-min=13.0',...record.includeDirectories.map(p=>'-I'+p),source,...record.libraries,'-Wl,-rpath,'+path.dirname(record.libraries[0]),'-o',binary]);
  assert.match(run(binary,[]),/PASS compatible original GLib/);
  const metadata=JSON.parse(fs.readFileSync(path.join(record.notices,'source.json')));
  assert.deepEqual(metadata.binaries.map(row=>row.name),['libglib-2.0.0.dylib','libintl.8.dylib','libpcre2-8.0.dylib']);
  assert.ok(metadata.headers.length>80);
  assert.ok(metadata.binaries.every(row=>row.minimumMacOS==='11.0'));
  assert.deepEqual(metadata.components.map(row=>row.id).sort(),['glib','pcre2','proxy-libintl']);
  for(const name of ['glib-COPYING','pcre2-LICENCE','proxy-libintl-COPYING'])
    assert.ok(fs.statSync(path.join(record.notices,name)).size>100);
});
