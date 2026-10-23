const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('ANGLE publication removes debug paths after input verification and preserves executable sections',async t=>{
  if(process.platform!=='darwin')return t.skip('Requires macOS Mach-O tools');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-angle-publication-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const build=path.join(temporary,'build'),payload=path.join(temporary,'payload'),objects=path.join(temporary,'private-checkout');
  fs.mkdirSync(path.join(build,'native/angle'),{recursive:true});fs.mkdirSync(objects);
  const source=path.join(objects,'renderer.c'),object=path.join(objects,'renderer.o');
  fs.writeFileSync(source,'int renderer_answer(void) { return 42; }\n');
  const run=(tool,args)=>execFileSync(tool,args,{encoding:'utf8',timeout:30000});
  run('clang',['-g','-c',source,'-o',object]);
  const original=path.join(build,'native/angle/libEGL.dylib');
  run('clang',['-dynamiclib',object,'-Wl,-install_name,@rpath/libEGL.dylib','-o',original]);
  run('/usr/bin/codesign',['--force','--sign','-',original]);
  const bytes=fs.readFileSync(original);assert.equal(bytes.includes(Buffer.from(objects)),true);
  const publisher=path.join(build,'native/libandroid_runtime.dylib');fs.copyFileSync(original,publisher);
  const {productInventory}=await import('../src/modules/android/native/build-sources.mjs');
  const {copyAndroidProducts,publishAndroidAngle}=await import('../scripts/android-products.mjs');
  const products=productInventory(build),product=products.find(value=>value.path==='native/angle/libEGL.dylib');
  const angle=[{...product,path:'libEGL.dylib',size:bytes.length}];
  const text=file=>run('/usr/bin/otool',['-s','__TEXT','__text',file]).split('\n').slice(1).join('\n');
  copyAndroidProducts(build,payload,products);
  const delivered=path.join(payload,product.path);
  fs.appendFileSync(delivered,'changed');
  assert.throws(()=>publishAndroidAngle(payload,products,angle),/changed before publication/);
  copyAndroidProducts(build,payload,products);
  publishAndroidAngle(payload,products,angle);
  assert.equal(fs.readFileSync(delivered).includes(Buffer.from(objects)),false);
  assert.equal(text(delivered),text(original),'Executable instructions remain byte-identical');
  run('/usr/bin/codesign',['--verify','--strict',delivered]);
  assert.deepEqual(fs.readFileSync(publisher),bytes,'Cached original library stays unchanged');
  assert.deepEqual(fs.readFileSync(path.join(payload,'native/libandroid_runtime.dylib')),bytes,'Publisher library stays byte-exact');
  assert.deepEqual(productInventory(build),products,'Original build receipt remains valid');
});

test('Android staging delivers every recorded product without component-name selection',async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-products-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const build=path.join(temporary,'build'),payload=path.join(temporary,'payload');
  const names=['android-host.jar','native/new-provider.dylib','native/libandroid-libcore.dylib','native/libandroid-media.dylib','android-root/system/etc/security/cacerts/example.0','a-new-component/data.bin','notices/provider/LICENSE'];
  for(const name of [...names,'build/objects/debug.o','source/native/example.c']){const file=path.join(build,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name);}
  const {productInventory}=await import('../src/modules/android/native/build-sources.mjs');
  const {copyAndroidProducts}=await import('../scripts/android-products.mjs');
  const products=productInventory(build);
  assert.equal(copyAndroidProducts(build,payload,products),names.length);
  for(const name of names)assert.equal(fs.readFileSync(path.join(payload,name),'utf8'),name);
  assert.equal(fs.existsSync(path.join(payload,'build')),false);
  assert.equal(fs.existsSync(path.join(payload,'source')),false);
  fs.writeFileSync(path.join(build,'native/new-provider.dylib'),'changed');
  assert.throws(()=>copyAndroidProducts(build,payload,products),/changed after compilation/);
});

test('Android staging materializes complete upstream resource aliases and rejects missing targets',async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-products-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const build=path.join(temporary,'build'),payload=path.join(temporary,'payload');fs.mkdirSync(build);fs.writeFileSync(path.join(build,'artifact'),'data');
  const {productInventory}=await import('../src/modules/android/native/build-sources.mjs');
  const {copyAndroidProducts}=await import('../scripts/android-products.mjs');
  const products=productInventory(build);fs.writeFileSync(path.join(build,'added'),'new');
  assert.throws(()=>copyAndroidProducts(build,payload,products),/changed after compilation/);
  fs.symlinkSync('artifact',path.join(build,'alias'));
  fs.mkdirSync(path.join(build,'nested'));
  fs.symlinkSync('../alias',path.join(build,'nested','second-alias'));
  assert.equal(copyAndroidProducts(build,payload,productInventory(build)),4);
  for(const name of ['alias','nested/second-alias']){
    assert.equal(fs.lstatSync(path.join(payload,name)).isFile(),true);
    assert.equal(fs.readFileSync(path.join(payload,name),'utf8'),'data');
  }
  for(const [target,expected] of [['missing',/not a recorded product/],['../outside',/not a recorded product/],['alias',/Cyclic/],[path.join(build,'artifact'),/Nonportable/]]){
    fs.unlinkSync(path.join(build,'alias'));fs.symlinkSync(target,path.join(build,'alias'));
    assert.throws(()=>copyAndroidProducts(build,payload,productInventory(build)),expected);
  }
});

test('Android publication maps notice paths without changing private products or source identities',async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android publication '));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const source=path.join(temporary,'source','native'),build=path.join(temporary,'work'),
    output=path.join(temporary,'output'),payload=path.join(temporary,'payload'),
    cache=path.join(temporary,'download cache'),alias=path.join(temporary,'cache alias');
  for(const directory of [source,build,output,cache])fs.mkdirSync(directory,{recursive:true});
  fs.symlinkSync(cache,alias);
  const {pathToFileURL}=require('node:url');
  const {buildPathMappings,productInventory}=await import('../src/modules/android/native/build-sources.mjs');
  const {copyAndroidProducts,publishAndroidNotices}=await import('../scripts/android-products.mjs');
  const mappings=buildPathMappings({source,build,output,options:{'download-cache':alias}});
  const notice={supplier:'upstream-1.2',revision:'abcdef',sha256:'a'.repeat(64),
    license:'MIT',url:'https://example.org/source.tar.xz',
    input:path.join(cache,'upstream.tar.xz'),inputAlias:path.join(alias,'upstream.tar.xz'),
    inputUrl:pathToFileURL(path.join(alias,'upstream.tar.xz')).href,
    source:path.join(source,'main.c'),helper:path.resolve(source,'../build-tools/helper.js'),
    binary:path.join(build,'lib/result.dylib'),output:path.join(output,'native/result.dylib')};
  const file=path.join(output,'notices','supplier','source.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const original=JSON.stringify(notice);fs.writeFileSync(file,original);
  const suppliedNotice='{ "license": "MIT", "url": "https://example.org" }';
  fs.writeFileSync(path.join(output,'notices','unmodified.json'),suppliedNotice);
  const operational={guestPath:'/data/user/0/com.example.app',library:'@loader_path/result.dylib'};
  fs.writeFileSync(path.join(output,'runtime.json'),JSON.stringify(operational));
  const products=productInventory(output);
  copyAndroidProducts(output,payload,products);publishAndroidNotices(payload,mappings);
  const publishedFile=path.join(payload,'notices','supplier','source.json');
  const published=JSON.parse(fs.readFileSync(publishedFile));
  for(const name of ['supplier','revision','sha256','license','url'])assert.equal(published[name],notice[name]);
  assert.equal(published.input,'INPUT_DOWNLOAD_CACHE/upstream.tar.xz');
  assert.equal(published.inputAlias,published.input);
  assert.match(published.inputUrl,/INPUT_DOWNLOAD_CACHE\/upstream.tar.xz$/);
  assert.equal(published.source,'ANDROID_ADAPTER/main.c');
  assert.equal(published.helper,'ANDROID_BUILD_TOOLS/helper.js');
  assert.equal(published.binary,'ANDROID_BUILD/lib/result.dylib');
  assert.equal(published.output,'ANDROID_RUNTIME/native/result.dylib');
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.deepEqual(productInventory(output),products);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(payload,'runtime.json'))),operational);
  assert.equal(fs.readFileSync(path.join(payload,'notices','unmodified.json'),'utf8'),suppliedNotice);
  assert.doesNotMatch(fs.readFileSync(publishedFile,'utf8'),/android(?:%20| )publication|\/private\/(?:tmp|var)\//);
  const before=fs.statSync(publishedFile,{bigint:true}).mtimeNs;
  publishAndroidNotices(payload,mappings);
  assert.equal(fs.statSync(publishedFile,{bigint:true}).mtimeNs,before);
});
