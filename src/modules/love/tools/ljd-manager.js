const { createManagedPythonTool } = require("../../shared/runtime/managed-python-tool");
const { createGithubCommitDiscovery } = require("../../shared/runtime/github-runtime-catalog");

module.exports = createManagedPythonTool({ id: "ljd", label: "LJD", scriptName: "main.py", order: 270,
  requiredFiles: ["main.py", "ljd/__init__.py", "LICENSE", "LICENSE-upstream"],
  sourceUrl: "https://github.com/dol/luajit-decompiler",
  discoverCatalog: (context, dependencies) => createGithubCommitDiscovery({ owner: "dol", repo: "luajit-decompiler", dependencies })(context)
});
