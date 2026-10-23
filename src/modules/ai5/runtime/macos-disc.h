#ifndef MACLAUNCHER_AI5_DISC_H
#define MACLAUNCHER_AI5_DISC_H

#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <errno.h>
#include <sys/stat.h>

struct maclauncher_ai5_disc_stream {
	FILE *image;
	uint64_t start, size, position;
	uint32_t stride, data_offset;
};

static uint64_t maclauncher_ai5_le(const uint8_t *bytes, unsigned length)
{
	uint64_t value = 0;
	for (unsigned i = 0; i < length; i++) value |= (uint64_t)bytes[i] << (i * 8);
	return value;
}

static int maclauncher_ai5_disc_read(void *cookie, char *output, int requested)
{
	struct maclauncher_ai5_disc_stream *stream = cookie;
	if (requested < 0) { errno = EINVAL; return -1; }
	uint64_t remaining = stream->size - stream->position;
	unsigned length = remaining < (unsigned)requested ? remaining : (unsigned)requested;
	unsigned copied = 0;
	while (copied < length) {
		uint64_t logical = stream->start + stream->position;
		unsigned within = logical % 2048;
		unsigned count = length - copied < 2048 - within ? length - copied : 2048 - within;
		off_t physical = (logical / 2048) * stream->stride + stream->data_offset + within;
		if (fseeko(stream->image, physical, SEEK_SET)) return copied ? copied : -1;
		size_t read = fread(output + copied, 1, count, stream->image);
		copied += read;
		stream->position += read;
		if (read != count) { if (ferror(stream->image) && !copied) return -1; break; }
	}
	return copied;
}

static fpos_t maclauncher_ai5_disc_seek(void *cookie, fpos_t offset, int whence)
{
	struct maclauncher_ai5_disc_stream *stream = cookie;
	int64_t base;
	switch (whence) {
	case SEEK_SET: base = 0; break;
	case SEEK_CUR: base = stream->position; break;
	case SEEK_END: base = stream->size; break;
	default: errno = EINVAL; return -1;
	}
	if (offset < -base || offset > (int64_t)stream->size - base) { errno = EINVAL; return -1; }
	stream->position = base + offset;
	return stream->position;
}

static int maclauncher_ai5_disc_close(void *cookie)
{
	struct maclauncher_ai5_disc_stream *stream = cookie;
	int result = fclose(stream->image);
	free(stream);
	return result;
}

/* Only launcher-owned, freshly validated descriptors select a virtual stream.
 * Ordinary original archives still use the upstream read-only file path. */
static FILE *maclauncher_ai5_archive_open(const char *filename, bool *virtual_file)
{
	*virtual_file = false;
	const char *root = getenv("MACLAUNCHER_AI5_RESOURCE_DIR");
	if (!root || root[0] != '/' || strncmp(filename, root, strlen(root)) || filename[strlen(root)] != '/')
		return file_open_utf8(filename, "rb");
	FILE *descriptor = file_open_utf8(filename, "rb");
	if (!descriptor) return NULL;
	uint8_t header[40];
	char image_path[PATH_MAX];
	struct maclauncher_ai5_disc_stream *stream = NULL;
	if (fread(header, sizeof(header), 1, descriptor) != 1 || memcmp(header, "MLAI5CD1", 8)) goto invalid;
	uint32_t stride = maclauncher_ai5_le(header + 8, 4), data_offset = maclauncher_ai5_le(header + 12, 4);
	uint64_t start = maclauncher_ai5_le(header + 16, 8), size = maclauncher_ai5_le(header + 24, 8);
	uint32_t path_length = maclauncher_ai5_le(header + 32, 4);
	if (!path_length || path_length >= sizeof(image_path) || start % 2048 || start > INT64_MAX / 2352 ||
			!size || size > UINT32_MAX || (stride != 2048 && stride != 2352) ||
			data_offset != (stride == 2352 ? 16 : 0) || maclauncher_ai5_le(header + 36, 4)) goto invalid;
	if (fread(image_path, path_length, 1, descriptor) != 1 || fgetc(descriptor) != EOF || memchr(image_path, 0, path_length)) goto invalid;
	image_path[path_length] = 0;
	if (image_path[0] != '/') goto invalid;
	FILE *image = file_open_utf8(image_path, "rb");
	if (!image) goto invalid;
	struct stat stat;
	uint64_t last = start + size - 1;
	if (fstat(fileno(image), &stat) || !S_ISREG(stat.st_mode) ||
			(last / 2048) * stride + data_offset + last % 2048 >= (uint64_t)stat.st_size) {
		fclose(image); goto invalid;
	}
	stream = calloc(1, sizeof(*stream));
	if (!stream) { fclose(image); goto invalid; }
	stream->image = image; stream->start = start; stream->size = size;
	stream->stride = stride; stream->data_offset = data_offset;
	FILE *result = funopen(stream, maclauncher_ai5_disc_read, NULL, maclauncher_ai5_disc_seek, maclauncher_ai5_disc_close);
	if (!result) { maclauncher_ai5_disc_close(stream); goto invalid; }
	fclose(descriptor);
	*virtual_file = true;
	return result;
invalid:
	fclose(descriptor);
	errno = EINVAL;
	return NULL;
}

#endif
