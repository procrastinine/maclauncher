# Pinned MAKO LS1 extraction uses only the adjacent owned translator.
set(LS1_VENDOR "${CMAKE_CURRENT_SOURCE_DIR}/${MAKO_EXTRACTION}/ls1_shader_set.cpp")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${LS1_VENDOR}")
file(READ "${LS1_VENDOR}" LS1_SOURCE)
set(LS1_LOADER_START [=[        std::vector<std::filesystem::path> candidates;
        if (const char* configured = std::getenv("MAKO_VKD3D_SHADER_PATH");]=])
string(FIND "${LS1_SOURCE}" "${LS1_LOADER_START}" LS1_START)
string(FIND "${LS1_SOURCE}" "        std::string lastError;" LS1_END)
if(LS1_START LESS 0 OR LS1_END LESS LS1_START)
 message(FATAL_ERROR "MAKO translator loading changed; review the adjacent-library overlay")
endif()
string(SUBSTRING "${LS1_SOURCE}" 0 ${LS1_START} LS1_PREFIX)
string(SUBSTRING "${LS1_SOURCE}" ${LS1_END} -1 LS1_SUFFIX)
set(LS1_OWNED_LOADER [=[        (void)shaderDllPath;
        Dl_info module{};
        if (!dladdr(reinterpret_cast<const void*>(&loadTranslator), &module) || !module.dli_fname)
            throw ls::error("Cannot locate the LS1 shader translator");
        const std::vector<std::string> attempts{(std::filesystem::path(module.dli_fname).parent_path() / "libvkd3d-shader.dylib").string()};

]=])
set(LS1_SOURCE "${LS1_PREFIX}${LS1_OWNED_LOADER}${LS1_SUFFIX}")
string(REPLACE "unable to load libvkd3d-shader.so.1 for LS1 translation" "Cannot load the LS1 shader translator" LS1_SOURCE "${LS1_SOURCE}")
set(LS1_CACHE_INSERT "    cache.emplace(key, result);")
string(FIND "${LS1_SOURCE}" "${LS1_CACHE_INSERT}" LS1_CACHE_POS)
if(LS1_CACHE_POS LESS 0)
 message(FATAL_ERROR "MAKO LS1 cache changed; review the bounded translation overlay")
endif()
set(LS1_CACHE_BOUNDED [=[    constexpr size_t maximumCacheBytes = 32U * 1024U * 1024U;
    const auto shaderBytes = [](const auto& value) { return value.stage1.size() + value.stage2.size() + value.stage3.size() + value.reconstruction.size(); };
    const size_t bytes = shaderBytes(result);
    if (bytes <= maximumCacheBytes) {
        size_t total = 0;
        for (const auto& item : cache) total += shaderBytes(item.second);
        while (!cache.empty() && (cache.size() >= 10 || total + bytes > maximumCacheBytes)) {
            total -= shaderBytes(cache.begin()->second);
            cache.erase(cache.begin());
        }
        cache.emplace(key, result);
    }]=])
string(REPLACE "${LS1_CACHE_INSERT}" "${LS1_CACHE_BOUNDED}" LS1_SOURCE "${LS1_SOURCE}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/ls1_shader_set_portable.cpp" "${LS1_SOURCE}")
add_library(mako-ls1 STATIC "${CMAKE_CURRENT_BINARY_DIR}/ls1_shader_set_portable.cpp" ${MAKO_EXTRACTION}/ls1_spirv_patch.cpp)
set_target_properties(mako-ls1 PROPERTIES CXX_STANDARD 20)
target_include_directories(mako-ls1 PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/mako-cpu ${MAKO_EXTRACTION} ${MAKO_SOURCE}/mako-backend/include ${MAKO_SOURCE}/mako-common/include)
target_link_libraries(mako-ls1 PUBLIC lossless-reader)
set_target_properties(vkd3d-shader PROPERTIES LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
