const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function component(value) { return typeof value === "string" && value.trim() && value.length <= 255 && !/[\\/\x00-\x1f]/.test(value) && ![".", ".."].includes(value) ? value : null; }
function resolveSaveLocations(entry, context = {}) {
  const company = component(entry.moduleData?.companyName), product = component(entry.moduleData?.productName);
  if (!company || !product) return { primaryDirectory: null, directories: [] };
  const home = context.homeDir || os.homedir(), candidates = [path.join(home, "Library", "Application Support", company, product),
    path.join(home, "Library", "Application Support", `unity.${company}.${product}`), path.join(home, "Library", "Caches", `unity.${company}.${product}`)];
  const directories = candidates.map(directory => {
    let exists = false; try { exists = fs.statSync(directory).isDirectory(); } catch {}
    return { directory, exists, source: "Unity company/product metadata", confidence: "default", label: "Unity saves" };
  });
  return { primaryDirectory: directories.find(location => location.exists)?.directory || candidates[0], directories };
}

module.exports = { resolveSaveLocations, component };
