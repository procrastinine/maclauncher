const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { inspectMedia } = require("../src/modules/video/inspect");
test("media inspection uses an explicit private script, null output and file-only input", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-inspect-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "original.mp4"); fs.writeFileSync(input, "original");
  const entry = { gameId: "media", gamePath: input, moduleData: {} }, context = { userDataDir: path.join(root, "profile"), settings: {} };
  const manager = { id: "mpv", resolveForPlay: () => ({ ready: true, version: "0.41.0", install: { executablePath: "/managed/mpv", installDir: "/managed" } }) };
  const result = await inspectMedia(entry, {}, context, { manager, withRuntimeUse: async (_ids, work) => work({ bind: async () => {} }),
    runCommand: async (_file, args, options) => {
      for (const flag of ["--no-config", "--load-scripts=no", "--ao=null", "--vo=null", "--pause=yes", "--demuxer-lavf-o=protocol_whitelist=file"]) assert.ok(args.includes(flag));
      assert.equal(args.at(-1), input);
      assert.ok(fs.existsSync(args.find(a => a.startsWith("--script=")).slice(9)));
      fs.writeFileSync(options.env.MACLAUNCHER_MEDIA_INFO, JSON.stringify({ format: "mov", duration: 1, tracks: [{ codec: "h264" }] }));
    } });
  assert.equal(result.tracks, 1); assert.equal(JSON.parse(fs.readFileSync(result.output)).format, "mov");
  assert.equal(fs.readFileSync(input, "utf8"), "original");
});
