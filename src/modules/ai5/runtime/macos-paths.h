#ifndef MACLAUNCHER_AI5_PATHS_H
#define MACLAUNCHER_AI5_PATHS_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

/* The module supplies absolute private roots. Never fall back to writing
 * beside the imported game when a required root is missing. */
static char *maclauncher_ai5_path(const char *variable, const char *name)
{
	const char *root = getenv(variable);
	if (!root || root[0] != '/' || !name || !*name || strchr(name, '/') ||
			strchr(name, '\\') || !strcmp(name, ".") || !strcmp(name, ".."))
		ERROR("Invalid private AI5 output path");
	size_t length = strlen(root) + strlen(name) + 2;
	if (length > PATH_MAX)
		ERROR("Private AI5 output path is too long");
	char *result = malloc(length);
	if (!result)
		ERROR("Cannot allocate private AI5 output path");
	snprintf(result, length, "%s/%s", root, name);
	return result;
}

static FILE *maclauncher_ai5_graphics_output(const char *name)
{
	/* Upstream F10 uses Screenshots/<date>.png. Keep its basename in the
	 * supplied private screenshot directory, including debugger exports. */
	const char *base = strrchr(name, '/');
	char *filename = maclauncher_ai5_path("MACLAUNCHER_AI5_OUTPUT_DIR", base ? base + 1 : name);
	FILE *result = file_open_utf8(filename, "wb");
	free(filename);
	return result;
}

#endif
