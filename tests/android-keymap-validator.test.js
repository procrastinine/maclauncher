const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('Original keymap validator retains all four format parsers and rejects malformed input',t=>{
  const tool=process.env.ANDROID_VALIDATE_KEYMAPS;
  if(!tool)return t.skip('Requires the original Darwin keymap validator');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-keymap-validator-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const cases=[
    ['keys.kl','key 30 A\n','key not_a_scan_code A\n'],
    ['chars.kcm',"type FULL\nkey A {\n label: 'A'\n base: 'a'\n}\n",'type NOT_A_KEYBOARD_TYPE\n'],
    ['device.idc','touch.deviceType = touchScreen\n','touch.deviceType\n'],
    ['virtualkeys.device','0x01:158:20:30:40:50\n','0x01:158:20:30:40\n'],
  ];
  for(const [name,valid,invalid]of cases){
    const file=path.join(directory,name);fs.writeFileSync(file,valid);
    let result=spawnSync(tool,['-q',file],{encoding:'utf8'});
    assert.equal(result.status,0,name+': '+result.stderr);
    fs.writeFileSync(file,invalid);result=spawnSync(tool,['-q',file],{encoding:'utf8'});
    assert.equal(result.status,1,name+' malformed input must fail: '+result.stderr);
  }
});
