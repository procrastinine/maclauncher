const path = require("node:path");
const { createPinnedNativeManager } = require("../../runtime/pinned-native-manager");
const { createBundledNativeRuntime } = require("../../runtime/bundled-native");
const Github = require("../../runtime/github-releases");
const Build = require("./innoextract-build");
const TAGS = [
  ["1.9", "81fd9b95b76ee5115ce116bfdbc3bc6b887b809d"], ["1.8", "1c7fe5d9b488a0b8fecefc139745ce978366b103"],
  ["1.7", "d3a5edb1d8bf6df35c6046b5477ecb6331fdba29"], ["1.6", "08b22808d4f4c3ee1ee0ebda8c8819a76b64e903"],
  ["1.5", "18863e2c30fa549342493ee7b3b30e10dce08ceb"], ["1.4", "f335bc4b1e8fb84751692caabcdd82794d1659e2"],
  ["1.3", "820ddfe0176a44865555bbaf7a4ec9321e63a8d9"], ["1.2", "035b3b295544db9dd3b5052447c600b830a5d7b4"],
  ["1.1", "792ee6d55dbf36570b19c06c480a82cf7b6b437a"], ["1.0", "a51e5719294b431e8f10cb55543cc8d24a11e12b"]
];

const historical = (version, revision, tag) => ({ version, upstreamRevision: revision, upstreamTag: tag,
  sourceUrl: `https://github.com/dscharrer/innoextract/tree/${encodeURIComponent(tag)}`, localBuild: false,
  installReason: "Upstream source release. The included Mac installer reader is available without setup." });
const manager = createPinnedNativeManager({ id: "innoextract", label: "Installer reader", recommendedVersion: Build.VERSION,
  bundledExecution: "direct", sourceUrl: "https://github.com/dscharrer/innoextract/releases",
  resolveExecutable: root => path.join(root, "bin/innoextract"),
  bundledRuntime: createBundledNativeRuntime({ managerId: "innoextract" }),
  catalog: [{ version: Build.VERSION, versionLabel: "1.10 · Mac v1", upstreamRevision: Build.REVISION, sourceKind: "commit",
    hostArchitectures: ["arm64"],
    sourceUrl: `https://github.com/dscharrer/innoextract/commit/${Build.REVISION}`, localBuild: false,
    installReason: "The included installer reader runs directly; no installation is required." },
    ...TAGS.map(([version, revision]) => historical(version, revision, version))],
  discoverCatalog: async ({ signal }) => (await Github.fetchGithubTags({ owner: "dscharrer", repo: "innoextract", signal }))
    .filter(tag => /^\d+\.\d+(?:\.\d+)?$/.test(tag.name || ""))
    .map(tag => historical(tag.name, tag.commit.sha, tag.name)) });
manager.ui = { groupId: "tools", tabLabel: "Tools", sectionLabel: "Installers", order: 100, memberOrder: 100, management: "built-in" };
manager.distributionRequired = true;
manager.distributionVersions = [Build.VERSION];
manager.distributionArchitectures = { arm64: ["arm64"], x64: [] };
module.exports = manager;
