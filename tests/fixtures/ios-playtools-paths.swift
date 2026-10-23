import Foundation
let args = CommandLine.arguments
let original = "/Users/\(NSUserName())/Library/Containers/io.playcover.PlayCover"
let root = args[1]
precondition(URL(fileURLWithPath: original).path == root)
for suffix in ["/Keymapping/owned.plist", "/App Settings/日本語.plist"] {
    let url = URL(fileURLWithPath: original + suffix)
    precondition(url.path == root + suffix)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = Data("persisted original Foundation I/O".utf8)
    try data.write(to: url, options: .atomic)
    let loaded = try Data(contentsOf: url)
    precondition(loaded == data)
}
for path in [original + "-other/file", "/private/tmp/unrelated", original + "/../another-container"] {
    precondition(!URL(fileURLWithPath: path).path.hasPrefix(root))
}
print("PlayTools URL scope and real Foundation persistence passed")
