const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os');

// ART is an arm64 host: an Intel launcher or a saved x64 driver default must
// not give it an x64 Vulkan driver.
test('ART resolves the arm64 Vulkan driver whatever the launcher or saved default CPU',async()=>{
 const {launch}=await import('../src/modules/android/art/launch.mjs');
 const stop=Error('stop after Vulkan');let options;
 const context={userDataDir:os.tmpdir(),runtimeSettings:{},settings:{runtimes:{'vulkan-moltenvk':{defaultArchitecture:'x64'}}}};
 await assert.rejects(launch({gameId:'art-vulkan'},context,{root:os.tmpdir(),profile:{}},
  {resolveVulkan:async(_context,value)=>{options=value;throw stop;}}),error=>error===stop);
 assert.deepEqual(options,require('../src/modules/android/graphics-selection').VULKAN_OPTIONS);
 assert.equal(options.architecture,'arm64');
});
