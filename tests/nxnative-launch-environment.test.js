const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Prepare = require('../src/modules/nxnative/prepare');

test('current nxnative upscaler keys pass through launch validation as a bounded scalar', t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nxnative-launch-env-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const prepared=path.join(root,'prepared'),sourceRoot=path.join(root,'original'),host=path.join(root,'host');
  fs.mkdirSync(prepared);fs.mkdirSync(sourceRoot);fs.writeFileSync(host,'synthetic host');
  const elf=path.join(prepared,'game.elf'),file=path.join(prepared,'launch.json');fs.writeFileSync(elf,'synthetic game');
  const launch={schemaVersion:1,command:host,args:[elf],cwd:prepared,env:{NXNATIVE_UPSCALER_KEYS:'fsr2,xess'}};
  const runtime={root,host},context={userDataDir:root,runtimeSettings:{}},entry={gameId:'fixture'};
  const validate=()=>{fs.writeFileSync(file,JSON.stringify(launch));return Prepare.validateLaunch(file,prepared,runtime,{sourceRoot},entry,context);};
  for(const managed of [false,true]) {
    runtime.managed=managed;
    for(const value of ['','fsr2,xess']) {
      launch.env.NXNATIVE_UPSCALER_KEYS=value;
      assert.equal(validate().env.NXNATIVE_UPSCALER_KEYS,value);
    }
    for(const value of [null,7,{},'x\0y','x'.repeat(16385)]) {
      launch.env.NXNATIVE_UPSCALER_KEYS=value;
      assert.throws(validate,/environment is invalid/);
    }
  }
});
