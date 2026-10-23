const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

test("sidebar search matches metadata and runtime names without changing selection or item order", () => {
  const model = pathToFileURL(path.resolve(__dirname, "../src/renderer/src/ui/components/sidebar-navigation-model.ts")).href;
  const script = `import assert from 'node:assert/strict';
    import { filterSidebarItems, sidebarMovement, sidebarSearchShortcut } from ${JSON.stringify(model)};
    const items = [{ id:'launcher', label:'Launcher' },
      { id:'wine', label:'Windows', title:'Windows games', keywords:['Sikarugir','CrossOver'] },
      { id:'android', label:'Android', keywords:['Mac.apk','Klepton','AIM'] },
      { id:'love', label:'LÖVE' }];
    const before = structuredClone(items), selected = 'launcher';
    assert.deepEqual(filterSidebarItems(items, ' windows SIKARUGIR ').map(x=>x.id), ['wine']);
    assert.deepEqual(filterSidebarItems(items, 'mac.apk').map(x=>x.id), ['android']);
    assert.deepEqual(filterSidebarItems(items, 'love').map(x=>x.id), ['love']);
    assert.deepEqual(filterSidebarItems(items, 'not present'), []);
    assert.deepEqual(filterSidebarItems(items, '  '), items);
    assert.deepEqual(items, before); assert.equal(selected, 'launcher');
    assert.equal(sidebarMovement('ArrowDown', 2, 3), 0);
    assert.equal(sidebarMovement('ArrowUp', 0, 3), 2);
    assert.equal(sidebarMovement('Home', 2, 3), 0);
    assert.equal(sidebarMovement('End', 0, 3), 2);
    assert.equal(sidebarMovement('ArrowDown', 0, 0), null);
    assert.equal(sidebarMovement('ArrowRight', 0, 3), null);
    const key={key:'f',metaKey:true,ctrlKey:false,altKey:false,shiftKey:false};
    assert.equal(sidebarSearchShortcut(key), true);
    assert.equal(sidebarSearchShortcut({...key,ctrlKey:true}), false);
    assert.equal(sidebarSearchShortcut({...key,shiftKey:true}), false);
    assert.equal(sidebarSearchShortcut({...key,metaKey:false}), false);
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
