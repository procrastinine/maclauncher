const Catalog = require('./catalog');
const Payload = require('./payload');
const Wine = require('../../../../runtime-adapters/wine');
const {createSourceBackedManager} = require('../../../../runtime-sources/manager');
function createManager({discoverCatalog=Catalog.discover,dependencies={}}={}) {
 return createSourceBackedManager({source:Wine.definition('winecx'),adapter:Wine,dependencies:{...dependencies,catalog:Catalog,payload:Payload,discoverCatalog,extractArchive:dependencies.extractArchive || require('../../../shared/runtime/safe-archive').extractArchive,customRuntime:false,verifyArtifact:options=>verifyChecksumFile(options,dependencies)}});
}
function verifyChecksumFile({archiveSha256,pin,signal},dependencies={}) {return require('../../../../runtime-sources/verification').verifySumsFile({archiveSha256,checksum:pin?.checksum,filename:pin?.asset?.filename,signal,label:Wine.definition('winecx').label},dependencies);}
module.exports=createManager();
module.exports.createManager=createManager;
module.exports.verifyChecksumFile=verifyChecksumFile;
