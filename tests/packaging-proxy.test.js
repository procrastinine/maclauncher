const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const run = promisify(execFile);
const bytes = Buffer.from("Synthetic proxy download artifact\n");
const checksum = createHash("sha256").update(bytes).digest("hex");

test("packaging downloads preserve proxy routing, bypasses, TLS and checksums", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maclauncher-proxy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keyPath = path.join(root, "key.pem");
  const certPath = path.join(root, "cert.pem");
  const configPath = path.join(root, "openssl.cnf");
  await fs.writeFile(configPath, [
    "[req]", "distinguished_name=dn", "x509_extensions=extensions", "prompt=no",
    "[dn]", "CN=localhost", "[extensions]", "subjectAltName=DNS:localhost",
    "basicConstraints=critical,CA:TRUE", ""
  ].join("\n"));
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-config", configPath, "-keyout", keyPath, "-out", certPath]);

  const requests = { direct: [], secure: [], proxy: [], tunnels: [] };
  const sockets = new Set();
  async function listen(server) {
    server.on("connection", socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server.address().port;
  }
  function reply(kind) {
    return (request, response) => {
      requests[kind].push(request.url);
      response.end(bytes);
    };
  }
  const httpPort = await listen(http.createServer(reply("direct")));
  const httpsPort = await listen(https.createServer({
    key: await fs.readFile(keyPath), cert: await fs.readFile(certPath)
  }, reply("secure")));
  const proxy = http.createServer(reply("proxy"));
  proxy.on("connect", (request, client, head) => {
    requests.tunnels.push(request.url);
    // Only the local synthetic HTTPS origin is reachable through this fixture.
    if (request.url !== `localhost:${httpsPort}`) return client.destroy();
    const upstream = net.connect(httpsPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const script = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs/promises");
    const { createRequire } = require("node:module");
    const options = JSON.parse(process.argv[1]);
    const builderRequire = createRequire(options.builder);
    const downloader = builderRequire("@electron/get");
    (async () => {
      await fs.mkdir(options.cache, { recursive: true });
      const download = downloader.downloadArtifact({
        version: "44.5.1", artifactName: "fixture.zip", isGeneric: true,
        cacheRoot: options.cache, tempDirectory: options.cache,
        mirrorOptions: { mirror: options.mirror },
        checksums: { "fixture.zip": options.checksum },
        downloadOptions: { quiet: true, retry: { limit: 0 }, timeout: { request: 3000 } }
      });
      if (options.error) await assert.rejects(download, new RegExp(options.error, "i"));
      else assert.equal(await fs.readFile(await download, "utf8"), options.bytes);
    })().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  `;
  let sequence = 0;
  async function download({ secure = false, bypass = false, trusted = true, corrupt = false } = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/proxy|^npm_config_electron|^electron_|^node_(extra_ca_certs|tls_reject_unauthorized|use_env_proxy|options)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      ELECTRON_GET_USE_PROXY: "1", ELECTRON_GET_NO_PROGRESS: "1",
      GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      GLOBAL_AGENT_NO_PROXY: bypass ? "localhost" : ""
    });
    if (trusted) env.NODE_EXTRA_CA_CERTS = certPath;
    const options = {
      builder: require.resolve("app-builder-lib/package.json"),
      cache: path.join(root, `download-${sequence++}`),
      mirror: `${secure ? "https" : "http"}://localhost:${secure ? httpsPort : httpPort}/`,
      checksum: corrupt ? "0".repeat(64) : checksum, bytes: bytes.toString(),
      error: !trusted ? "self.signed|certificate" : corrupt ? "checksum|hash" : ""
    };
    await run(process.execPath, ["-e", script, JSON.stringify(options)], { env, timeout: 5000 });
  }

  await download();
  assert.deepEqual(requests.proxy, [`http://localhost:${httpPort}/v44.5.1/fixture.zip`]);
  assert.deepEqual(requests.direct, []);
  await download({ bypass: true });
  assert.deepEqual(requests.direct, ["/v44.5.1/fixture.zip"]);
  assert.equal(requests.proxy.length, 1);
  await download({ secure: true });
  assert.deepEqual(requests.tunnels, [`localhost:${httpsPort}`]);
  assert.deepEqual(requests.secure, ["/v44.5.1/fixture.zip"]);
  await download({ secure: true, bypass: true });
  assert.equal(requests.tunnels.length, 1);
  assert.equal(requests.secure.length, 2);
  await download({ secure: true, trusted: false });
  assert.equal(requests.tunnels.length, 2);
  assert.equal(requests.secure.length, 2, "Untrusted TLS must fail before sending the request");
  await download({ corrupt: true });
  assert.equal(requests.proxy.length, 2);
});
