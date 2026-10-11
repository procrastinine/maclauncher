/* SPDX-License-Identifier: GPL-2.0-only */
#include "vm-strings.h"
#include "vm-dialect.h"
#include "vm-guards.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <iconv.h>

int MLBGI_CP932ToUTF8(const char *source, char *output, size_t capacity) {
    if (!source || !output || !capacity) return 0;
    size_t sourceBytes = strnlen(source, 1024);
    if (sourceBytes > 1023) return 0;
    iconv_t converter = iconv_open("UTF-8", "CP932");
    if (converter == (iconv_t)-1) return 0;
    char *input = (char *)source, *destination = output;
    size_t remaining = capacity - 1;
    size_t result = iconv(converter, &input, &sourceBytes, &destination, &remaining);
    iconv_close(converter);
    if (result == (size_t)-1 || sourceBytes) return 0;
    *destination = 0; return 1;
}

static uint32_t fault(Thread_t *thread) { thread->error = 1; thread->running = 0; return UINT32_MAX - 3; }
static int pop(Thread_t *thread, uint32_t *value) {
    if (thread->error || !thread->stack || !thread->stackSize ||
        (MLBGI_IsModern(thread) ? thread->stackPointer >= thread->stackSize : !thread->stackPointer)) { fault(thread); return 0; }
    *value = Thread_PopStack(thread); return !thread->error;
}
static size_t textCharacter(const char *input) {
    unsigned char first = (unsigned char)input[0];
    if ((first >= 0x81 && first <= 0x9f) || (first >= 0xe0 && first <= 0xfc)) {
        unsigned char second = (unsigned char)input[1];
        return second >= 0x40 && second <= 0xfc && second != 0x7f ? 2 : 0;
    }
    return first >= 0x20 && first != 0x7f && first != 0x80 && first != 0xa0 && first < 0xfd ? 1 : 0;
}
int MLBGI_RegisterTextRules(Engine_t *engine, const char *input) {
    MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || state->textRuleCount > 64) return -1;
    if (!input) return 0;
    if (strnlen(input, 65536) == 65536) return -1;
    MLBGI_TextRule *rules = malloc(sizeof(state->textRules));
    if (!rules) return -1;
    memcpy(rules, state->textRules, sizeof(state->textRules)); unsigned count = state->textRuleCount;
    while (*input) {
        const char *name = input;
        while (*input && *input != '\\') {
            size_t bytes = textCharacter(input); if (!bytes) goto invalid;
            input += bytes;
        }
        size_t sourceBytes = (size_t)(input - name);
        if (*input != '\\' || !sourceBytes || sourceBytes >= sizeof(rules[0].source)) goto invalid;
        const char *replacement = ++input;
        while (*input && *input != '\n') {
            size_t bytes = textCharacter(input); if (!bytes) goto invalid;
            input += bytes;
        }
        size_t replacementBytes = (size_t)(input - replacement);
        if (!replacementBytes || replacementBytes >= sizeof(rules[0].replacement)) goto invalid;
        unsigned index = 0;
        while (index < count && (strlen(rules[index].source) != sourceBytes || memcmp(rules[index].source, name, sourceBytes))) index++;
        if (index == count) {
            if (count == 64) goto invalid;
            /* Native persistent matches use longer byte strings first;
               a new equal-length rule precedes the earlier one. */
            index = 0; while (index < count && strlen(rules[index].source) > sourceBytes) index++;
            memmove(rules + index + 1, rules + index, (count - index) * sizeof(*rules)); count++;
            memcpy(rules[index].source, name, sourceBytes); rules[index].source[sourceBytes] = 0;
        }
        memcpy(rules[index].replacement, replacement, replacementBytes); rules[index].replacement[replacementBytes] = 0;
        if (*input) input++;
    }
    memcpy(state->textRules, rules, sizeof(state->textRules)); state->textRuleCount = count;
    free(rules); return 1;
invalid:
    free(rules); return -1;
}
int MLBGI_TextRulesAffect(const Engine_t *engine, const char *input) {
    const MLBGI_Runtime *state = engine ? engine->mlRuntime : NULL;
    if (!state || state->dialect != MLBGI_ETHORNELL_172 || !input || state->textRuleCount > 64) return 0;
    size_t remaining = strnlen(input, 4096);
    if (remaining == 4096) return 1;
    while (remaining) {
        for (unsigned i = 0; i < state->textRuleCount; i++) {
            size_t bytes = strlen(state->textRules[i].source);
            if (bytes <= remaining && !memcmp(input, state->textRules[i].source, bytes)) return 1;
        }
        size_t bytes = textCharacter(input); if (!bytes) return 1;
        input += bytes; remaining -= bytes;
    }
    return 0;
}
uint32_t MLBGI_CopyString(Thread_t *thread) {
    uint32_t source, destination;
    if (!pop(thread, &source) || !pop(thread, &destination)) return fault(thread);
    const char *value = MLBGI_ReadString(thread, source, 65536);
    return value ? MLBGI_WriteString(thread, destination, value) : fault(thread);
}
uint32_t MLBGI_StringLength(Thread_t *thread) {
    uint32_t source;
    if (!pop(thread, &source)) return fault(thread);
    const char *value = MLBGI_ReadString(thread, source, 65536);
    if (!value) return fault(thread);
    Thread_PushStack(thread, (uint32_t)strlen(value)); return 0;
}
uint32_t MLBGI_EqualStrings(Thread_t *thread) {
    uint32_t second, first;
    if (!pop(thread, &second) || !pop(thread, &first)) return fault(thread);
    const char *a = MLBGI_ReadString(thread, first, 65536), *b = MLBGI_ReadString(thread, second, 65536);
    if (!a || !b) return fault(thread);
    Thread_PushStack(thread, strcmp(a, b) == 0); return 0;
}
uint32_t MLBGI_CopyMemory(Thread_t *thread) {
    uint32_t bytes, source, destination;
    if (!pop(thread, &bytes) || !pop(thread, &source) || !pop(thread, &destination)) return fault(thread);
    uint8_t *a = MLBGI_ResolveAddress(thread, source), *b = MLBGI_ResolveAddress(thread, destination);
    if ((!a || !b) && bytes || MLBGI_MemoryRemaining(thread->engine, a) < bytes || MLBGI_MemoryRemaining(thread->engine, b) < bytes) return fault(thread);
    if (bytes) memmove(b, a, bytes); return 0;
}
uint32_t MLBGI_EqualMemory(Thread_t *thread) {
    if (!MLBGI_IsModern(thread)) return UINT32_MAX;
    uint32_t bytes, second, first;
    if (!pop(thread, &bytes) || !pop(thread, &second) || !pop(thread, &first)) return fault(thread);
    const uint8_t *a = MLBGI_ResolveAddress(thread, first), *b = MLBGI_ResolveAddress(thread, second);
    if (thread->error || ((!a || !b) && bytes) || MLBGI_MemoryRemaining(thread->engine, a) < bytes ||
        MLBGI_MemoryRemaining(thread->engine, b) < bytes) return fault(thread);
    Thread_PushStack(thread, !bytes || !memcmp(a, b, bytes)); return 0;
}
uint32_t MLBGI_ClearMemory(Thread_t *thread) {
    uint32_t bytes, destination;
    if (!pop(thread, &bytes) || !pop(thread, &destination)) return fault(thread);
    uint8_t *output = MLBGI_ResolveAddress(thread, destination);
    if ((!output && bytes) || MLBGI_MemoryRemaining(thread->engine, output) < bytes) return fault(thread);
    if (bytes) memset(output, 0, bytes); return 0;
}
uint32_t MLBGI_FormatString(Thread_t *thread) {
    uint32_t formatAddress, destination;
    if (!pop(thread, &formatAddress) || !pop(thread, &destination)) return fault(thread);
    const char *format = MLBGI_ReadString(thread, formatAddress, 65536);
    uint8_t *output = MLBGI_ResolveAddress(thread, destination);
    if (!format || !output) return fault(thread);
    size_t capacity = MLBGI_MemoryRemaining(thread->engine, output);
    if (capacity > 65536) capacity = 65536;
    if (!capacity) return fault(thread);
    char *temporary = malloc(capacity); if (!temporary) return fault(thread);
    size_t written = 0; unsigned arguments = 0;
    for (size_t i = 0; format[i]; i++) {
        if (format[i] != '%') { if (written + 1 >= capacity) goto invalid; temporary[written++] = format[i]; continue; }
        size_t start = i++;
        if (format[i] == '%') { if (written + 1 >= capacity) goto invalid; temporary[written++] = '%'; continue; }
        while (format[i] && strchr("-+ #0", format[i])) i++;
        unsigned width = 0, precision = 0;
        while (isdigit((unsigned char)format[i])) { width = width * 10 + format[i++] - '0'; if (width > 4096) goto invalid; }
        if (format[i] == '.') {
            i++;
            while (isdigit((unsigned char)format[i])) { precision = precision * 10 + format[i++] - '0'; if (precision > 4096) goto invalid; }
        }
        if (!format[i] || !strchr("dcxXs", format[i]) || ++arguments > 64 || i - start >= 32) goto invalid;
        char specification[33]; memcpy(specification, format + start, i - start + 1); specification[i - start + 1] = 0;
        uint32_t value; if (!pop(thread, &value)) goto invalid;
        int bytes;
        if (format[i] == 's') {
            const char *string = MLBGI_ReadString(thread, value, 65536); if (!string) goto invalid;
            bytes = snprintf(temporary + written, capacity - written, specification, string);
        } else if (format[i] == 'd' || format[i] == 'c') bytes = snprintf(temporary + written, capacity - written, specification, (int32_t)value);
        else bytes = snprintf(temporary + written, capacity - written, specification, value);
        if (bytes < 0 || (size_t)bytes >= capacity - written) goto invalid;
        written += (size_t)bytes;
    }
    temporary[written] = 0; memmove(output, temporary, written + 1); free(temporary); return 0;
invalid:
    free(temporary); return fault(thread);
}
