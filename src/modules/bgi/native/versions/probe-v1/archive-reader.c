/* MacLauncher OpenBGI adaptation. SPDX-License-Identifier: GPL-2.0-only
 * ARC layouts and DSC1 decoding follow the read-only OpenBGI unarc sources
 * at e2500e0badd04aab472e4620477747973e5e5544 and archive.js. Unlike the
 * upstream unarc decoder, every read, Huffman node and LZ copy is bounded. */
#include "archive-reader.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MEMBER_LIMIT (32u * 1024u * 1024u)
#define INDEX_LIMIT (8u * 1024u * 1024u)
#define CACHE_LIMIT (16u * 1024u * 1024u)
#define ARCHIVE_LIMIT 128
#define PATH_LIMIT 512

typedef struct { char name[97]; uint64_t offset; uint32_t size; } Member;
typedef struct {
    char path[PATH_LIMIT]; struct stat identity; Member *members; uint32_t count;
    size_t indexBytes;
} Archive;
static Archive archives[ARCHIVE_LIMIT];
static size_t archiveCount, cachedIndexBytes;
static const char *lastError;

static int fail(const char *message) { lastError = message; return 0; }
const char *MLBGI_ArchiveError(void) { return lastError ? lastError : "BGI resource read failed"; }
static uint32_t le32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static int sjisLead(unsigned char c) { return (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc); }
static unsigned char folded(unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }
/* Do not fold or mistake a Shift-JIS trail byte for an ASCII separator. */
static int nameEqual(const char *a, const char *b) {
    size_t i = 0;
    while (a[i] && b[i]) {
        unsigned char c = (unsigned char)a[i], d = (unsigned char)b[i];
        if (sjisLead(c) || sjisLead(d)) {
            if (c != d || !a[i + 1] || a[i + 1] != b[i + 1]) return 0;
            i += 2;
        } else { if (folded(c) != folded(d)) return 0; i++; }
    }
    return a[i] == b[i];
}
static int safeName(const char *name, size_t maximum) {
    size_t length = strnlen(name ? name : "", maximum + 1);
    if (!length || length > maximum || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)name[i];
        if (sjisLead(c)) {
            if (++i >= length || (unsigned char)name[i] < 0x40 || (unsigned char)name[i] == 0x7f || (unsigned char)name[i] > 0xfc) return 0;
        } else if (c < 0x20 || c == '/' || c == '\\' || c == ':') return 0;
    }
    return 1;
}
static int readAt(int fd, void *bytes, size_t length, uint64_t offset) {
    if (offset > INT64_MAX || length > INT64_MAX - offset) return fail("BGI file range overflow");
    size_t readBytes = 0;
    while (readBytes < length) {
        ssize_t n = pread(fd, (uint8_t *)bytes + readBytes, length - readBytes, (off_t)(offset + readBytes));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return fail("Truncated BGI resource");
        readBytes += (size_t)n;
    }
    return 1;
}
static int regularFile(const char *path, struct stat *st) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) { fail("BGI resource must be an accessible regular file"); return -1; }
    if (fstat(fd, st) || !S_ISREG(st->st_mode) || st->st_size < 0) { close(fd); fail("BGI resource must be a regular file"); return -1; }
    return fd;
}
static int sameFile(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
           a->st_mtime == b->st_mtime && a->st_ctime == b->st_ctime
#ifdef __APPLE__
           && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec
#else
           && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec
#endif
           ;
}
void MLBGI_FreeArchiveCache(void) {
    for (size_t i = 0; i < archiveCount; i++) free(archives[i].members);
    memset(archives, 0, sizeof(archives)); archiveCount = cachedIndexBytes = 0;
}
static Archive *indexArchive(const char *path, int fd, const struct stat *st) {
    for (size_t i = 0; i < archiveCount; i++) if (!strcmp(archives[i].path, path)) {
        if (!sameFile(&archives[i].identity, st)) { fail("BGI archive changed during execution"); return NULL; }
        return &archives[i];
    }
    uint8_t header[16];
    if (!readAt(fd, header, sizeof(header), 0)) return NULL;
    size_t stride, nameBytes;
    if (!memcmp(header, "BURIKO ARC20", 12)) { stride = 128; nameBytes = 96; }
    else if (!memcmp(header, "PackFile    ", 12)) { stride = 32; nameBytes = 16; }
    else { fail("Unsupported BGI archive signature"); return NULL; }
    uint32_t count = le32(header + 12);
    size_t indexSize = (size_t)count * stride;
    uint64_t base = 16 + (uint64_t)indexSize;
    if (!count || count > 65536 || indexSize + 16 > INDEX_LIMIT || base > (uint64_t)st->st_size ||
        archiveCount >= ARCHIVE_LIMIT || indexSize > CACHE_LIMIT - cachedIndexBytes) { fail("BGI archive index exceeds its bounds"); return NULL; }
    uint8_t *index = malloc(indexSize); Member *members = calloc(count, sizeof(Member));
    if (!index || !members) { free(index); free(members); fail("BGI archive allocation failed"); return NULL; }
    if (!readAt(fd, index, indexSize, 16)) { free(index); free(members); return NULL; }
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *record = index + i * stride;
        size_t length = strnlen((const char *)record, nameBytes);
        memcpy(members[i].name, record, length); members[i].name[length] = 0;
        if (!safeName(members[i].name, nameBytes)) { fail("Unsafe BGI member filename"); goto invalid; }
        members[i].offset = base + le32(record + nameBytes); members[i].size = le32(record + nameBytes + 4);
        if (members[i].offset > (uint64_t)st->st_size || members[i].size > (uint64_t)st->st_size - members[i].offset) {
            fail("BGI member lies outside its archive"); goto invalid;
        }
    }
    /* Sort by raw byte identity to bound duplicate checking; folded identity
     * needs its own comparator because ASCII case can occur inside SJIS. */
    extern int MLBGI_MemberCompare(const void *, const void *);
    qsort(members, count, sizeof(Member), MLBGI_MemberCompare);
    for (uint32_t i = 1; i < count; i++) if (nameEqual(members[i - 1].name, members[i].name)) {
        fail("Duplicate BGI member filename"); goto invalid;
    }
    Archive *arc = &archives[archiveCount++];
    strcpy(arc->path, path); arc->identity = *st; arc->members = members; arc->count = count; arc->indexBytes = indexSize;
    cachedIndexBytes += indexSize; free(index); return arc;
invalid:
    free(index); free(members); return NULL;
}
int MLBGI_MemberCompare(const void *lhs, const void *rhs) {
    const unsigned char *a = (const unsigned char *)((const Member *)lhs)->name;
    const unsigned char *b = (const unsigned char *)((const Member *)rhs)->name;
    for (size_t i = 0; ; i++) {
        unsigned char c = a[i], d = b[i];
        if (sjisLead(c) || sjisLead(d)) {
            if (c != d) return c < d ? -1 : 1;
            if (a[i + 1] != b[i + 1]) return a[i + 1] < b[i + 1] ? -1 : 1;
            i++;
        } else {
            c = folded(c); d = folded(d);
            if (c != d) return c < d ? -1 : 1;
            if (!c) return 0;
        }
    }
}

typedef struct { int symbol; uint16_t child[2]; } Node;
typedef struct { uint16_t symbol; uint8_t depth; } Leaf;
static int compareLeaf(const void *lhs, const void *rhs) {
    const Leaf *a = lhs, *b = rhs;
    return a->depth != b->depth ? (int)a->depth - b->depth : (int)a->symbol - b->symbol;
}
static int bitRead(const uint8_t *input, size_t size, size_t *position, unsigned count, uint32_t *value) {
    if (*position > size * 8 || count > size * 8 - *position) return fail("Truncated DSC1 bitstream");
    *value = 0;
    while (count--) { *value = (*value << 1) | ((input[*position >> 3] >> (7 - (*position & 7))) & 1); (*position)++; }
    return 1;
}
int MLBGI_DecodeDsc(const uint8_t *input, size_t size, uint8_t **output, size_t *outputSize) {
    *output = NULL; *outputSize = 0;
    if (size < 0x220 || size > MEMBER_LIMIT || memcmp(input, "DSC FORMAT 1.00", 15)) return fail("Incomplete DSC1 compressed header");
    uint32_t length = le32(input + 20), symbols = le32(input + 24), key = le32(input + 16);
    if (length > MEMBER_LIMIT || symbols > length) return fail("DSC1 output exceeds its bounds");
    if (!length && !symbols) { *output = calloc(1, 1); return *output != NULL || fail("DSC1 allocation failed"); }
    Leaf leaves[512]; size_t leafCount = 0;
    for (unsigned i = 0; i < 512; i++) {
        uint32_t low = (key & 0xffff) * 20021u;
        uint32_t high = (key >> 16) * 20021u + key * 346u + (low >> 16);
        key = (high << 16) + (low & 0xffff) + 1u;
        uint8_t depth = input[32 + i] - (uint8_t)high;
        if (depth > 32) return fail("DSC1 Huffman depth exceeds its bounds");
        if (depth) leaves[leafCount++] = (Leaf){ i, depth };
    }
    if (!leafCount || !symbols) return fail("DSC1 Huffman table is empty");
    qsort(leaves, leafCount, sizeof(Leaf), compareLeaf);
    Node nodes[1023]; uint16_t current[512], next[512];
    memset(nodes, 0, sizeof(nodes)); for (unsigned i = 0; i < 1023; i++) nodes[i].symbol = -1;
    current[0] = 0; size_t currentCount = 1, nodeCount = 1, cursor = 0;
    for (unsigned depth = 0; cursor < leafCount; depth++) {
        if (depth > 32 || !currentCount) return fail("Invalid DSC1 Huffman table");
        size_t used = 0, nextCount = 0;
        while (cursor < leafCount && leaves[cursor].depth == depth) {
            if (used >= currentCount) return fail("Oversubscribed DSC1 Huffman table");
            nodes[current[used++]].symbol = leaves[cursor++].symbol;
        }
        for (size_t i = used; i < currentCount; i++) {
            if (nodeCount + 2 > 1023 || nextCount + 2 > 512) return fail("DSC1 Huffman tree exceeds its bounds");
            nodes[current[i]].child[0] = nodeCount; nodes[current[i]].child[1] = nodeCount + 1;
            next[nextCount++] = nodeCount++; next[nextCount++] = nodeCount++;
        }
        memcpy(current, next, nextCount * sizeof(uint16_t)); currentCount = nextCount;
    }
    uint8_t *bytes = malloc(length); if (!bytes) return fail("DSC1 allocation failed");
    size_t bit = 0x220 * 8, written = 0;
    for (uint32_t i = 0; i < symbols; i++) {
        unsigned node = 0, steps = 0; uint32_t value;
        while (nodes[node].symbol < 0) {
            if (++steps > 32 || !bitRead(input, size, &bit, 1, &value)) goto invalid;
            unsigned child = nodes[node].child[value];
            if (!child || child >= nodeCount) { fail("Invalid DSC1 symbol path"); goto invalid; }
            node = child;
        }
        unsigned symbol = nodes[node].symbol;
        if (symbol < 256) {
            if (written >= length) { fail("DSC1 literal exceeds its output size"); goto invalid; }
            bytes[written++] = symbol;
        } else {
            unsigned count = (symbol & 255) + 2;
            if (!bitRead(input, size, &bit, 12, &value)) goto invalid;
            size_t distance = value + 2;
            if (distance > written || count > length - written) { fail("DSC1 match exceeds its output window"); goto invalid; }
            size_t source = written - distance;
            while (count--) bytes[written++] = bytes[source++];
        }
    }
    if (written != length) { fail("DSC1 decoded size differs from its header"); goto invalid; }
    *output = bytes; *outputSize = length; return 1;
invalid:
    free(bytes); return 0;
}
static uint8_t *readPayload(int fd, uint64_t offset, size_t length, size_t *size) {
    if (length > MEMBER_LIMIT) { fail("BGI member exceeds its extraction bounds"); return NULL; }
    uint8_t *bytes = malloc(length ? length : 1);
    if (!bytes) { fail("BGI resource allocation failed"); return NULL; }
    if (!readAt(fd, bytes, length, offset)) { free(bytes); return NULL; }
    if (length >= 15 && !memcmp(bytes, "DSC FORMAT 1.00", 15)) {
        uint8_t *decoded; size_t decodedSize;
        int okay = MLBGI_DecodeDsc(bytes, length, &decoded, &decodedSize); free(bytes);
        if (!okay) return NULL;
        *size = decodedSize; return decoded;
    }
    *size = length; return bytes;
}
static uint8_t *checkedPayload(int fd, const struct stat *identity, uint64_t offset, size_t length, size_t *size) {
    uint8_t *bytes = readPayload(fd, offset, length, size); struct stat after;
    if (bytes && (fstat(fd, &after) || !sameFile(identity, &after))) {
        free(bytes); *size = 0; fail("BGI resource changed during its read"); return NULL;
    }
    return bytes;
}
static int findName(const char *directory, const char *name, const char *alternative, char *output, size_t maximum) {
    DIR *dir = opendir(directory);
    if (!dir) return fail("BGI resource directory is inaccessible");
    struct dirent *entry; int found = 0;
    while ((entry = readdir(dir))) {
        /* Darwin can return directory records at four-byte aligned addresses.
         * Read the byte array without dereferencing an eight-byte struct. */
        const char *entryName = (const char *)entry + offsetof(struct dirent, d_name);
        if (!nameEqual(entryName, name) && (!alternative || !nameEqual(entryName, alternative))) continue;
        if (found) { closedir(dir); return fail("Ambiguous BGI resource filename"); }
        if (snprintf(output, maximum, "%s/%s", directory, entryName) >= (int)maximum) { closedir(dir); return fail("BGI resource path exceeds its bounds"); }
        found = 1;
    }
    closedir(dir);
    return found || fail("BGI resource was not found");
}
uint8_t *MLBGI_ReadFile(const char *archive, const char *filename, size_t *size) {
    lastError = NULL; size_t ignored; if (!size) size = &ignored; *size = 0;
    if (!safeName(archive, 96) || !safeName(filename, 96)) { fail("Unsafe BGI resource filename"); return NULL; }
    char alternate[101], path[PATH_LIMIT]; size_t length = strlen(archive);
    if (length > 4 && nameEqual(archive + length - 4, ".arc")) { memcpy(alternate, archive, length - 4); alternate[length - 4] = 0; }
    else snprintf(alternate, sizeof(alternate), "%s.arc", archive);
    if (!findName(".", archive, alternate, path, sizeof(path))) return NULL;
    struct stat pathStat;
    if (lstat(path, &pathStat) || S_ISLNK(pathStat.st_mode)) { fail("BGI resources cannot be symbolic links"); return NULL; }
    if (S_ISDIR(pathStat.st_mode)) {
        char memberPath[PATH_LIMIT];
        if (!findName(path, filename, NULL, memberPath, sizeof(memberPath))) return NULL;
        struct stat st; int fd = regularFile(memberPath, &st); if (fd < 0) return NULL;
        uint8_t *bytes = checkedPayload(fd, &st, 0, (size_t)st.st_size, size); close(fd); return bytes;
    }
    struct stat st; int fd = regularFile(path, &st); if (fd < 0) return NULL;
    Archive *index = indexArchive(path, fd, &st);
    if (!index) { close(fd); return NULL; }
    Member query = {0}; strcpy(query.name, filename);
    Member *member = bsearch(&query, index->members, index->count, sizeof(Member), MLBGI_MemberCompare);
    if (!member) { close(fd); fail("BGI archive member was not found"); return NULL; }
    uint8_t *bytes = checkedPayload(fd, &st, member->offset, member->size, size); close(fd); return bytes;
}
