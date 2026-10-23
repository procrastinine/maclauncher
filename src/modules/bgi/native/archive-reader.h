/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef MACLAUNCHER_BGI_ARCHIVE_READER_H
#define MACLAUNCHER_BGI_ARCHIVE_READER_H
#include <stddef.h>
#include <stdint.h>

/* Read original ARC20/PackFile members, or a regular file in an unpacked
 * archive directory. Returned bytes belong to the caller. No files are written. */
uint8_t *MLBGI_ReadFile(const char *archive, const char *filename, size_t *size);
/* Registered resource directories are relative to the original game. The
 * newest directory has priority; ARC payloads remain in their source files. */
int MLBGI_ValidSearchPath(const char *path);
int MLBGI_ValidResourceName(const char *name);
int MLBGI_ResourceNameEqual(const char *first, const char *second);
uint8_t *MLBGI_ReadResource(const char *archive, const char *filename,
    const char *const *paths, size_t pathCount, int directoriesEnabled, size_t *size);
/* An explicitly registered archive list preserves authored first-match
   priority and reads original payloads in place. */
uint8_t *MLBGI_ReadArchiveList(const char *const *archives, size_t count, const char *filename,
    const char *const *paths, size_t pathCount, int directoriesEnabled, size_t *size);
/* Existence uses validated indexes and file identities, without reading or
   decompressing payloads. Returns 1 present, 0 absent, -1 invalid source. */
int MLBGI_ResourceStatus(const char *archive, const char *filename,
    const char *const *paths, size_t pathCount, int directoriesEnabled);
int MLBGI_ArchiveListStatus(const char *const *archives, size_t count, const char *filename,
    const char *const *paths, size_t pathCount, int directoriesEnabled);
const char *MLBGI_ArchiveError(void);
void MLBGI_FreeArchiveCache(void);
int MLBGI_DecodeDsc(const uint8_t *input, size_t size, uint8_t **output, size_t *outputSize);
#endif
