const { githubRoutes, githubRelease, githubScenarios, publisherScenarios } = require("../helpers/future-upstream.cjs");

// DXVK reads DXVK's releases, DXVK-macOS, the historical D8VK and D9VK
// projects and the DXVK folders of Sikarugir Template releases.
const publisher = (name, repository, versions, tag, assets, listed) => {
  const releases = versions.map(version => githubRelease(repository, tag(version), assets(version)));
  return { name, current: githubRoutes(repository, releases), scenarios: githubScenarios(repository, releases), listed };
};
const { current, scenarios } = publisherScenarios([
  publisher("DXVK", "doitsujin/dxvk", ["2.7.1", "2.7"], version => `v${version}`,
    version => [`dxvk-${version}.tar.gz`, `dxvk-native-${version}-steamrt-sniper.tar.gz`], version => `upstream-dxvk-${version}`),
  publisher("DXVK-macOS", "Gcenx/DXVK-macOS", ["1.10.3", "1.10.2"], version => `v${version}`,
    version => [`dxvk-macOS-v${version}.tar.gz`, `dxvk-macOS-async-v${version}.tar.gz`],
    version => [`macos-dxvk-macOS-v${version}`, `async-dxvk-macOS-async-v${version}`]),
  publisher("D8VK", "AlpyneDreams/d8vk", ["1.0", "0.85"], version => `d8vk-v${version}`,
    version => [`d8vk-v${version}.tar.gz`], version => `d8vk-d8vk-v${version}`),
  publisher("D9VK", "misyltoad/d9vk", ["0.40.1", "0.40"], version => version,
    version => [`d9vk-${version}.tar.gz`], version => `d9vk-d9vk-${version}`),
  publisher("Template", "Sikarugir-App/Template", ["1.0.24", "1.0.21"], version => `v${version}`,
    version => [`Template-${version}.tar.xz`], version => ["dxvk3", "dxvk", "d9vk"].map(folder => `template-${folder}-Template-${version}`))
]);

module.exports = { managers: ["translator-dxvk"], current, scenarios };
