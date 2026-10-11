/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef ML_BGI_STATE_FILES_H
#define ML_BGI_STATE_FILES_H
#include <stddef.h>
#include <stdint.h>
typedef struct { int sourceFd, stateFd; } MLBGI_Files;
int MLBGI_ConfigureFiles(MLBGI_Files *files, const char *stateDirectory);
void MLBGI_CloseFiles(MLBGI_Files *files);
const char *MLBGI_VirtualDirectory(void);
int MLBGI_PathStatus(MLBGI_Files *files, const char *name, int directoryOnly);
int MLBGI_CreateDirectory(MLBGI_Files *files, const char *name);
int MLBGI_DeleteFile(MLBGI_Files *files, const char *name);
/* 0 missing, 1 present, -1 malformed or inaccessible. */
int MLBGI_GlobalDatabaseStatus(MLBGI_Files *files);
/* Finite nonrecursive Windows-style filename search. A null output queries
   required bytes; successful output is a sequence of terminated CP932 names. */
int MLBGI_FindFiles(MLBGI_Files *files, const char *pattern, uint32_t limit,
                   uint8_t *output, size_t capacity, size_t *written);
#endif
