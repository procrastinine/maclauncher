const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

// Test the actual renderer's typed draft parser with Node's supported stripping
// flag, without a browser, Electron, or a second implementation of that parser.
function runModel(body) {
  const model = pathToFileURL(path.resolve(__dirname, "../src/renderer/src/ui/components/save-tools-model.ts")).href;
  const editor = pathToFileURL(path.resolve(__dirname, "../src/modules/shared/mvmz/save-editor.js")).href;
  const script = `
    import assert from 'node:assert/strict';
    const { valueDraft, structuredFields, draftChanges } = await import(${JSON.stringify(model)});
    const { default: Editor } = await import(${JSON.stringify(editor)});
    const data = {
      switches: { '@': 'Game_Switches', _data: { '@c': 1, '@a': [null, true] } },
      variables: { '@': 'Game_Variables', _data: [null, 10, 'text', { '@': 'PluginValue', x: 3 }] },
      party: { '@': 'Game_Party', _gold: 20, _items: { '1': 2 }, _weapons: {}, _armors: {}, _unknown: 'keep' },
      actors: { '@': 'Game_Actors', _data: [null, { '@r': 2 }] },
      pluginActor: { '@': 'Game_Actor', '@c': 2, _actorId: 1, _name: 'Hero', _hp: 40, _mp: 2, _tp: 0, _level: 1, _unknown: [null, 3] }
    };
    const inspection = { engineId: 'mv', fileName: 'file1.rpgsave', sourceHash: 'a'.repeat(64), ...Editor.inspectSaveData(data) };
    const groups = structuredFields(inspection);
    const fields = Object.values(groups).flat();
    ${body}
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("save form drafts retain negative zero, booleans, null and exact text", () => runModel(`
  assert.deepEqual(valueDraft(-0), { type: 'number', text: '-0' });
  assert.deepEqual(valueDraft(false), { type: 'boolean', text: 'false' });
  assert.deepEqual(valueDraft(null), { type: 'null', text: '' });
  assert.deepEqual(valueDraft('  hello  '), { type: 'string', text: '  hello  ' });
  assert.equal(groups.variables.find(field => field.id === 3).editable, false);
  assert.equal(groups.actors.find(field => field.field === 'hp').label, 'Hero · HP');
`));

test("save form changes produce backend-compatible edits and preserve referenced plugin state", () => runModel(`
  const changes = draftChanges(fields, {
    'switch:1': { type: 'boolean', text: 'false' },
    'variable:1': { type: 'number', text: '-2.5e2' },
    'variable:2': { type: 'string', text: '   ' },
    gold: { type: 'number', text: '1000' },
    'inventory:items:1': { type: 'number', text: '4' },
    'actor:1:hp': { type: 'number', text: '75' }
  });
  assert.equal(changes.length, 6);
  const edited = Editor.applySaveChanges(data, changes);
  assert.equal(edited.switches._data['@a'][1], false);
  assert.equal(edited.variables._data[1], -250);
  assert.equal(edited.variables._data[2], '   ');
  assert.equal(edited.party._gold, 1000);
  assert.equal(edited.party._items[1], 4);
  assert.equal(edited.pluginActor._hp, 75);
  assert.deepEqual(edited.actors._data[1], { '@r': 2 });
  assert.deepEqual(edited.pluginActor._unknown, [null, 3]);
  assert.equal(data.pluginActor._hp, 40);
`));

test("save form rejects incomplete, nonfinite, fractional or invalid typed numeric drafts", () => runModel(`
  for (const text of ['', ' ', '0x10', 'NaN', 'Infinity', '1e999', '5cats']) {
    assert.throws(() => draftChanges(fields, { 'variable:1': { type: 'number', text } }));
  }
  for (const text of ['-1', '2.5', '9007199254740992']) {
    assert.throws(() => draftChanges(fields, { gold: { type: 'number', text } }));
  }
  assert.throws(() => draftChanges(fields, { 'actor:1:level': { type: 'number', text: '0' } }));
  assert.throws(() => draftChanges(fields, { gold: { type: 'string', text: '200' } }));
  assert.throws(() => draftChanges(fields, { 'switch:1': { type: 'number', text: '1' } }));
  assert.throws(() => draftChanges(fields, { 'switch:1': { type: 'boolean', text: 'yes' } }));
`));

test("save form rejects unavailable and opaque targets and removes semantic no-ops", () => runModel(`
  assert.throws(() => draftChanges(fields, { 'variable:3': { type: 'number', text: '4' } }), /read-only/);
  assert.throws(() => draftChanges(fields, { 'party._unknown': { type: 'string', text: 'edit' } }), /read-only/);
  assert.deepEqual(draftChanges(fields, { 'variable:1': { type: 'number', text: '1e1' },
    'switch:1': { type: 'boolean', text: 'true' } }), []);
  assert.deepEqual(draftChanges(fields, { 'variable:2': { type: 'null', text: '' } }),
    [{ kind: 'variable', id: 2, value: null }]);
`));
