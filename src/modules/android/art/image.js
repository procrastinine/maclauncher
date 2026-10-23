const fs = require('node:fs'), path = require('node:path');
const Bundled = require('../../shared/runtime/bundled-native');
const Runtime = require('./runtime');
const {prepare} = require('../system-image');

/** Owned ART binaries and boot/framework files are installed separately from
 * the original image, which is acquired once under its upstream SDK license. */
async function prepareSupplier({install,context},dependencies={}) {
  const root = Runtime.member(install.root,'art');
  const manifestFile = path.join(root,'runtime.json');
  const stored = Bundled.readRegular(manifestFile,Bundled.LIMITS.manifestBytes);
  const record = install.declaration.files.find(file=>file.path==='art/runtime.json');
  if(!record||stored.sha256!==record.sha256||stored.size!==record.size||stored.mode!==record.mode)
    throw Error('The Android ART supplier metadata changed.');
  const manifest = JSON.parse(stored.bytes);
  Runtime.validateManifest(manifest);
  const acquisition = require('../runtime-source').json('art/supplier.json').imageAcquisition;
  if(['url','sha256','bytes','delivery'].some(key=>manifest.imageAcquisition?.[key]!==acquisition[key]))
    throw Error('The Android ART image acquisition differs from its selected supplier.');
  const components = {};
  for(const [name,file] of Object.entries(manifest.components||{}))if(name!=='image')components[name]=Runtime.member(root,file);
  for(const name of Object.keys(require('../runtime-source').json('art/components.json')))if(name!=='image'&&!components[name])
    throw Error('The Android ART supplier is incomplete: '+name);
  const extractor = Runtime.member(root,'host/android-image-extract');
  const original = await (dependencies.prepareImage||prepare)({context,image:manifest.imageAcquisition,
    expected:manifest.platformSupplier?.image,extractor},dependencies.imageDependencies);
  components.image = original.root;
  return {root,packageRoot:fs.realpathSync(install.root),manifest,components,bootClasspath:manifest.bootClasspath.slice(),image:original};
}
module.exports={prepareSupplier};
