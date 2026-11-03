// Copyright (c) MacLauncher contributors. MIT license.
// A graphics package stores identical provider payload files once. A
// payload-aliases.json in a provider's payload directory maps each removed path
// below it to the stored copy, relative to that directory, so a sandboxed
// process that may read the provider directory can read both. The nearest
// index above a path applies; src/modules/shared/runtime/payload-files.js
// follows the same rule. A path that exists is always the stored file, so only
// an absent path consults an index.
#pragma once
#if !defined(__cplusplus) || !defined(__OBJC__)
#error "payload-files.hpp is an Objective-C++ header"
#endif
#import <Foundation/Foundation.h>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <vector>
namespace maclauncher {
namespace payload_files {
using Aliases = std::map<std::string, std::string>;
inline bool exists(const std::string &path) {
  struct stat info {};
  return stat(path.c_str(), &info) == 0;
}
inline std::vector<std::string> parts(const std::string &value) {
  std::vector<std::string> result;
  for (size_t start = 0;;) {
    const auto end = value.find('/', start);
    result.push_back(value.substr(start, end == std::string::npos ? std::string::npos : end - start));
    if (end == std::string::npos) return result;
    start = end + 1;
  }
}
// A package-relative path without empty, "." or ".." parts.
inline bool safe(const std::string &relative) {
  if (relative.empty()) return false;
  for (const auto &part : parts(relative))
    if (part.empty() || part == "." || part == "..") return false;
  return true;
}
// Removes empty and "." parts and applies ".."; empty when it leaves the root.
inline std::string normalized(const std::string &relative) {
  std::vector<std::string> kept;
  for (const auto &part : parts(relative)) {
    if (part.empty() || part == ".") continue;
    if (part != "..") kept.push_back(part);
    else if (kept.empty()) return {};
    else kept.pop_back();
  }
  std::string result;
  for (const auto &part : kept) result += (result.empty() ? "" : "/") + part;
  return result;
}
// A missing or invalid index has no aliases.
inline std::shared_ptr<const Aliases> read(const std::string &root) {
  auto result = std::make_shared<Aliases>();
  @autoreleasepool {
    NSData *data = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:(root + "/payload-aliases.json").c_str()]];
    id index = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSDictionary *files = [index isKindOfClass:NSDictionary.class] && [index[@"schema"] isEqual:@1] ? index[@"files"] : nil;
    if (![files isKindOfClass:NSDictionary.class]) return result;
    for (id key in files) {
      id target = files[key];
      if (![key isKindOfClass:NSString.class] || ![target isKindOfClass:NSString.class]) continue;
      const std::string from = [key UTF8String], to = [target UTF8String];
      if (safe(from) && safe(to)) result->emplace(from, to);
    }
  }
  return result;
}
// Each package root's index is read once per process.
inline std::shared_ptr<const Aliases> aliases(const std::string &root) {
  static std::mutex lock;
  static std::map<std::string, std::shared_ptr<const Aliases>> cache;
  std::lock_guard guard(lock);
  auto &slot = cache[root];
  if (!slot) slot = read(root);
  return slot;
}
} // namespace payload_files
// The stored file for a logical payload path. An existing path, a path whose
// package has no alias index and a path the index does not name are returned
// unchanged.
inline std::string payloadFile(const std::string &logical) {
  using namespace payload_files;
  if (logical.empty() || exists(logical)) return logical;
  std::string root = logical;
  for (int depth = 0; depth < 32; ++depth) {
    const auto slash = root.find_last_of('/');
    if (slash == std::string::npos || slash == 0) return logical;
    root.resize(slash);
    while (root.size() > 1 && root.back() == '/') root.pop_back();
    if (!exists(root + "/payload-aliases.json")) {
      if (exists(root + "/runtime.json")) return logical;
      continue;
    }
    const auto key = normalized(logical.substr(root.size() + 1));
    const auto index = aliases(root);
    const auto found = key.empty() ? index->end() : index->find(key);
    return found == index->end() ? logical : root + "/" + found->second;
  }
  return logical;
}
inline NSString *payloadFile(NSString *logical) {
  if (!logical.length) return logical;
  const auto stored = payloadFile(std::string(logical.UTF8String));
  return [NSString stringWithUTF8String:stored.c_str()];
}
} // namespace maclauncher
