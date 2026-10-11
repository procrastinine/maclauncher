/* MacLauncher bounded Ogg/Vorbis PCM decoder. MIT license. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <vorbis/vorbisfile.h>

#define INPUT_LIMIT (64u * 1024u * 1024u)
#define OUTPUT_LIMIT (256u * 1024u * 1024u)
#define DECODER_VERSION "1.0.0-ml1"
typedef struct { uint8_t *bytes; size_t length, at; } Input;

static size_t read_input(void *out, size_t size, size_t count, void *context) {
  Input *input = context;
  if (!size || count > SIZE_MAX / size) return 0;
  size_t elements = (input->length - input->at) / size;
  if (elements > count) elements = count;
  memcpy(out, input->bytes + input->at, elements * size); input->at += elements * size; return elements;
}
static int seek_input(void *context, ogg_int64_t offset, int origin) {
  Input *input = context;
  int64_t base = origin == SEEK_SET ? 0 : origin == SEEK_CUR ? (int64_t)input->at : origin == SEEK_END ? (int64_t)input->length : -1;
  if (base < 0 || offset > INT64_MAX - base || offset < -base) return -1;
  int64_t target = base + offset; if (target < 0 || (uint64_t)target > input->length) return -1; input->at = (size_t)target; return 0;
}
static long tell_input(void *context) { return (long)((Input *)context)->at; }
static int close_input(void *context) { (void)context; return 0; }
static void word(uint8_t *at, uint32_t value) { for (unsigned i = 0; i < 4; i++) at[i] = (uint8_t)(value >> (8 * i)); }
static int output(const void *bytes, size_t length) {
  const uint8_t *at = bytes;
  while (length) { ssize_t count = write(STDOUT_FILENO, at, length); if (count < 0 && errno == EINTR) continue; if (count <= 0) return 0; at += count; length -= (size_t)count; }
  return 1;
}
static int fail(const char *message) { fprintf(stderr, "%s\n", message); return 1; }

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    printf("{\"version\":\"%s\",\"protocolVersion\":1,\"libogg\":\"1.3.6\",\"libvorbis\":\"1.3.7\"}\n", DECODER_VERSION); return 0;
  }
  if (argc != 2 || strcmp(argv[1], "--decode") != 0) return fail("Use --decode for bounded Ogg/Vorbis input.");
  Input input = {0}; size_t capacity = 65536;
  input.bytes = malloc(capacity); if (!input.bytes) return fail("Audio input allocation failed.");
  for (;;) {
    if (input.length == capacity) {
      if (capacity >= INPUT_LIMIT) { uint8_t tail; ssize_t count; do { count = read(STDIN_FILENO, &tail, 1); } while (count < 0 && errno == EINTR);
        if (count != 0) { free(input.bytes); return fail("Audio input exceeds its byte limit."); } break; }
      capacity *= 2; uint8_t *grown = realloc(input.bytes, capacity); if (!grown) { free(input.bytes); return fail("Audio input allocation failed."); } input.bytes = grown;
    }
    ssize_t count = read(STDIN_FILENO, input.bytes + input.length, capacity - input.length);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { free(input.bytes); return fail("Audio input could not be read."); } if (!count) break; input.length += (size_t)count;
  }
  if (input.length < 27 || memcmp(input.bytes, "OggS", 4) != 0) { free(input.bytes); return fail("A complete Ogg/Vorbis stream is required."); }
  OggVorbis_File file; memset(&file, 0, sizeof(file));
  ov_callbacks callbacks = { read_input, seek_input, close_input, tell_input };
  if (ov_open_callbacks(&input, &file, NULL, 0, callbacks) != 0) { free(input.bytes); return fail("Ogg/Vorbis headers are invalid or unsupported."); }
  int result = 1; vorbis_info *info = ov_info(&file, -1); ogg_int64_t frames = ov_pcm_total(&file, -1);
  if (!info || ov_streams(&file) != 1 || !ov_seekable(&file) || info->channels < 1 || info->channels > 2 || info->rate < 8000 || info->rate > 192000 ||
      frames <= 0 || frames > (ogg_int64_t)info->rate * 600 || (uint64_t)frames > OUTPUT_LIMIT / ((unsigned)info->channels * 2)) {
    fail("Ogg/Vorbis stream count, channels, sample rate or duration exceeds its limit."); goto finished;
  }
  uint64_t expected = (uint64_t)frames * (unsigned)info->channels * 2, written = 0;
  uint8_t header[32] = { 'M', 'L', 'P', 'C' }; word(header + 4, 1); word(header + 8, (uint32_t)info->channels); word(header + 12, (uint32_t)info->rate);
  word(header + 16, (uint32_t)frames); word(header + 20, (uint32_t)((uint64_t)frames >> 32)); word(header + 24, (uint32_t)expected);
  if (!output(header, sizeof(header))) goto finished;
  for (;;) {
    char pcm[16384]; int stream = -1; long count = ov_read(&file, pcm, sizeof(pcm), 0, 2, 1, &stream);
    if (count < 0) { fail("Ogg/Vorbis audio is corrupt or contains a decoding hole."); goto finished; }
    if (!count) break;
    if (stream != 0 || (size_t)count % ((unsigned)info->channels * 2) || written + (uint64_t)count > expected || !output(pcm, (size_t)count)) goto finished;
    written += (uint64_t)count;
  }
  if (written != expected) { fail("Ogg/Vorbis decoded length disagrees with its index."); goto finished; }
  result = 0;
finished:
  ov_clear(&file); free(input.bytes); return result;
}
