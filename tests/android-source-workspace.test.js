const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
test('Interrupted source migration preserves conflicting originals and resumes verified copies',t=>{
 const python=process.env.ANDROID_WORKSPACE_PYTHON;if(!python)return t.skip('Requires the project Python');
 execFileSync(python,['-c',String.raw`
import importlib.util,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('workspace','scripts/android_source_workspace.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    root=Path(temporary);source=root/'source';target=root/'target';stage=root/'stage'
    for path in (source,target,stage): path.mkdir()
    (source/'a').write_bytes(b'first original');(source/'b').write_bytes(b'second original')
    (target/'b').write_bytes(b'conflicting bytes')
    try: module.migrate_tree(source,target,stage)
    except ValueError: pass
    else: raise AssertionError('conflicting original was replaced')
    assert not (source/'a').exists() and (target/'a').read_bytes()==b'first original'
    assert (source/'b').read_bytes()==b'second original' and (target/'b').read_bytes()==b'conflicting bytes'
    (target/'b').unlink();module.migrate_tree(source,target,stage)
    assert list(source.iterdir())==[] and (target/'b').read_bytes()==b'second original'
`],{cwd:path.resolve(__dirname,'..'),stdio:'pipe',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
});
test('Original source workspace preserves paths across case-sensitive migration and remount',t=>{
 if(process.platform!=='darwin'||!process.env.ANDROID_WORKSPACE_PYTHON)return t.skip('Requires macOS disk images and the project Python');
 const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-source-workspace-'))),root=path.join(temporary,'source');fs.mkdirSync(root);
 const helper=path.resolve('scripts/android_source_workspace.py'),python=process.env.ANDROID_WORKSPACE_PYTHON;
 const run=args=>JSON.parse(execFileSync(python,[helper,...args],{encoding:'utf8',timeout:60000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
 let state;
 t.after(()=>{for(const mount of [root,path.join(temporary,'.source.case-sensitive-workspace/migration-mount')])try{execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'ignore'});}catch{}fs.rmSync(temporary,{recursive:true,force:true});});
 fs.writeFileSync(path.join(root,'LICENSE'),'original license\n',{mode:0o444});
 fs.mkdirSync(path.join(root,'out'));
 fs.writeFileSync(path.join(root,'out','generated.ninja'),'rule preserved\n',{mode:0o755});
 fs.linkSync(path.join(root,'out','generated.ninja'),path.join(root,'out','same-input'));
 fs.symlinkSync('../LICENSE',path.join(root,'out','license-link'));
 const originalRoot=root,backing=fs.statfsSync(temporary,{bigint:true});state=run(['--root',root]);assert.equal(state.sourceRoot,originalRoot);assert.equal(state.caseSensitive,true);
 const volume=fs.statfsSync(root,{bigint:true});assert.ok(volume.blocks*volume.bsize<=backing.blocks*backing.bsize+(1n<<30n),'Sparse image capacity must track backing storage');
 fs.mkdirSync(path.join(root,'license'));fs.writeFileSync(path.join(root,'license','notice'),'distinct original path');
 assert.equal(fs.readFileSync(path.join(root,'LICENSE'),'utf8'),'original license\n');
 assert.equal(fs.readFileSync(path.join(root,'license','notice'),'utf8'),'distinct original path');
 assert.equal(fs.readlinkSync(path.join(root,'out','license-link')),'../LICENSE');
 assert.equal(fs.statSync(path.join(root,'out','generated.ninja')).mode&0o777,0o755);
 assert.equal(fs.statSync(path.join(root,'out','same-input')).ino,fs.statSync(path.join(root,'out','generated.ninja')).ino);
 assert.equal(run(['--root',root]).sourceRoot,root);
 if(state.image){execFileSync('/usr/bin/hdiutil',['detach',root],{stdio:'pipe'});assert.equal(run(['--containing',path.join(root,'out','generated.ninja')]).phase,'ready');}
 assert.equal(fs.readFileSync(path.join(root,'out','generated.ninja'),'utf8'),'rule preserved\n');
});
