const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gzipSync } = require("node:zlib");

// Opt in with an installed pnpm 12 executable or its JavaScript entry point.
// With no executable supplied, even fixture creation and localhost I/O are skipped.
const pnpmBin = process.env.MACLAUNCHER_TEST_PNPM_BIN;
const policyFile = path.join(__dirname, "..", "pnpm-workspace.yaml");
const version = "1.0.0";
const sevenDays = 7 * 24 * 60;
const eightDays = 8 * 24 * 60;

function tarball(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100, "utf8");
    const octal = (value, offset, length) => {
      header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
    };
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(body.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function withSettings(policy, settings) {
  for (const [key, value] of Object.entries(settings)) {
    const setting = new RegExp(`^${key}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m");
    assert.match(policy, setting, `Fixture override must refer to a real repository setting: ${key}`);
    policy = policy.replace(setting, `${key}: ${JSON.stringify(value)}`);
  }
  return policy;
}

async function fixture(t, settings = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-pnpm-supply-chain-")));
  const workspace = path.join(root, "workspace");
  const marker = path.join(root, "install-script-ran");
  const dirs = Object.fromEntries(["store", "cache", "state", "config", "data", "tmp"].map(name => [name, path.join(root, name)]));
  for (const dir of [workspace, ...Object.values(dirs)]) fs.mkdirSync(dir);
  const emptyConfig = path.join(dirs.config, "empty.npmrc");
  fs.writeFileSync(emptyConfig, "");
  const packages = new Map();
  const archives = new Map();
  const requests = [];
  const children = new Set();
  const serve = (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    requests.push({ method: req.method, pathname });
    const archive = archives.get(pathname);
    const metadata = packages.get(pathname.slice(1));
    if (req.method === "GET" && archive) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(archive);
    } else if (req.method === "GET" && metadata) {
      // Supply full publication metadata, including for pnpm's abbreviated Accept header.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(metadata));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown synthetic package" }));
    }
  };
  const server = http.createServer(serve);
  const servers = [server];
  t.after(async () => {
    try {
      await Promise.all([...children].map(child => new Promise(resolve => {
        child.once("close", resolve);
        child.kill("SIGKILL");
      })));
      for (const host of servers) {
        host.closeAllConnections();
        if (host.listening) await new Promise((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
        assert.equal(host.listening, false, "Fixture registry must close");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, "Private workspace, store, caches, and script markers must be removed");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const registry = `http://127.0.0.1:${server.address().port}/`;
  // Copy the authoritative policy, changing only harness concerns or an explicit control.
  const repositoryPolicy = fs.readFileSync(policyFile, "utf8");
  const configure = (overrides = {}) => {
    // These synthetic packages have no application dependencies to patch.
    const policy = withSettings(repositoryPolicy, {patchedDependencies: {}, ...overrides});
    const isolatedSettings = {
      registry, storeDir: dirs.store, cacheDir: dirs.cache,
      fetchRetries: 0, fetchTimeout: 5000, updateNotifier: false
    };
    fs.writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), policy + "\n" +
      Object.entries(isolatedSettings).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join(""));
  };
  configure(settings);
  const manifest = dependencies => fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    name: "supply-chain-fixture", private: true, version, dependencies
    // No packageManager: invoking the supplied executable must never acquire another pnpm.
  }, null, 2) + "\n");
  manifest({});
  // Do not inherit npm/pnpm settings, proxies, credentials, or NODE_OPTIONS from the caller.
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    CI: "true", NO_COLOR: "1", TERM: "dumb",
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
    npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyConfig,
    PNPM_CONFIG_STORE_DIR: dirs.store, PNPM_CONFIG_CACHE_DIR: dirs.cache, PNPM_CONFIG_STATE_DIR: dirs.state,
    COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    MACLAUNCHER_TEST_SCRIPT_MARKER: marker
  };
  const run = (args = ["install", "--no-frozen-lockfile"]) => new Promise((resolve, reject) => {
    // Asynchronous execution is required so this process can serve registry requests.
    const executable = path.resolve(pnpmBin);
    const isJavaScript = /\.[cm]?js$/i.test(executable);
    const child = spawn(isJavaScript ? process.execPath : executable, isJavaScript ? [executable, ...args] : args, {
      cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], timeout: 20000, killSignal: "SIGKILL"
    });
    children.add(child);
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      children.delete(child);
      if (signal) reject(new Error(`pnpm ${args.join(" ")} ended with ${signal}\n${output}`));
      else resolve({ code, output });
    });
  });
  const add = (name, { age = eightDays, missingTime, dependencies, scripts, files = {} } = {}) => {
    const packageManifest = { name, version, main: "index.js", ...(dependencies && { dependencies }), ...(scripts && { scripts }) };
    const archive = tarball({
      "package.json": JSON.stringify(packageManifest) + "\n",
      "index.js": `module.exports = ${JSON.stringify(name)};\n`,
      ...files
    });
    const archivePath = `/${name}/-/${name}-${version}.tgz`;
    archives.set(archivePath, archive);
    const published = new Date(Date.now() - age * 60000).toISOString();
    packages.set(name, {
      name, "dist-tags": { latest: version },
      versions: { [version]: { ...packageManifest, dist: {
        tarball: registry + archivePath.slice(1),
        integrity: "sha512-" + createHash("sha512").update(archive).digest("base64"),
        shasum: createHash("sha1").update(archive).digest("hex")
      } } },
      ...(missingTime === "all" ? {} : { time: {
        created: published, modified: published,
        ...(missingTime === "version" ? {} : { [version]: published })
      } })
    });
    return registry + archivePath.slice(1);
  };
  const installed = name => path.join(workspace, "node_modules", name, "package.json");
  const requested = name => requests.some(request => request.pathname === `/${name}`);
  const downloaded = name => requests.some(request => request.pathname === `/${name}/-/${name}-${version}.tgz`);
  const exoticTarball = async name => {
    // Tarballs on the configured registry origin are allowed; use a second loopback origin.
    const host = http.createServer(serve);
    servers.push(host);
    await new Promise((resolve, reject) => {
      host.once("error", reject);
      host.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${host.address().port}/${name}/-/${name}-${version}.tgz`;
  };
  return { root, workspace, marker, dirs, registry, requests, configure, manifest, run, add, exoticTarball, installed, requested, downloaded };
}

function rejected(result, reason, name) {
  assert.notEqual(result.code, 0, `pnpm unexpectedly accepted ${name}\n${result.output}`);
  assert.match(result.output, reason);
  const unwrapped = result.output.replace(/-\s*\n\s*/g, "-");
  assert.ok(unwrapped.includes(name), `Rejection should identify ${name}\n${result.output}`);
}

function payload() {
  return {
    scripts: { install: "node install.cjs" },
    files: { "install.cjs": "require('node:fs').writeFileSync(process.env.MACLAUNCHER_TEST_SCRIPT_MARKER, 'executed');\n" }
  };
}

test("pnpm 12 supply-chain behavior", {
  skip: pnpmBin ? false : "Set MACLAUNCHER_TEST_PNPM_BIN to an installed pnpm 12 executable; no packages are fetched by default",
  timeout: 180000
}, async t => {
  const probe = await fixture(t);
  const executableVersion = await probe.run(["--version"]);
  assert.equal(executableVersion.code, 0, executableVersion.output);
  assert.match(executableVersion.output.trim(), /^12\.\d+\.\d+$/, "Supply-chain tests require the actual pnpm 12 executable");

  await t.test("an eight-day-old package installs from the synthetic registry", async t => {
    const f = await fixture(t);
    const name = "fixture-old-release";
    f.add(name);
    f.manifest({ [name]: version });
    const result = await f.run();
    assert.equal(result.code, 0, result.output);
    assert.equal(JSON.parse(fs.readFileSync(f.installed(name))).version, version);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.installed(name)), "index.js"), "utf8"), `module.exports = "${name}";\n`);
    assert.ok(f.requested(name));
    assert.ok(f.downloaded(name), "Success must unpack the actual synthetic tar.gz");
    assert.ok(fs.readdirSync(f.dirs.store).length > 0, "The install must populate its private store");
    assert.ok(fs.realpathSync(f.installed(name)).startsWith(f.workspace + path.sep), "Installed dependency must stay within the private workspace");
  });

  for (const [label, age] of [["fresh", 0], ["just-under-seven-day-old", sevenDays - 1]]) {
    await t.test(`a ${label} direct dependency is rejected by the seven-day release hold`, async t => {
      const f = await fixture(t);
      const name = "fixture-young-direct";
      f.add(name, { age });
      f.manifest({ [name]: version });
      rejected(await f.run(), /ERR_PNPM_NO_MATURE_MATCHING_VERSION/, name);
      assert.ok(f.requested(name), "pnpm must inspect real registry publication metadata");
      assert.equal(fs.existsSync(f.installed(name)), false);
      if (age === 0) {
        f.configure({ minimumReleaseAgeStrict: false });
        const allowed = await f.run();
        assert.equal(allowed.code, 0, allowed.output);
        assert.equal(JSON.parse(fs.readFileSync(f.installed(name))).version, version);
      }
    });
  }

  await t.test("a release just over 10080 minutes old is permitted", async t => {
    const f = await fixture(t);
    const name = "fixture-mature-boundary";
    f.add(name, { age: sevenDays + 1 });
    f.manifest({ [name]: version });
    const result = await f.run();
    assert.equal(result.code, 0, result.output);
    assert.equal(JSON.parse(fs.readFileSync(f.installed(name))).version, version);
    assert.ok(f.downloaded(name));
  });

  await t.test("an old parent cannot introduce a fresh transitive dependency", async t => {
    const f = await fixture(t);
    const child = "fixture-young-child";
    const parent = "fixture-old-parent";
    f.add(child, { age: 0 });
    f.add(parent, { dependencies: { [child]: version } });
    f.manifest({ [parent]: version });
    rejected(await f.run(), /ERR_PNPM_NO_MATURE_MATCHING_VERSION/, child);
    assert.ok(f.requested(parent));
    assert.ok(f.requested(child));
    assert.equal(fs.existsSync(f.installed(child)), false);
  });

  for (const missingTime of ["all", "version"]) {
    await t.test(`missing ${missingTime === "all" ? "publication metadata" : "version publication time"} fails closed`, async t => {
      const f = await fixture(t);
      const name = "fixture-missing-time";
      f.add(name, { missingTime });
      f.manifest({ [name]: version });
      rejected(await f.run(), /ERR_PNPM_MISSING_TIME/, name);
      assert.ok(f.requested(name));
      assert.equal(fs.existsSync(f.installed(name)), false);
      f.configure({ minimumReleaseAgeIgnoreMissingTime: true });
      const allowed = await f.run();
      assert.equal(allowed.code, 0, allowed.output);
      assert.equal(JSON.parse(fs.readFileSync(f.installed(name))).version, version);
    });
  }

  await t.test("a frozen lockfile made with age zero is revalidated under the repository policy", async t => {
    const f = await fixture(t, { minimumReleaseAge: 0 });
    const name = "fixture-locked-fresh";
    f.add(name, { age: 0 });
    f.manifest({ [name]: version });
    const seeded = await f.run(["install", "--lockfile-only", "--no-frozen-lockfile"]);
    assert.equal(seeded.code, 0, seeded.output);
    const lockfile = path.join(f.workspace, "pnpm-lock.yaml");
    const lock = fs.readFileSync(lockfile, "utf8");
    assert.ok(lock.includes(`${name}@${version}`), "Control must actually lock the fresh package");
    assert.equal(fs.existsSync(f.installed(name)), false);
    f.configure();
    // Require a new registry read instead of accidentally relying on seeding metadata.
    fs.rmSync(f.dirs.cache, { recursive: true, force: true });
    f.requests.length = 0;
    rejected(await f.run(["install", "--frozen-lockfile"]), /ERR_PNPM_MINIMUM_RELEASE_AGE/, name);
    assert.ok(f.requested(name), "trustLockfile: false must revalidate locked publication metadata");
    assert.equal(fs.readFileSync(lockfile, "utf8"), lock);
    assert.equal(fs.existsSync(f.installed(name)), false);
    f.configure({ trustLockfile: true });
    const trusted = await f.run(["install", "--frozen-lockfile"]);
    assert.equal(trusted.code, 0, trusted.output);
    assert.equal(JSON.parse(fs.readFileSync(f.installed(name))).version, version);
  });

  await t.test("an old registry package cannot introduce an exotic tarball subdependency", async t => {
    const f = await fixture(t);
    const child = "exotic-child";
    const parent = "exotic-parent";
    f.add(child);
    const tarballUrl = await f.exoticTarball(child);
    f.add(parent, { dependencies: { [child]: tarballUrl } });
    f.manifest({ [parent]: version });
    rejected(await f.run(), /ERR_PNPM_EXOTIC_SUBDEP/, child);
    assert.ok(f.requested(parent));
    assert.equal(fs.existsSync(f.installed(child)), false);
    // Same valid archive succeeds when only this safeguard is disabled.
    f.configure({ blockExoticSubdeps: false });
    const allowed = await f.run();
    assert.equal(allowed.code, 0, allowed.output);
    assert.ok(f.downloaded(child));
    assert.equal(JSON.parse(fs.readFileSync(f.installed(child))).name, child);
  });

  await t.test("strict build review rejects an unapproved install script before it can write a marker", async t => {
    const f = await fixture(t);
    const name = "fixture-install-payload";
    f.add(name, payload());
    f.manifest({ [name]: version });
    rejected(await f.run(), /ERR_PNPM_IGNORED_BUILDS/, name);
    assert.ok(f.downloaded(name), "The malicious script must reach the build review step");
    assert.equal(fs.existsSync(f.marker), false);
    // Prove the script itself can run: explicitly reviewing it allows this local-only payload.
    f.configure({ allowBuilds: { [name]: true } });
    const allowed = await f.run(["install", "--force", "--no-frozen-lockfile"]);
    assert.equal(allowed.code, 0, allowed.output);
    assert.equal(fs.readFileSync(f.marker, "utf8"), "executed");
  });

  await t.test("the repository's explicit allowBuilds: false installs without executing the denied script", async t => {
    const f = await fixture(t);
    // This name is intentionally denied by the authoritative repository policy.
    const name = "electron-winstaller";
    f.add(name, payload());
    f.manifest({ [name]: version });
    const result = await f.run();
    assert.equal(result.code, 0, result.output);
    assert.ok(f.downloaded(name));
    assert.equal(JSON.parse(fs.readFileSync(f.installed(name))).name, name);
    assert.ok(fs.existsSync(path.join(path.dirname(f.installed(name)), "install.cjs")));
    assert.equal(fs.existsSync(f.marker), false);
  });
});
