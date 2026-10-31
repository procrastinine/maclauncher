// LJD and nxnative publish no releases; each recent commit is a source version
// downloaded from its commit-addressed archive.
const { createHash } = require("node:crypto");
const sha = text => createHash("sha1").update(text).digest("hex");
function commits(repository, names) {
  return names.map((name, index) => ({ sha: sha(repository + name), html_url: `https://github.com/${repository}/commit/${sha(repository + name)}`,
    commit: { message: `${name}\n\nDetails`, committer: { name: "maintainer", date: `2026-0${9 - index}-01T12:00:00Z` }, author: { name: "maintainer" } },
    parents: [] }));
}
function commitFixture(manager, repository) {
  const url = `https://api.github.com/repos/${repository}/commits`, current = commits(repository, ["Fix decoding", "Add tests"]);
  const route = list => ({ [url]: list }), version = name => "git-" + sha(repository + name);
  return { managers: [manager], current: route(current), savedDefault: false, scenarios: {
    newVersion: { routes: route([...commits(repository, ["New upstream work"]), ...current]), version: version("New upstream work"), usable: true },
    // A history rewrite drops an older commit from the recent list.
    deletedRelease: { routes: route(current.slice(0, 1)), version: version("Fix decoding"), usable: true, deleted: version("Add tests") }
  } };
}
module.exports = { ...commitFixture("ljd", "dol/luajit-decompiler"), commitFixture };
