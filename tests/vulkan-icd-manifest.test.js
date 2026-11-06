const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Description = require('../src/modules/shared/runtime/translator-description');
const Files = require('../src/modules/shared/runtime/translator-files');
const Vulkan = require('../src/modules/shared/vulkan');
const { image, X64 } = require('./fixtures/macho-image');

test('a KosmicKrisp package without an ICD manifest gets the same Vulkan API version on the Play placement and native routes', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vulkan-icd-manifest-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The package layout ships the driver and its loader, and no ICD JSON.
  const payload = path.join(root, 'payload', 'files'); fs.mkdirSync(payload, { recursive: true });
  const driver = path.join(payload, 'libvulkan_kosmickrisp.dylib'), loader = path.join(payload, 'libvulkan.1.dylib');
  fs.writeFileSync(driver, image({ cpu: X64 })); fs.writeFileSync(loader, image({ cpu: X64 }));
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

  const nativeDirectory = path.join(root, 'native'); fs.mkdirSync(nativeDirectory);
  const native = read(Vulkan.environment({ backend: 'kosmickrisp', library: loader, driver }, nativeDirectory).VK_DRIVER_FILES);

  const description = { ...Description.describeTranslator(payload, { engine: 'kosmickrisp', component: 'vulkan-driver' }),
    component: 'vulkan-driver', engine: 'kosmickrisp', entryPoint: driver };
  assert.equal(description.files.some(file => file.format === 'json'), false);
  const plan = { runtime: 'crossover', components: { 'vulkan-driver': { used: description, inherited: false, fallback: false } } };
  const view = await Files.prepareTranslatorFiles(plan, { userDataDir: path.join(root, 'profile'), layout: { architecture: 'x86_64', unixName: 'x86_64-unix' } });
  const placed = read(view.env.VK_DRIVER_FILES);

  assert.equal(placed.ICD.api_version, '1.4.0');
  assert.deepEqual(placed, native, 'both routes write one manifest for the same driver');
  assert.equal(fs.realpathSync(placed.ICD.library_path), fs.realpathSync(driver));
  assert.equal(view.env.CX_LIBVULKAN, loader);
});
