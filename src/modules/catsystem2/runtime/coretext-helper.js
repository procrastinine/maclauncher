const Included = require("../../shared/runtime/included-helpers");
const fs = require("node:fs"), path = require("node:path"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const B = require("../../shared/runtime/bundled-native"), Native = require("../../shared/runtime/local-native");
const declarations = require("./distribution-supplementals.json"), run = promisify(execFile);
const VERSION = "1.0.0-ml1", signatures = new Map(); let hostVersion;
async function resolveHelper({resourcesRoot,helperVersion=VERSION,platform=process.platform,arch=process.arch,dependencies={}}={}) {
  if(platform!=="darwin" || !["arm64","x64"].includes(arch)) throw new Error("The CoreText renderer requires an Apple Silicon or Intel Mac.");
  const pin=(dependencies.declarations||declarations).find(item=>item.id==="catsystem2-coretext-raster" && item.version===helperVersion);
  if(!pin) throw new Error("This app has no reviewed CoreText renderer for the selected version.");
  const included = Included.resolveIncluded(dependencies.declarations || declarations, { id: pin.id, version: pin.version, arch, resourcesRoot });
  if (included) {
    const { directory } = included;
    B.verifyPayload(directory,pin); const record=JSON.parse(B.readRegular(path.join(directory,pin.manifestRelative),B.LIMITS.manifestBytes).bytes);
    const executable=pin.files.find(file=>file.path==="coretext-raster"), executablePath=path.join(directory,"coretext-raster");
    if(record.schemaVersion!==1 || record.id!==pin.id || record.version!==pin.version || record.protocolVersion!=="CSTR1" || record.scope!=="font-text-raster" ||
       record.sourceKind!=="owned-source" || record.verifiedBuild!==true || record.sourceSha256!==pin.sourceSha256 || record.binarySha256!==executable?.sha256 ||
       record.minimumMacOS!==pin.minimumMacOS || record.build?.signing!=="ad-hoc" || JSON.stringify(record.architectures)!==JSON.stringify(executable.architectures) ||
       JSON.stringify(Native.readMachOArchitectures(executablePath).sort())!==JSON.stringify(executable.architectures.slice().sort()))
      throw new Error("The Included CoreText renderer's version, protocol or source identity changed.");
    const current=dependencies.systemVersion?await dependencies.systemVersion():hostVersion||=(await run("/usr/bin/sw_vers",["-productVersion"],{timeout:10000})).stdout.trim();
    if(!B.versionAtLeast(current,pin.minimumMacOS))throw new Error(`The CoreText renderer requires macOS ${pin.minimumMacOS}.`);
    const identity=B.fileIdentity(executablePath); if(signatures.get(executablePath)!==identity) {
      await (dependencies.verifySignature||(file=>run("/usr/bin/codesign",["--verify","--strict",file],{timeout:10000,maxBuffer:128*1024})))(executablePath);
      if(signatures.size>=16)signatures.delete(signatures.keys().next().value); signatures.set(executablePath,identity);
    }
    return Object.freeze({version:pin.version,protocolVersion:1,executablePath,binarySha256:executable.sha256,sourceSha256:pin.sourceSha256,
      manifestSha256:pin.manifestSha256,minimumMacOS:pin.minimumMacOS,systemVersion:current,shared:true});
  }
  throw new Error("The Included CoreText renderer is missing. Restore MacLauncher's reviewed payload.");
}
module.exports={VERSION,resolveHelper};
