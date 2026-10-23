const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Writable=require("../shared/writable-input");
/** Included JVM input adaptation; APK code and the supplied runtime stay separate. */
function materialize(cacheRoot){
  const record=require("./resources/text-input.json"),source=fs.readFileSync(path.join(__dirname,"text-input/java/maclauncher/android/framework/HostTextInput.java"));
  const bytes=fs.readFileSync(path.join(__dirname,"resources/text-input.jar"));
  const digest=value=>crypto.createHash("sha256").update(value).digest("hex");
  if(record.schema!==1||digest(source)!==record.sourceSha256||digest(bytes)!==record.sha256)throw new Error("The included Android text input helper is invalid. Reinstall MacLauncher.");
  const parent=path.join(cacheRoot,"text-input"),file=path.join(parent,record.sha256+".jar");
  Writable.assertOwnDirectory(cacheRoot,parent);
  try{if(!fs.lstatSync(file).isSymbolicLink()&&digest(fs.readFileSync(file))===record.sha256)return file;}catch{}
  Writable.atomicWrite(file,bytes,{root:parent});fs.chmodSync(file,0o400);return file;
}
module.exports={materialize};
