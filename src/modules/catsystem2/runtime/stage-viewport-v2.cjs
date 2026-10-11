// Developer-only recipe. End users execute the sealed Included software child.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const B = require("../../shared/runtime/bundled-native");
const Native = require("../../shared/runtime/local-native");
const Supplemental = require("../../../../scripts/native-supplementals.cjs");
const VERSION = "1.1.0-ml1", MINIMUM_MACOS = "13.0", SDK_VERSION = "27.0";
const COMPILER_VERSION = "Apple clang version 21.0.0 (clang-2100.3.34.2)";
const SOURCE = path.join(__dirname, "native/cocoa-viewport-v2.m"), REPO = path.resolve(__dirname, "../../../..");
function command(executable, args) { return execFileSync(executable, args, {timeout:60000,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim(); }
function stage({ resourcesRoot } = {}) {
  if(process.platform !== "darwin" || !path.isAbsolute(resourcesRoot || "")) throw new Error("Stage the viewport on macOS into a fresh absolute resource directory.");
  const sdk = command("/usr/bin/xcrun", ["--sdk","macosx","--show-sdk-version"]), compiler = command("/usr/bin/xcrun",["clang","--version"]).split("\n")[0];
  if(sdk !== SDK_VERSION || compiler !== COMPILER_VERSION) throw new Error("This viewport version requires Apple clang21 and macOS SDK27.");
  const directoryRelative = `catsystem2-software-viewport/${VERSION}/universal`, destination = path.join(resourcesRoot,"native-runtimes",directoryRelative);
  if(fs.existsSync(destination)) throw new Error("Viewport payloads are immutable; choose an empty staging root.");
  const source = B.readRegular(SOURCE, 128*1024), temporary = fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-cs-viewport-build-"));
  try {
    fs.mkdirSync(destination,{recursive:true});
    for(const arch of ["arm64","x86_64"]) command("/usr/bin/xcrun",["--sdk","macosx","clang","-arch",arch,`-mmacosx-version-min=${MINIMUM_MACOS}`,
      "-O2","-std=c11","-fobjc-arc","-fblocks","-Wall","-Wextra","-Werror","-Wno-deprecated-declarations",
      `-ffile-prefix-map=${REPO}=maclauncher-source`,SOURCE,"-framework","AppKit","-framework","Foundation","-framework","ImageIO","-framework","CoreGraphics",
      "-o",path.join(temporary,arch)]);
    const executable = path.join(destination,"cocoa-viewport");
    command("/usr/bin/lipo",["-create",path.join(temporary,"arm64"),path.join(temporary,"x86_64"),"-output",executable]);
    command("/usr/bin/codesign",["--force","--sign","-","--identifier","io.github.maclauncher.catsystem2-viewport",executable]);
    command("/usr/bin/codesign",["--verify","--strict",executable]);
    if(command(executable,["--version"]) !== `maclauncher-catsystem2-viewport ${VERSION} protocol2`) throw new Error("Viewport protocol version differs from its build declaration.");
    if(JSON.stringify(Native.readMachOArchitectures(executable).sort()) !== JSON.stringify(["arm64","x86_64"])) throw new Error("Viewport CPU slices differ.");
    fs.copyFileSync(SOURCE,path.join(destination,"cocoa-viewport-v2.m")); fs.copyFileSync(__filename,path.join(destination,"stage-viewport-v2.cjs"));
    fs.copyFileSync(path.join(REPO,"LICENSE"),path.join(destination,"MacLauncher-MIT.txt"));
    fs.writeFileSync(path.join(destination,"DEPENDENCIES.txt"),[
      "MacLauncher software viewport: independently owned MIT source; no upstream interpreter, proprietary engine code or game assets.",
      "AppKit, Foundation, CoreGraphics and ImageIO: supplied by macOS, not redistributed.",
      "CSVP2 protocol: bounded RGBA8 layers, authored-coordinate input and native RGBA/system cursors over NDJSON; no script or menu decisions.",
      "CPU slices: arm64 and x86_64. Minimum macOS:13.0. No compiler or installation needed by end users."].join("\n")+"\n");
    const files = fs.readdirSync(destination).sort().map(name=>{ const file=path.join(destination,name); fs.chmodSync(file,name==="cocoa-viewport"?0o755:0o644); const r=B.readRegular(file,1024*1024);
      return {path:name,size:r.size,sha256:r.sha256,mode:r.mode,...(name==="cocoa-viewport"?{architectures:["arm64","x86_64"]}:{})}; });
    const notices=[{name:"MacLauncher software viewport",license:"MIT",path:"MacLauncher-MIT.txt"}];
    const record={schemaVersion:1,id:"catsystem2-software-viewport",version:VERSION,protocolVersion:"CSVP2",scope:"rgba-software-viewport",sourceKind:"owned-source",verifiedBuild:true,
      sourceSha256:source.sha256,binarySha256:files.find(f=>f.path==="cocoa-viewport").sha256,minimumMacOS:MINIMUM_MACOS,architectures:["arm64","x86_64"],files,notices,
      build:{compiler,sdk,signing:"ad-hoc",optimizations:"O2",minimumMacOS:MINIMUM_MACOS,recipe:"src/modules/catsystem2/runtime/stage-viewport-v2.cjs",recipeSha256:files.find(f=>f.path==="stage-viewport-v2.cjs").sha256}};
    const metadata=Buffer.from(JSON.stringify(record,null,2)+"\n"); fs.writeFileSync(path.join(destination,"helper.json"),metadata,{mode:0o644});
    const declaration={id:record.id,version:VERSION,arch:"universal",launcherArchitectures:["arm64","x64"],minimumMacOS:MINIMUM_MACOS,
      sourceRelative:"cocoa-viewport-v2.m",sourceSha256:source.sha256,directoryRelative,manifestRelative:"helper.json",manifestSha256:B.digest(metadata),
      files:[...files,{path:"helper.json",size:metadata.length,sha256:B.digest(metadata),mode:0o644}],notices};
    Supplemental.validateDeclaration(declaration);
    Supplemental.verifySupplementals({resourceRoot:path.join(resourcesRoot,"native-runtimes"),arch:process.arch,maximumMacOS:MINIMUM_MACOS,items:[declaration]}); return declaration;
  } catch(error) { fs.rmSync(destination,{recursive:true,force:true}); throw error; }
  finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={VERSION,MINIMUM_MACOS,SDK_VERSION,COMPILER_VERSION,stage};
if(require.main===module) {try {if(!process.argv[2])throw new Error("Pass a private resource staging directory."); process.stdout.write(JSON.stringify(stage({resourcesRoot:path.resolve(process.argv[2])}),null,2)+"\n");}catch(e){process.stderr.write(e.message+"\n");process.exitCode=1;}}
