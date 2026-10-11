/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only */
#ifndef MACLAUNCHER_BGI_ARCHIVE_READER_H
#define MACLAUNCHER_BGI_ARCHIVE_READER_H
#include <stddef.h>
#include <stdint.h>

/* Read original ARC20/PackFile members, or a regular file in an unpacked
 * archive directory. Returned bytes belong to the caller. No files are written. */
uint8_t *MLBGI_ReadFile(const char *archive, const char *filename, size_t *size);
const char *MLBGI_ArchiveError(void);
void MLBGI_FreeArchiveCache(void);
int MLBGI_DecodeDsc(const uint8_t *input, size_t size, uint8_t **output, size_t *outputSize);
#endif
