const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function blueprintFile(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'android-blueprint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'Android.bp');
  fs.writeFileSync(file, text);
  return { directory, file };
}

test('Blueprint lists respect comments, quoted strings and top-level module properties', async t => {
  const { parseBlueprint, readModuleList } = await import('../src/modules/android/native/upstream/blueprint.mjs');
  const source = String.raw`
    // name: "chosen", srcs: ["comment.cpp"]
    cc_defaults {
      name: "decoy",
      android_name: "chosen",
      srcs: ["decoy.cpp"],
      target: { android: { name: "chosen", srcs: ["nested-decoy.cpp"] } },
    }
    /* cc_defaults { name: "chosen", srcs: ["block-comment.cpp"] } */
    cc_defaults {
      name: "chosen",
      target: { android: { srcs: ["nested.cpp"] } },
      srcs: [
        "https://example.invalid/source//one.cpp", // trailing comment
        "literal/*comment*/.cpp",
        "quoted\"name.cpp",
        "dir\\name.cpp", /* punctuation inside comments: } ] , " */
      ],
      enabled: true,
      version: 7,
    }
    cc_defaults { name: "nested-only", target: { android: { srcs: ["hidden.cpp"] } } }
  `;
  const { directory, file } = blueprintFile(t, source);
  const parsed = parseBlueprint(source, { file });
  const expected = [
    'https://example.invalid/source//one.cpp',
    'literal/*comment*/.cpp',
    'quoted"name.cpp',
    'dir\\name.cpp',
  ];
  assert.equal(parsed.modules.length, 3);
  assert.equal(parsed.modules[1].type, 'cc_defaults');
  assert.ok(parsed.modules[1].location);
  assert.deepEqual(parsed.modules[1].properties.srcs, expected);
  assert.equal(parsed.modules[1].properties.enabled, true);
  assert.equal(parsed.modules[1].properties.version, 7);
  assert.deepEqual(readModuleList(directory, 'chosen', 'srcs'), expected);
  assert.throws(() => readModuleList(directory, 'missing', 'srcs'));
  assert.throws(() => readModuleList(directory, 'nested-only', 'srcs'));

  fs.appendFileSync(file, '\ncc_library { name: "chosen", srcs: ["duplicate.cpp"] }\n');
  assert.throws(() => readModuleList(directory, 'chosen', 'srcs'));
});

test('Blueprint variables resolve assignment, append and string, list and map addition', async t => {
  const { parseBlueprint, readModuleList } = await import('../src/modules/android/native/upstream/blueprint.mjs');
  const source = `
    prefix = "lib"
    prefix += "combined"
    sources = ["first.cpp"]
    sources += ["second.cpp"]
    extra = ["third.cpp"]
    settings = {
      cflags: ["-DFIRST"],
      arch: { arm64: { srcs: ["arm64-first.cpp"] } },
    } + {
      cflags: ["-DSECOND"],
      arch: { arm64: { srcs: ["arm64-second.cpp"] } },
      enabled: true,
    }
    cc_defaults {
      name: prefix + "_defaults",
      srcs: sources + extra + ["last.cpp"],
      settings: settings,
    }
  `;
  const { directory, file } = blueprintFile(t, source);
  const parsed = parseBlueprint(source, { file });
  assert.equal(parsed.variables.prefix, 'libcombined');
  assert.deepEqual(parsed.variables.sources, ['first.cpp', 'second.cpp']);
  assert.deepEqual(parsed.variables.settings, {
    cflags: ['-DFIRST', '-DSECOND'],
    arch: { arm64: { srcs: ['arm64-first.cpp', 'arm64-second.cpp'] } },
    enabled: true,
  });
  assert.deepEqual(parsed.modules[0].properties.settings, parsed.variables.settings);
  assert.deepEqual(readModuleList(directory, 'libcombined_defaults', 'srcs'), [
    'first.cpp', 'second.cpp', 'third.cpp', 'last.cpp',
  ]);
});

test('Blueprint preserves unresolved expressions and rejects only the requested invalid list', async t => {
  const { parseBlueprint, readModuleList } = await import('../src/modules/android/native/upstream/blueprint.mjs');
  const source = `
    cc_defaults {
      name: "dynamic",
      srcs: ["known.cpp"],
      cflags: select(arch(), {
        "arm64": ["-DARM64"],
        default: ["-DOTHER"],
      }),
      missing: undefined_sources,
      mixed: ["known.cpp", undefined_source],
      scalar: "single.cpp",
      numbers: [1, 2],
    }
  `;
  const { directory, file } = blueprintFile(t, source);
  const properties = parseBlueprint(source, { file }).modules[0].properties;
  for (const value of [properties.cflags, properties.missing, properties.mixed[1]]) {
    assert.ok(value && value.$expression, 'unresolved values remain explicit expressions');
    assert.equal(typeof value.$expression.kind, 'string');
    assert.ok(value.$expression.kind.length > 0);
  }
  assert.deepEqual(readModuleList(directory, 'dynamic', 'srcs'), ['known.cpp']);
  for (const property of ['cflags', 'missing', 'mixed', 'scalar', 'numbers', 'absent']) {
    assert.throws(() => readModuleList(directory, 'dynamic', property), property);
  }
});


test('Original Blueprint legacy modules retain exact declarations and UTF-16 locations', async () => {
  const {parseBlueprint}=await import('../src/modules/android/native/upstream/blueprint.mjs');
  const source='// emoji 😀\nfilegroup(name = "tensorflow_c_srcs", srcs = ["*.cc"], target = { android: { enabled: true } },)';
  const module=parseBlueprint(source,{file:'tensorflow/c/Android.bp'}).modules[0];
  assert.equal(module.type,'filegroup');
  assert.deepEqual(module.properties,{name:'tensorflow_c_srcs',srcs:['*.cc'],target:{android:{enabled:true}}});
  assert.deepEqual(module.location,{file:'tensorflow/c/Android.bp',line:2,column:1,offset:source.indexOf('filegroup'),byteOffset:Buffer.byteLength(source.slice(0,source.indexOf('filegroup')))});
  assert.throws(()=>parseBlueprint('filegroup { name: "invalid", srcs: glob(["*.cc"]) }'),/expected|got|found/);
});

test('deferred expressions retain original conditions and bindings after lexical relocation',async()=>{
  const {parseBlueprint}=await import('../src/modules/android/native/upstream/blueprint.mjs');
  const parsed=parseBlueprint(`
    local = inherited + ["local"]
    filegroup { name: "deferred", values: local + select(release_flag("FEATURE"), {
      "enabled": local,
      any @ inherited: [inherited],
      default: [],
    }) }
  `,{parents:[{file:'Android.bp',source:'inherited = ["parent"]'}]});
  const expression=parsed.modules[0].properties.values.$expression;
  assert.match(expression.text,/release_flag\("FEATURE"\)/);
  assert.match(expression.text,/any @ inherited/);
  assert.match(expression.text,/"parent"/);
  assert.doesNotMatch(expression.text,/\blocal\b(?=\s*[,}])/);
  const moved=parseBlueprint('filegroup {name:"moved", values:'+expression.text+'}');
  assert.equal(moved.modules[0].properties.values.$expression.text,expression.text);
});
