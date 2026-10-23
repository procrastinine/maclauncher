const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const Writable=require("../src/modules/shared/writable-input");

test("Concurrent owned-directory creation accepts only an ordinary published directory",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"owned-directory-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const mkdir=fs.mkdirSync.bind(fs),target=path.join(root,"created"),linked=path.join(root,"linked"),file=path.join(root,"file");
  t.mock.method(fs,"mkdirSync",(name,options)=>{
    if(name===target)mkdir(name,options);
    if(name===linked)fs.symlinkSync(root,name);
    if(name===file)fs.writeFileSync(name,"not a directory");
    return mkdir(name,options);
  });
  Writable.assertOwnDirectory(root,target);
  assert.equal(fs.lstatSync(target).isDirectory(),true);
  assert.throws(()=>Writable.assertOwnDirectory(root,linked),{code:"EEXIST"});
  assert.throws(()=>Writable.assertOwnDirectory(root,file),{code:"EEXIST"});
});
