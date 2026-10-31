// unluac publishes dated JARs to SourceForge; the folder RSS feed lists them newest first.
const FEED = "https://sourceforge.net/projects/unluac/rss?path=/Unstable";
const item = (file, bytes = 98765) => `<item><title><![CDATA[/${file}]]></title><link>https://sourceforge.net/projects/unluac/files/${file}/download</link>
  <guid>https://sourceforge.net/projects/unluac/files/${file}/download</guid><pubDate>Sun, 24 Dec 2023 00:00:00 UT</pubDate>
  <media:content url="https://sourceforge.net/projects/unluac/files/${file}/download" type="application/java-archive" filesize="${bytes}" fileSize="${bytes}">
  <media:hash algo="md5">${"a".repeat(32)}</media:hash></media:content></item>`;
const feed = files => ({ [FEED]: `<?xml version="1.0" encoding="utf-8"?><rss xmlns:media="http://video.search.yahoo.com/mrss/" version="2.0"><channel>
  <title>unluac</title>${files.map(file => item(file)).join("")}</channel></rss>` });
const current = ["Unstable/unluac_2023_12_24.jar", "Unstable/unluac_2023_10_07.jar"];
module.exports = { managers: ["unluac"], current: feed(current), scenarios: {
  newVersion: { routes: feed(["Unstable/unluac_2024_05_01.jar", ...current]), version: "2024.05.01", usable: true },
  // A version-named JAR in another folder.
  renamedAsset: { routes: feed(["Stable/unluac-1.3.0.jar", ...current]), version: "1.3.0", usable: true },
  // An item that names no JAR leaves the others listed.
  unreadableItem: { routes: feed(["Unstable/README.txt", ...current]), version: "2023.12.24", usable: true },
  deletedRelease: { routes: feed(current.slice(0, 1)), version: "2023.12.24", usable: true, deleted: "2023.10.07" }
} };
