const test=require('node:test'),assert=require('node:assert/strict');
const {confirmToolInstall}=require('../src/modules/shared/runtime/tool-install');
test('tool consent retains existing publisher terms on the same download descriptor',async()=>{
  const seen=[],licenseUrl='https://developer.android.com/studio/terms';
  const context={confirmRuntimeInstall:async plan=>{seen.push(plan);return true;}};
  await confirmToolInstall(context,{managerId:'android-system-image',version:'image',requiresDownload:true,licenseRequired:true,licenseUrl});
  assert.equal(seen.length,1);assert.equal(seen[0].managerId,'android-system-image');
  assert.equal(seen[0].requiresDownload,true);assert.equal(seen[0].licenseRequired,true);assert.equal(seen[0].licenseUrl,licenseUrl);
});
test('tools without terms keep their ordinary consent and installed tools ask nothing',async()=>{
  const seen=[],context={confirmRuntimeInstall:async plan=>{seen.push(plan);return true;}};
  await confirmToolInstall(context,{managerId:'reader',version:'1',requiresDownload:true});
  assert.equal(seen.length,1);assert.equal(Object.hasOwn(seen[0],'licenseRequired'),false);assert.equal(Object.hasOwn(seen[0],'licenseUrl'),false);
  await confirmToolInstall(context,{managerId:'reader',version:'1',requiresDownload:false,licenseRequired:true,licenseUrl:'https://example.invalid/terms'});
  assert.equal(seen.length,1);
});
