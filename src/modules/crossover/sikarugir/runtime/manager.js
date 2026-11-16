const Catalog = require('./catalog');
const Payload = require('./payload');
const Wine = require('../../../../runtime-adapters/wine');
const {createSourceBackedManager} = require('../../../../runtime-sources/manager');
function createManager({discoverCatalog=Catalog.discover,dependencies={}}={}) {
 return createSourceBackedManager({source:Wine.definition('sikarugir'),adapter:Wine,dependencies:{...dependencies,catalog:Catalog,payload:Payload,discoverCatalog,extractArchive:dependencies.extractArchive || require('./archive').extractArchive}});
}
module.exports=createManager();
module.exports.createManager=createManager;
