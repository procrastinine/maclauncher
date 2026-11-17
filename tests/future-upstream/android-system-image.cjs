// Google's Android SDK repository lists system images per tag in one XML file
// each: a remotePackage per API level, tag and ABI with its revision and one
// archive (size, SHA-1 and a URL relative to the file).
const crypto = require("node:crypto");
const BASE = "https://dl.google.com/android/repository/sys-img/";
const REPOSITORIES = { android: "Default Android System Image", google_apis: "Google APIs", google_apis_playstore: "Google Play" };
const sha1 = text => crypto.createHash("sha1").update(text).digest("hex");
// One image: [api, abi, major, extra fields for a future schema].
function remotePackage(tag, [api, abi, major, { rebuilt = "", host, element = "" } = {}]) {
  const file = `${abi}-${api}_r${String(major).padStart(2, "0")}.zip`;
  return `<remotePackage path="system-images;android-${api};${tag};${abi}">
  <type-details xsi:type="sys-img:sysImgDetailsType"><api-level>${api}</api-level><tag><id>${tag}</id><display>${REPOSITORIES[tag]}</display></tag><vendor><id>google</id><display>Google Inc.</display></vendor><abi>${abi}</abi>${element}</type-details>
  <revision><major>${major}</major></revision>
  <display-name>${REPOSITORIES[tag]} ${abi === "arm64-v8a" ? "ARM 64 v8a" : "Intel x86_64 Atom"} System Image</display-name>
  <uses-license ref="android-sdk-license"/>
  <dependencies><dependency path="emulator"><min-revision><major>28</major><minor>1</minor><micro>9</micro></min-revision></dependency></dependencies>
  <channelRef ref="channel-0"/>
  <archives><archive>${host ? `<host-os>${host}</host-os>` : ""}<complete><size>${1600000000 + api * 1000 + major}</size><checksum type="sha1">${sha1(tag + file + rebuilt)}</checksum><url>${file}</url></complete></archive></archives>
</remotePackage>`;
}
function document(tag, images) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<sys-img:sdk-sys-img xmlns:common="http://schemas.android.com/repository/android/common/02" xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<license id="android-sdk-license" type="text">Terms and Conditions</license>
<channel id="channel-0">stable</channel>
${images.map(image => remotePackage(tag, image)).join("\n")}
</sys-img:sdk-sys-img>
`;
}
function routes(images) {
  return Object.fromEntries(Object.keys(REPOSITORIES).map(tag => [`${BASE}${tag}/sys-img2-3.xml`, document(tag, images[tag] || [])]));
}
const version = (tag, api, abi, major) => `system-images-android-${api}-${tag}-${abi}-r${major}.0.0`;
const current = { android: [[35, "arm64-v8a", 2], [34, "arm64-v8a", 2], [34, "x86_64", 2]],
  google_apis: [[35, "arm64-v8a", 9], [34, "arm64-v8a", 14]], google_apis_playstore: [[34, "arm64-v8a", 12]] };
module.exports = { managers: ["android-system-image"], current: routes(current),
  scenarios: {
    newVersion: { routes: routes({ ...current, google_apis: [[36, "arm64-v8a", 1], ...current.google_apis] }),
      version: version("google_apis", 36, "arm64-v8a", 1), usable: true },
    // A new revision of an image keeps the earlier revision's name for its installations.
    newRevision: { routes: routes({ ...current, google_apis: [[35, "arm64-v8a", 10], [34, "arm64-v8a", 14]] }),
      version: version("google_apis", 35, "arm64-v8a", 10), usable: true, deleted: version("google_apis", 35, "arm64-v8a", 9) },
    // A new ABI, an archive for another host and an unknown schema element.
    addedAsset: { routes: routes({ ...current, android: [[36, "riscv64", 1, { element: "<page-size>16384</page-size>" }],
      [36, "arm64-v8a", 1, { element: "<page-size>16384</page-size>" }], [36, "x86_64", 1, { host: "windows" }], ...current.android] }),
      version: version("android", 36, "arm64-v8a", 1), usable: true },
    replacedFile: { routes: routes({ ...current, android: current.android.map(([api, abi, major]) => [api, abi, major, { rebuilt: "rebuilt" }]) }),
      version: version("android", 35, "arm64-v8a", 2), usable: true },
    deletedRelease: { routes: routes({ ...current, android: current.android.slice(0, 2) }),
      version: version("android", 35, "arm64-v8a", 2), usable: true, deleted: version("android", 34, "x86_64", 2) }
  } };
