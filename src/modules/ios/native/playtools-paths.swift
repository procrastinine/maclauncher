import Foundation

// The published PlayTools framework constructs this URL directly instead of
// consulting HOME. Keep its settings inside the owning application's sandbox.
// Use the same stable Swift calling convention as Foundation's imported URL
// initializer; dyld interposition forwards calls from this image to the original.
private let playCoverRoot = "/Users/\(NSUserName())/Library/Containers/io.playcover.PlayCover"
private let playCoverPrefix = playCoverRoot + "/"
private let privateRoot: String? = {
    guard let value = getenv("MACLAUNCHER_PLAYTOOLS_ROOT") else { return nil }
    let path = String(cString: value)
    guard path.hasPrefix("/"), path != "/", path.utf8.count <= 4096,
          !path.split(separator: "/").contains("..") else { return nil }
    return path.hasSuffix("/") ? String(path.dropLast()) : path
}()

extension URL {
@_silgen_name("ml_playtools_file_url")
public static func playToolsFileURL(_ path: __shared String) -> URL {
    guard let root = privateRoot,
          path == playCoverRoot || path.hasPrefix(playCoverPrefix) else {
        return URL(fileURLWithPath: path)
    }
    let suffix = path.dropFirst(playCoverRoot.count)
    guard !suffix.split(separator: "/").contains("..") else { return URL(fileURLWithPath: path) }
    return URL(fileURLWithPath: root + suffix)
}
}
