const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = "system3-executable-resources-v1";
const ORIGINAL_SHA256 = "a7f60d08693989ba45ac238ad60a37a7a15d50fc3c0d78a3e10c76fdc5acfd9d";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function adaptedResource(bytes) {
  if (digest(bytes) !== ORIGINAL_SHA256) throw new Error("System3 resource source checksum does not match the pinned version.");
  let source = bytes.toString("utf8");
  source = source.replace("#include <stdlib.h>\n", "#include <stdlib.h>\n#ifdef __APPLE__\n#include <mach-o/dyld.h>\n#include <stdint.h>\n#include <string.h>\n#endif\n");
  const anchor = "#else\n\t// On Android, read from APK assets.\n";
  const replacement = `#elif defined(__APPLE__)
	char executable[PATH_MAX];
	uint32_t executableLength = sizeof(executable);
	if (_NSGetExecutablePath(executable, &executableLength) != 0)
		return NULL;
	char resolved[PATH_MAX];
	if (!realpath(executable, resolved))
		return NULL;
	char* separator = strrchr(resolved, '/');
	if (!separator)
		return NULL;
	*separator = '\\0';
	char resource[PATH_MAX];
	int resourceLength = snprintf(resource, sizeof(resource), "%s/../share/system3/%s/%s", resolved, type, name);
	if (resourceLength < 0 || (size_t)resourceLength >= sizeof(resource))
		return NULL;
	return sdl::IOFromFile(resource, "rb");
#else
	// On Android, read from APK assets.
`;
  if (!source.includes(anchor)) throw new Error("System3 resource source does not match the Mac adapter.");
  return Buffer.from(source.replace(anchor, replacement));
}

function apply(sourceRoot, { sourceDir = path.resolve(__dirname, "../../external/system3-sdl2") } = {}) {
  if (!path.isAbsolute(sourceRoot || "") || !path.isAbsolute(sourceDir || "")) throw new Error("System3 source directories must be absolute.");
  const output = fs.realpathSync(sourceRoot), original = fs.realpathSync(sourceDir);
  if (output === original || output.startsWith(original + path.sep) || original.startsWith(output + path.sep)) {
    throw new Error("System3 source adapter requires a separate writable source copy.");
  }
  const file = path.join(output, "src/resource.cpp");
  if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(output + path.sep)) throw new Error("System3 resource source must be a contained regular file.");
  const adapted = adaptedResource(fs.readFileSync(file));
  fs.writeFileSync(file, adapted);
  return { version: VERSION, sourceSha256: ORIGINAL_SHA256, adaptedSourceSha256: digest(adapted), overlaySha256: digest(fs.readFileSync(__filename)) };
}

module.exports = { VERSION, ORIGINAL_SHA256, adaptedResource, apply };
