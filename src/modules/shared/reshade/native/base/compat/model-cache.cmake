# Retain useful setup caches while bounding process-wide model history.
file(READ "${MAKO_EXTRACTION}/dll_reader.cpp" BOUNDED_READER)
set(ARCHIVE_INSERT [=[    cache.insert_or_assign(
        identity.normalizedPath,
        CachedArchive{.identity = identity, .archive = parsed}
    );]=])
string(FIND "${BOUNDED_READER}" "${ARCHIVE_INSERT}" ARCHIVE_INSERT_POS)
if(ARCHIVE_INSERT_POS LESS 0)
 message(FATAL_ERROR "MAKO archive cache changed; review the bounded cache overlay")
endif()
set(ARCHIVE_BOUNDED [=[    constexpr size_t maximumCacheBytes = 64U * 1024U * 1024U;
    const auto archiveBytes = [](const auto& archive) {
        size_t bytes = 0;
        for (const auto& resource : archive.resources) bytes += resource.second.size();
        return bytes;
    };
    const size_t bytes = archiveBytes(*parsed);
    cache.erase(identity.normalizedPath);
    if (bytes <= maximumCacheBytes) {
        size_t total = 0;
        for (const auto& item : cache) total += archiveBytes(*item.second.archive);
        while (!cache.empty() && (cache.size() >= 4 || total + bytes > maximumCacheBytes)) {
            total -= archiveBytes(*cache.begin()->second.archive);
            cache.erase(cache.begin());
        }
        cache.insert_or_assign(identity.normalizedPath, CachedArchive{.identity = identity, .archive = parsed});
    }]=])
string(REPLACE "${ARCHIVE_INSERT}" "${ARCHIVE_BOUNDED}" BOUNDED_READER "${BOUNDED_READER}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/dll_reader_bounded.cpp" "${BOUNDED_READER}")
