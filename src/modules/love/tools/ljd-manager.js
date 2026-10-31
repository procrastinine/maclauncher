const { createManagedPythonTool } = require("../../shared/runtime/managed-python-tool");
const Upstream = require("../../shared/runtime/upstream");

// LJD publishes no releases; each recent commit is a source version.
module.exports = createManagedPythonTool({ id: "ljd", label: "LJD", scriptName: "main.py", order: 270,
  requiredFiles: ["main.py", "ljd/__init__.py", "LICENSE", "LICENSE-upstream"],
  sourceUrl: "https://github.com/dol/luajit-decompiler",
  upstream: Upstream.githubCommits({ repository: "dol/luajit-decompiler", recognize: () => ({ archive: true }) })
});
