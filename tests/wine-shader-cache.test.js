const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Cache = require("../src/modules/crossover/runtime/shader-cache");
const CrossOver = require("../src/modules/crossover/runtime/launch");
const Sikarugir = require("./helpers/wine-source.cjs").launch("sikarugir");
function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-shader-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("Wine routes use distinct launcher runtime caches, outside HOME and prefixes", t => {
  const own = root(t), inherited = { HOME: "/owner/home", MESA_SHADER_CACHE_DIR: "/owner/home/.cache", DXVK_SHADER_CACHE_PATH: "Z:\\owner\\cache", CUSTOM: "retained" };
  const install = { crossoverRoot: "/fixture/CrossOver", executablePath: "/fixture/bin/wine", serverPath: "/fixture/bin/wineserver", capabilities: {} };
  const settings = { environment: ["MESA_SHADER_CACHE_DIR=/bottle/cache", "DXVK_SHADER_CACHE_PATH=Z:\\bottle\\cache"] };
  const cxRoot = path.join(own, "crossover"), bottle = path.join(cxRoot, "bottles", "win10_64");
  const cx = CrossOver.buildEnvironment(settings, install, cxRoot, bottle, { baseEnvironment: inherited });
  const sgRoot = path.join(own, "sikarugir"), prefix = path.join(sgRoot, "prefixes", "win10");
  const sg = Sikarugir.buildEnvironment(settings, install, sgRoot, prefix, { vulkanBackend: "kosmickrisp" }, { baseEnvironment: inherited });
  assert.equal(cx.environment.MESA_SHADER_CACHE_DIR, path.join(cxRoot, "cache", "mesa"));
  assert.equal(cx.overrides.MESA_SHADER_CACHE_DIR, cx.environment.MESA_SHADER_CACHE_DIR);
  assert.equal(sg.environment.MESA_SHADER_CACHE_DIR, path.join(sgRoot, "cache", "mesa"));
  assert.notEqual(cx.environment.MESA_SHADER_CACHE_DIR, sg.environment.MESA_SHADER_CACHE_DIR);
  assert.equal(cx.environment.WINEPREFIX, bottle); assert.equal(sg.environment.WINEPREFIX, prefix);
  assert.equal(sg.environment.HOME, path.join(sgRoot, "home"));
  assert.equal(cx.environment.CUSTOM, "retained"); assert.equal(sg.environment.CUSTOM, "retained");
  assert.equal(inherited.MESA_SHADER_CACHE_DIR, "/owner/home/.cache");
  assert.equal(fs.existsSync(path.join(cxRoot, "cache")), false, "environment construction does not create cache files");
  assert.equal(fs.existsSync(path.join(sgRoot, "cache")), false);
  assert.equal(cx.overrides.MESA_SHADER_CACHE_MAX_SIZE, "4G");
  assert.equal(sg.environment.MESA_SHADER_CACHE_MAX_SIZE, "4G");
});
test("per-game Mesa cache budgets preserve global, game, inherited and external values", t => {
  const own = root(t), Launch = require("../src/modules/shared/runtime/translator-environment-launch");
  const install = { crossoverRoot: "/fixture/CrossOver", executablePath: "/fixture/bin/wine", serverPath: "/fixture/bin/wineserver", capabilities: {} };
  const context = { settings: { launcher: { translatorEnvironment: { kosmickrisp: { MESA_SHADER_CACHE_MAX_SIZE: "6G" } } } } };
  const entry = { translatorEnvironment: { kosmickrisp: { MESA_SHADER_CACHE_MAX_SIZE: "8G" } } };
  const cases = [
    { name: "absent", expected: "4G" },
    { name: "global", expected: "6G", translatorEnvironment: Launch.forLaunch({}, context, ["kosmickrisp"]).values },
    { name: "game", expected: "8G", translatorEnvironment: Launch.forLaunch(entry, context, ["kosmickrisp"]).values },
    { name: "inherited", expected: "2G", baseEnvironment: { MESA_SHADER_CACHE_MAX_SIZE: "2G" } },
    { name: "external", expected: "512M", existingEnvironment: { environment: { MESA_SHADER_CACHE_MAX_SIZE: "512M" } } },
    { name: "empty user value", expected: "", translatorEnvironment: { MESA_SHADER_CACHE_MAX_SIZE: "" } }
  ];
  for (const { name, expected, ...options } of cases) {
    const directory = path.join(own, name), prefix = path.join(directory, "prefix");
    const input = { baseEnvironment: {}, ...options };
    const cx = CrossOver.buildEnvironment({}, install, directory, prefix, input);
    const sg = Sikarugir.buildEnvironment({}, install, directory, prefix, { vulkanBackend: "kosmickrisp" }, input);
    for (const environment of [cx.environment, cx.overrides, sg.environment]) {
      assert.equal(environment.MESA_SHADER_CACHE_MAX_SIZE, expected, name);
      assert.equal(environment.MESA_SHADER_CACHE_DIR, path.join(directory, "cache", "mesa"), name);
    }
    assert.equal(Object.hasOwn(input.baseEnvironment, "MESA_SHADER_CACHE_DIR"), false);
  }
  const unrelated = Launch.apply({ PATH: "/usr/bin" }, {}, {}, ["kosmickrisp"]);
  assert.equal(Object.hasOwn(unrelated, "MESA_SHADER_CACHE_DIR"), false);
  assert.equal(Object.hasOwn(unrelated, "MESA_SHADER_CACHE_MAX_SIZE"), false, "launches without the per-game cache receive no budget default");
});
test("an existing cache-directory alias is rejected without writing through it", t => {
  const own = root(t), target = root(t);
  fs.symlinkSync(target, path.join(own, "cache"));
  assert.throws(() => Cache.environment(own), /must not be aliases/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test("DXVK cache paths retain spaces and Unicode and reject a leaf alias", t => {
  const own = root(t), runtime = path.join(own, "runtime with spaces 雪");
  Cache.environment(runtime);
  assert.equal(fs.existsSync(runtime), false);
  fs.mkdirSync(path.join(runtime, "cache"), { recursive: true });
  const target = root(t); fs.symlinkSync(target, path.join(runtime, "cache", "dxvk"));
  assert.throws(() => Cache.environment(runtime), /must not be aliases/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('DXVK uses a mapped runtime directory in a bottle with no Z drive', t => {
 const own = root(t), prefix = path.join(own,'bottle'), runtime = path.join(own,'runtime with spaces 雪');
 fs.mkdirSync(runtime); fs.mkdirSync(path.join(prefix,'dosdevices'),{recursive:true});
 const first=Cache.prepare(runtime,prefix);assert.match(first.DXVK_SHADER_CACHE_PATH,/^[D-Y]:\\cache\\dxvk$/);
 assert.equal(fs.existsSync(path.join(prefix,'dosdevices','z:')),false);
 assert.deepEqual(Cache.prepare(runtime,prefix),first);
 const letter=first.DXVK_SHADER_CACHE_PATH[0].toLowerCase();assert.equal(fs.realpathSync(path.join(prefix,'dosdevices',letter+':')),fs.realpathSync(runtime));
 assert.ok(fs.statSync(path.join(runtime,'cache','dxvk')).isDirectory(), 'DXVK receives an existing cache directory on a first launch');
});
