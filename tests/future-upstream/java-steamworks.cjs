// Steamworks4j publishes its JNI jars on Maven Central. The metadata file lists
// every version; each jar answers a HEAD request with its size, and a .sha1
// sidecar carries its digest (Maven Central publishes no .sha256 for it).
const crypto = require("node:crypto");
const BASE = "https://repo.maven.apache.org/maven2/com/code-disaster/steamworks4j/steamworks4j/";
const metadata = versions => `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.code-disaster.steamworks4j</groupId>
  <artifactId>steamworks4j</artifactId>
  <versioning>
    <latest>${versions.at(-1)}</latest>
    <release>${versions.at(-1)}</release>
    <versions>
${versions.map(version => `      <version>${version}</version>`).join("\n")}
    </versions>
    <lastUpdated>20260101000000</lastUpdated>
  </versioning>
</metadata>
`;
// A version's jar and its sidecar. `missing` lists versions whose jar is gone.
function routes(versions, { contents = {}, missing = [] } = {}) {
  const result = { [BASE + "maven-metadata.xml"]: metadata(versions) };
  for (const version of versions.filter(version => !missing.includes(version))) {
    const bytes = Buffer.from(contents[version] || `steamworks4j ${version} jar`), url = `${BASE}${version}/steamworks4j-${version}.jar`;
    result[url] = (_url, options = {}) => options.method === "HEAD"
      ? { status: 200, headers: { "content-length": String(bytes.length) }, body: Buffer.alloc(0) } : bytes;
    result[url + ".sha1"] = crypto.createHash("sha1").update(bytes).digest("hex");
  }
  return result;
}
const versions = ["1.8.0", "1.9.0", "1.10.0"];
module.exports = { managers: ["java-steamworks"], current: routes(versions),
  scenarios: {
    newVersion: { routes: routes([...versions, "1.11.0"]), version: "1.11.0", usable: true },
    // A listed version whose jar was not uploaded is skipped.
    listedWithoutJar: { routes: routes([...versions, "1.12.0"], { missing: ["1.12.0"] }), version: "1.12.0", usable: "either" },
    replacedFile: { routes: routes(versions, { contents: { "1.10.0": "steamworks4j 1.10.0 jar rebuilt" } }), version: "1.10.0", usable: true },
    deletedRelease: { routes: routes(versions.slice(1)), version: "1.10.0", usable: true, deleted: "1.8.0" }
  } };
