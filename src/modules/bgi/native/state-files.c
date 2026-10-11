/* SPDX-License-Identifier: GPL-2.0-only
 * Original game files are query-only. All native filesystem writes are
 * confined to a caller-supplied state directory outside the game directory. */
#include "state-files.h"
#include "archive-reader.h"
#include <errno.h>
#include <fcntl.h>
#include <iconv.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>
#include <limits.h>
#include <dirent.h>

static const char virtualRoot[] = "C:\\Game";
const char *MLBGI_VirtualDirectory(void) { return "C:\\Game\\"; }
void MLBGI_CloseFiles(MLBGI_Files *files) {
    if (files->sourceFd >= 0) close(files->sourceFd);
    if (files->stateFd >= 0) close(files->stateFd);
    files->sourceFd = files->stateFd = -1;
}
int MLBGI_ConfigureFiles(MLBGI_Files *files, const char *directory) {
    if (!files || files->sourceFd >= 0 || files->stateFd >= 0 || !directory || directory[0] != '/') return 0;
    struct stat st;
    if (lstat(directory, &st) || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode)) return 0;
    char game[PATH_MAX], state[PATH_MAX];
    if (!realpath(".", game) || !realpath(directory, state)) return 0;
    size_t length = strlen(game);
    if (!strncmp(game, state, length) && (!state[length] || state[length] == '/')) return 0;
    length = strlen(state);
    if (!strncmp(state, game, length) && (!game[length] || game[length] == '/')) return 0;
    files->sourceFd = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    files->stateFd = open(state, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (files->sourceFd < 0 || files->stateFd < 0) { MLBGI_CloseFiles(files); return 0; }
    return 1;
}
static int path(MLBGI_Files *files, const char *name, char *normalized, int *root, int writing) {
    if (!files || files->sourceFd < 0 || files->stateFd < 0 || !name) return 0;
    size_t rootLength = sizeof(virtualRoot) - 1;
    int state = !strncasecmp(name, virtualRoot, rootLength) && (!name[rootLength] || name[rootLength] == '\\' || name[rootLength] == '/');
    if (state) { name += rootLength; if (*name) name++; }
    /* Relative writes use the isolated state root too. A Windows script need
       not manufacture an absolute path to keep its original data unchanged. */
    *root = state || writing ? files->stateFd : files->sourceFd;
    if (!*name) { normalized[0] = 0; return state; }
    if (!MLBGI_ValidSearchPath(name)) return 0;
    char inputBytes[257]; strcpy(inputBytes, name);
    for (size_t i = 0; inputBytes[i]; i++) {
        unsigned char c = (unsigned char)inputBytes[i];
        if ((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) i++;
        else if (c == '\\') inputBytes[i] = '/';
    }
    iconv_t conversion = iconv_open("UTF-8", "SHIFT_JIS");
    if (conversion == (iconv_t)-1) return 0;
    char *input = inputBytes, *output = normalized; size_t inputSize = strlen(input), outputSize = 1024;
    size_t result = iconv(conversion, &input, &inputSize, &output, &outputSize);
    iconv_close(conversion);
    if (result == (size_t)-1 || inputSize) return 0;
    *output = 0; return 1;
}
static int walk(int root, char *name, int create, struct stat *status) {
    int fd = dup(root);
    if (fd < 0) return 0;
    if (!*name) { int result = !fstat(fd, status); close(fd); return result; }
    char *component = name;
    while (*component) {
        char *slash = strchr(component, '/'); if (slash) *slash = 0;
        if (create && !slash && mkdirat(fd, component, 0700)) { close(fd); return 0; }
        int next = openat(fd, component, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW | (slash || create ? O_DIRECTORY : 0));
        close(fd); fd = next;
        if (fd < 0) return 0;
        if (!slash) break;
        component = slash + 1;
    }
    int result = !fstat(fd, status); close(fd); return result;
}
int MLBGI_PathStatus(MLBGI_Files *files, const char *name, int directoryOnly) {
    char normalized[1025]; int root; struct stat st;
    if (!path(files, name, normalized, &root, 0)) return 0;
    char stateName[1025]; strcpy(stateName, normalized);
    if (root != files->stateFd && walk(files->stateFd, stateName, 0, &st))
        return directoryOnly ? S_ISDIR(st.st_mode) : S_ISDIR(st.st_mode) || S_ISREG(st.st_mode);
    if (!walk(root, normalized, 0, &st)) return 0;
    return directoryOnly ? S_ISDIR(st.st_mode) : S_ISDIR(st.st_mode) || S_ISREG(st.st_mode);
}
int MLBGI_CreateDirectory(MLBGI_Files *files, const char *name) {
    char normalized[1025]; int root; struct stat st;
    if (!path(files, name, normalized, &root, 1) || !*normalized || !walk(root, normalized, 1, &st)) return 0;
    return S_ISDIR(st.st_mode);
}
int MLBGI_DeleteFile(MLBGI_Files *files, const char *name) {
    char normalized[1025]; int root;
    if (!path(files, name, normalized, &root, 1) || !*normalized || root != files->stateFd) return 0;
    int directory = dup(root);
    if (directory < 0) return 0;
    char *component = normalized, *slash;
    while ((slash = strchr(component, '/'))) {
        *slash = 0;
        int next = openat(directory, component, O_RDONLY | O_NONBLOCK | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        close(directory); directory = next;
        if (directory < 0) return 0;
        component = slash + 1;
    }
    struct stat status;
    int regular = !fstatat(directory, component, &status, AT_SYMLINK_NOFOLLOW) && S_ISREG(status.st_mode);
    int removed = regular && !unlinkat(directory, component, 0);
    close(directory); return removed;
}
int MLBGI_GlobalDatabaseStatus(MLBGI_Files *files) {
    if (!files || files->stateFd < 0) return -1;
    int fd = openat(files->stateFd, "BGI.gdb", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return errno == ENOENT ? 0 : -1;
    struct stat st; int okay = !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_size >= 0 && st.st_size <= 32 * 1024 * 1024;
    close(fd); return okay ? 1 : -1;
}
static unsigned char asciiFold(unsigned char value) {
    return value >= 'A' && value <= 'Z' ? value + ('a' - 'A') : value;
}
static size_t characterBytes(const char *text) {
    unsigned char value = (unsigned char)*text;
    return ((value >= 0x81 && value <= 0x9f) || (value >= 0xe0 && value <= 0xfc)) && text[1] ? 2 : 1;
}
static int filenameMatch(const char *pattern, const char *name) {
    const char *star = NULL, *retry = NULL;
    if (!strcmp(pattern, "*.*")) pattern = "*";
    while (*name) {
        if (*pattern == '*') { star = ++pattern; retry = name; continue; }
        size_t p = characterBytes(pattern), n = characterBytes(name);
        if (*pattern == '?' || (*pattern && p == n &&
            (p == 2 ? !memcmp(pattern, name, 2) : asciiFold((unsigned char)*pattern) == asciiFold((unsigned char)*name)))) {
            pattern += *pattern == '?' ? 1 : p; name += n; continue;
        }
        if (!star || !*retry) return 0;
        retry += characterBytes(retry); name = retry; pattern = star;
    }
    while (*pattern == '*') pattern++;
    return !*pattern;
}
static int cp932(const char *source, char output[257]) {
    iconv_t conversion = iconv_open("CP932", "UTF-8");
    if (conversion == (iconv_t)-1) return 0;
    char *input = (char *)source, *target = output;
    size_t inputBytes = strlen(source), targetBytes = 256;
    size_t status = iconv(conversion, &input, &inputBytes, &target, &targetBytes);
    iconv_close(conversion);
    if (status == (size_t)-1 || inputBytes) return 0;
    *target = 0; return 1;
}
static int foldedFilenameOrder(const char *a, const char *b) {
    while (*a && *b) {
        size_t first = characterBytes(a), second = characterBytes(b);
        int order;
        if (first == 2 || second == 2) {
            order = memcmp(a, b, first < second ? first : second);
            if (!order && first != second) order = first < second ? -1 : 1;
        } else order = (int)asciiFold((unsigned char)*a) - asciiFold((unsigned char)*b);
        if (order) return order;
        a += first; b += second;
    }
    return (unsigned char)*a - (unsigned char)*b;
}
static int compareFilenames(const void *left, const void *right) {
    const char *a = *(const char *const *)left, *b = *(const char *const *)right;
    int order = foldedFilenameOrder(a, b); return order ? order : strcmp(a, b);
}
int MLBGI_FindFiles(MLBGI_Files *files, const char *pattern, uint32_t limit,
                   uint8_t *output, size_t capacity, size_t *written) {
    char normalized[1025], encodedPattern[257]; int root;
    if (written) *written = 0;
    if (!written || limit > 65536 || !path(files, pattern, normalized, &root, 0) || !*normalized) return -1;
    char *slash = strrchr(normalized, '/'), *leaf = slash ? slash + 1 : normalized;
    if (!cp932(leaf, encodedPattern)) return -1;
    if (slash) *slash = 0;
    int fd = openat(root, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    if (slash) {
        char *component = normalized;
        while (*component) {
            char *next = strchr(component, '/'); if (next) *next = 0;
            if (strchr(component, '*') || strchr(component, '?')) { close(fd); return -1; }
            int child = openat(fd, component, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            close(fd); fd = child;
            if (fd < 0) return errno == ENOENT ? 0 : -1;
            if (!next) break;
            component = next + 1;
        }
    }
    DIR *directory = fdopendir(fd);
    if (!directory) { close(fd); return -1; }
    char **names = NULL; size_t count = 0, bytes = 0, scanned = 0;
    int result = -1; struct dirent *entry;
    for (;;) {
        errno = 0; entry = readdir(directory);
        if (!entry) { if (errno) goto done; break; }
        /* Darwin's legacy directory stream can return records aligned to
           four bytes even when struct dirent requires eight. Read only
           bounded character bytes, without dereferencing the struct. */
        uint16_t recordBytes = 0;
        memcpy(&recordBytes, (const uint8_t *)entry + offsetof(struct dirent, d_reclen), sizeof(recordBytes));
        if (recordBytes <= offsetof(struct dirent, d_name) || recordBytes > sizeof(struct dirent)) goto done;
        const char *entryName = (const char *)entry + offsetof(struct dirent, d_name);
        if (!memchr(entryName, 0, recordBytes - offsetof(struct dirent, d_name))) goto done;
        if (!strcmp(entryName, ".") || !strcmp(entryName, "..")) continue;
        if (++scanned > 65536) goto done;
        struct stat status;
        if (fstatat(fd, entryName, &status, AT_SYMLINK_NOFOLLOW)) goto done;
        if (S_ISDIR(status.st_mode)) continue;
        char name[257];
        if (!cp932(entryName, name)) goto done;
        if (!filenameMatch(encodedPattern, name)) continue;
        if (!S_ISREG(status.st_mode)) goto done;
        size_t size = strlen(name) + 1;
        if (size > 16 * 1024 * 1024 - bytes) goto done;
        char **expanded = realloc(names, (count + 1) * sizeof(*names));
        if (!expanded) goto done;
        names = expanded; names[count] = malloc(size);
        if (!names[count]) goto done;
        memcpy(names[count], name, size); count++; bytes += size;
    }
    if (count > 1) qsort(names, count, sizeof(*names), compareFilenames);
    for (size_t i = 1; i < count; i++) if (!foldedFilenameOrder(names[i - 1], names[i])) goto done;
    size_t selected = limit && count > limit ? limit : count;
    bytes = 0;
    for (size_t i = 0; i < selected; i++) bytes += strlen(names[i]) + 1;
    if (output && bytes > capacity) goto done;
    for (size_t i = 0, at = 0; output && i < selected; i++) {
        size_t size = strlen(names[i]) + 1; memcpy(output + at, names[i], size); at += size;
    }
    *written = bytes; result = (int)selected;
done:
    for (size_t i = 0; i < count; i++) free(names[i]);
    free(names); closedir(directory); return result;
}
