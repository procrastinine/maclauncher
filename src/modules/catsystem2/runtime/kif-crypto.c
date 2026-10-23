#include <CommonCrypto/CommonCryptor.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* KIF's Blowfish blocks store each 32-bit word little endian. CommonCrypto
 * supplies the system cipher; no third-party engine or game assets are linked.
 * Protocol: KBF1, LE key length, LE data length, LE operation (0 decrypt,
 * 1 encrypt), key bytes, data. Input/output data lengths are identical. */
static uint32_t integer(const unsigned char *bytes) {
    return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 |
        (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}
static void words(unsigned char *data, size_t length) {
    for (size_t at = 0; at < length; at += 4) {
        unsigned char first = data[at], second = data[at + 1];
        data[at] = data[at + 3]; data[at + 1] = data[at + 2];
        data[at + 2] = second; data[at + 3] = first;
    }
}
int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        puts("maclauncher-kif-crypto 1.0.0"); return 0;
    }
    if (argc != 1) return 2;
    unsigned char header[16], key[56];
    if (fread(header, 1, sizeof(header), stdin) != sizeof(header) || memcmp(header, "KBF1", 4)) return 2;
    const uint32_t key_length = integer(header + 4), length = integer(header + 8), operation = integer(header + 12);
    if (key_length < 4 || key_length > sizeof(key) || length > 64 * 1024 * 1024 || length % 8 || operation > 1) return 2;
    if (fread(key, 1, key_length, stdin) != key_length) return 2;
    /* Repeating a short key preserves Blowfish's cyclic key schedule while
     * meeting CommonCrypto's minimum key length. */
    size_t system_key_length = key_length;
    while (system_key_length < 8) system_key_length += key_length;
    for (size_t at = key_length; at < system_key_length; at++) key[at] = key[at % key_length];
    unsigned char *input = malloc(length ? length : 1), *output = malloc(length ? length : 1);
    if (!input || !output) { free(input); free(output); return 3; }
    if (fread(input, 1, length, stdin) != length || fgetc(stdin) != EOF) { free(input); free(output); return 2; }
    words(input, length);
    size_t written = 0;
    const CCCryptorStatus status = CCCrypt(operation ? kCCEncrypt : kCCDecrypt,
        kCCAlgorithmBlowfish, kCCOptionECBMode, key, system_key_length, NULL,
        input, length, output, length, &written);
    memset(key, 0, sizeof(key)); free(input);
    if (status != kCCSuccess || written != length) { free(output); return 3; }
    words(output, length);
    const int failed = fwrite(output, 1, length, stdout) != length || fflush(stdout) != 0;
    free(output); return failed ? 4 : 0;
}
