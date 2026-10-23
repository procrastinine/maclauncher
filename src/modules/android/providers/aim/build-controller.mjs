import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

const root=import.meta.dirname,repo=path.resolve(root,'../../../../..');
const target=process.env.MACLAUNCHER_AIM_TARGET||path.join(os.homedir(),'Library/Caches/maclauncher/aim-controller');
const remaps=[[os.homedir(),'/home/build'],[process.env.CARGO_HOME||path.join(os.homedir(),'.cargo'),'/cargo'],
 [process.env.RUSTUP_HOME||path.join(os.homedir(),'.rustup'),'/rustup'],[repo,'/maclauncher'],[path.resolve(target),'/build']];
const resources=path.join(root,'resources');
execFileSync('cargo',['build','--offline','--release','--manifest-path',path.join(root,'controller/Cargo.toml'),'--target-dir',target],{
 stdio:'inherit',env:{...process.env,CARGO_PROFILE_RELEASE_STRIP:'none',MACOSX_DEPLOYMENT_TARGET:'13.0',
  CARGO_ENCODED_RUSTFLAGS:[...remaps.map(([from,to])=>'--remap-path-prefix='+from+'='+to),'-C','debuginfo=0'].join('\x1f')}});
fs.mkdirSync(resources,{recursive:true});
const executable=path.join(resources,'maclauncher-aim');
// Keep an already running controller's inode intact until the replacement is
// completely copied, stripped and signed.
const temporary=fs.mkdtempSync(path.join(resources,'.controller-build-'));
try{
 const prepared=path.join(temporary,'maclauncher-aim');
 fs.copyFileSync(path.join(target,'release/maclauncher-aim'),prepared,fs.constants.COPYFILE_FICLONE);fs.chmodSync(prepared,0o755);
 execFileSync('/usr/bin/strip',['-S','-x',prepared]);
 execFileSync('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',prepared],{stdio:['ignore','ignore','pipe']});
 fs.renameSync(prepared,executable);
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
