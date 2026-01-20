const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MkxpzLauncher = require("../src/modules/rgss/runtime/mkxpz-launcher");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("buildMkxpConfig maps advanced MKXP-Z settings", () => {
  const userDataDir = makeTempDir("maclauncher-mkxpz-user-");
  const gameDir = makeTempDir("maclauncher-mkxpz-game-");
  try {
    const rtpDir = path.join(gameDir, "rtp");
    const extraRtpDir = path.join(gameDir, "rtp-extra");
    fs.mkdirSync(rtpDir, { recursive: true });
    fs.mkdirSync(extraRtpDir, { recursive: true });

    const extraRtpArchive = path.join(gameDir, "extra.rtp.zip");
    fs.writeFileSync(extraRtpArchive, "zip");

    const soundfontPath = path.join(gameDir, "soundfont.sf2");
    const kawarikiPath = path.join(gameDir, "preload.rb");
    const extraPreload = path.join(gameDir, "extra-preload.rb");
    const postloadScript = path.join(gameDir, "postload.rb");
    const patchArchive = path.join(gameDir, "patch.zip");
    const customScript = path.join(gameDir, "custom.rb");
    fs.writeFileSync(soundfontPath, "sf2");
    fs.writeFileSync(kawarikiPath, "preload");
    fs.writeFileSync(extraPreload, "preload");
    fs.writeFileSync(postloadScript, "postload");
    fs.writeFileSync(patchArchive, "patch");
    fs.writeFileSync(customScript, "custom");

    const config = MkxpzLauncher.buildMkxpConfig({
      entry: {
        gamePath: gameDir,
        contentRootDir: gameDir,
        moduleData: {
          rgssVersion: "RGSS1",
          execName: "Game"
        }
      },
      userDataDir,
      runtimeSettings: {
        rtpMode: "manual",
        rtpPath: rtpDir,
        extraRtpPaths: `${extraRtpArchive},${extraRtpDir}`,
        soundfontPath,
        kawarikiPath,
        extraPreloadScripts: extraPreload,
        postloadScripts: postloadScript,
        patches: patchArchive,
        rgssVersion: "2",
        execName: "CustomGame",
        customScript,
        preferMetalRenderer: "true",
        enableBlitting: "auto",
        solidFonts: "Arial, Times New Roman",
        fontSub: "Arial>Open Sans"
      },
      logger: {
        warn: () => {},
        info: () => {}
      }
    });

    assert.equal(config.rgssVersion, 2);
    assert.equal(config.execName, "CustomGame");
    assert.deepEqual(config.RTP, [rtpDir, extraRtpArchive, extraRtpDir]);
    assert.deepEqual(config.preloadScript, [kawarikiPath, extraPreload]);
    assert.deepEqual(config.postloadScript, [postloadScript]);
    assert.deepEqual(config.patches, [patchArchive]);
    assert.equal(config.customScript, customScript);
    assert.equal(config.midiSoundFont, soundfontPath);
    assert.deepEqual(config.solidFonts, ["Arial", "Times New Roman"]);
    assert.deepEqual(config.fontSub, ["Arial>Open Sans"]);
    assert.equal(config.preferMetalRenderer, true);
    assert.equal(Object.prototype.hasOwnProperty.call(config, "enableBlitting"), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
});
