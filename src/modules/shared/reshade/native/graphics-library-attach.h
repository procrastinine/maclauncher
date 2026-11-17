// Applies the graphics libraries named in MACLAUNCHER_GRAPHICS_LIBRARIES inside a
// Wine process whose loader ignores DYLD variables but loads unsigned libraries
// (the hardened runtime with disable-library-validation). The Unix module that
// carries it calls maclauncher_attach_graphics_libraries() from its constructor:
// maclauncher-winemetal.so, which takes the Metal shim's place, and the
// WineVulkan scene client, which Vulkan routes load instead. The first caller in
// a process opens the libraries; later callers find them loaded and return.
//
// dyld applies a library's __interpose pairs only when the library is inserted
// at launch. For libraries opened here, the pairs are applied directly: every
// loaded and later-loaded image outside the dyld shared cache, apart from the
// libraries that declare them, has its symbol pointers to the original function
// rewritten to the replacement. The Wine Mac driver's CGWarpMouseCursorPosition,
// for example, then reaches the layer as it does through DYLD_INSERT_LIBRARIES.
#ifndef MACLAUNCHER_GRAPHICS_LIBRARY_ATTACH_H
#define MACLAUNCHER_GRAPHICS_LIBRARY_ATTACH_H
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <mach-o/getsect.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <mach/mach.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef MH_DYLIB_IN_CACHE
#define MH_DYLIB_IN_CACHE 0x80000000
#endif

struct graphics_attach_pair { const void *replacement; const void *original; };
struct graphics_attach_binding { const void *replacement; const void *original; const char *name; };
static struct graphics_attach_binding *graphics_attach_bindings;
static size_t graphics_attach_binding_count;
static const struct mach_header_64 **graphics_attach_owners;
static size_t graphics_attach_owner_count;

static const struct mach_header_64 *graphics_attach_image(void *handle) {
  for (uint32_t index = 0, count = _dyld_image_count(); index < count; index++) {
    const struct mach_header *image = _dyld_get_image_header(index);
    if (!image || (image->flags & MH_DYLIB_IN_CACHE)) continue;
    const char *name = _dyld_get_image_name(index);
    void *loaded = name ? dlopen(name, RTLD_NOLOAD | RTLD_LAZY) : NULL;
    if (!loaded) continue;
    dlclose(loaded);
    if (loaded == handle) return (const struct mach_header_64 *)_dyld_get_image_header(index);
  }
  return NULL;
}

static void graphics_attach_collect(const struct mach_header_64 *header) {
  static const char *const segments[] = {"__DATA", "__DATA_CONST", "__AUTH_CONST"};
  for (size_t segment = 0; segment < sizeof segments / sizeof *segments; segment++) {
    unsigned long size = 0;
    const struct graphics_attach_pair *pairs = (const void *)getsectiondata(header, segments[segment], "__interpose", &size);
    size_t count = pairs ? size / sizeof *pairs : 0;
    if (!count) continue;
    struct graphics_attach_binding *grown = realloc(graphics_attach_bindings, (graphics_attach_binding_count + count) * sizeof *graphics_attach_bindings);
    if (!grown) return;
    graphics_attach_bindings = grown;
    for (size_t index = 0; index < count; index++) {
      Dl_info info;
      const char *name = dladdr(pairs[index].original, &info) && info.dli_saddr == pairs[index].original ? info.dli_sname : NULL;
      graphics_attach_bindings[graphics_attach_binding_count++] = (struct graphics_attach_binding){pairs[index].replacement, pairs[index].original, name};
    }
  }
}

static int graphics_attach_read_only(const char *name) {
  return !strcmp(name, "__DATA_CONST") || !strcmp(name, "__AUTH_CONST");
}

static void graphics_attach_section(const struct section_64 *section, intptr_t slide, int read_only,
                           const struct nlist_64 *symbols, const char *strings, const uint32_t *indirect) {
  uint32_t type = section->flags & SECTION_TYPE;
  if (type != S_LAZY_SYMBOL_POINTERS && type != S_NON_LAZY_SYMBOL_POINTERS) return;
  const void **slots = (const void **)(uintptr_t)(section->addr + slide);
  const uint32_t *indices = indirect + section->reserved1;
  for (uint64_t slot = 0, count = section->size / sizeof(void *); slot < count; slot++) {
    uint32_t symbol = indices[slot];
    const char *name = symbol & (INDIRECT_SYMBOL_LOCAL | INDIRECT_SYMBOL_ABS) ? NULL : strings + symbols[symbol].n_un.n_strx;
    for (size_t index = 0; index < graphics_attach_binding_count; index++) {
      const struct graphics_attach_binding *binding = &graphics_attach_bindings[index];
      int named = name && binding->name && name[0] == '_' && !strcmp(name + 1, binding->name);
      if ((!named && slots[slot] != binding->original) || slots[slot] == binding->replacement) continue;
      vm_address_t page = (vm_address_t)&slots[slot] & ~(vm_address_t)vm_page_mask;
      if (read_only && vm_protect(mach_task_self(), page, vm_page_size, 0, VM_PROT_READ | VM_PROT_WRITE | VM_PROT_COPY) != KERN_SUCCESS) break;
      slots[slot] = binding->replacement;
      if (read_only) vm_protect(mach_task_self(), page, vm_page_size, 0, VM_PROT_READ);
      break;
    }
  }
}

static void graphics_attach_rebind(const struct mach_header *image, intptr_t slide) {
  const struct mach_header_64 *header = (const struct mach_header_64 *)image;
  if (header->magic != MH_MAGIC_64 || (header->flags & MH_DYLIB_IN_CACHE)) return;
  for (size_t index = 0; index < graphics_attach_owner_count; index++) if (graphics_attach_owners[index] == header) return;
  const struct segment_command_64 *linkedit = NULL;
  const struct symtab_command *symtab = NULL;
  const struct dysymtab_command *dysymtab = NULL;
  const struct load_command *command = (const void *)(header + 1);
  for (uint32_t index = 0; index < header->ncmds; index++, command = (const void *)((const char *)command + command->cmdsize)) {
    if (command->cmd == LC_SEGMENT_64 && !strcmp(((const struct segment_command_64 *)command)->segname, SEG_LINKEDIT))
      linkedit = (const void *)command;
    else if (command->cmd == LC_SYMTAB) symtab = (const void *)command;
    else if (command->cmd == LC_DYSYMTAB) dysymtab = (const void *)command;
  }
  if (!linkedit || !symtab || !dysymtab || !dysymtab->nindirectsyms) return;
  uintptr_t base = (uintptr_t)slide + linkedit->vmaddr - linkedit->fileoff;
  const struct nlist_64 *symbols = (const void *)(base + symtab->symoff);
  const char *strings = (const char *)(base + symtab->stroff);
  const uint32_t *indirect = (const void *)(base + dysymtab->indirectsymoff);
  command = (const void *)(header + 1);
  for (uint32_t index = 0; index < header->ncmds; index++, command = (const void *)((const char *)command + command->cmdsize)) {
    if (command->cmd != LC_SEGMENT_64) continue;
    const struct segment_command_64 *segment = (const void *)command;
    if (strncmp(segment->segname, "__DATA", 6) && strncmp(segment->segname, "__AUTH", 6)) continue;
    const struct section_64 *sections = (const void *)(segment + 1);
    for (uint32_t section = 0; section < segment->nsects; section++)
      graphics_attach_section(&sections[section], slide, graphics_attach_read_only(segment->segname), symbols, strings, indirect);
  }
}

static void maclauncher_attach_graphics_libraries(void) {
  const char *list = getenv("MACLAUNCHER_GRAPHICS_LIBRARIES");
  if (!list || !*list) return;
  char *copy = strdup(list);
  if (!copy) return;
  for (char *next = copy, *library; (library = strsep(&next, ":")) != NULL;) {
    if (library[0] != '/') continue;
    // Already loaded: another module of this process applied it first.
    void *loaded = dlopen(library, RTLD_NOLOAD | RTLD_NOW);
    if (loaded) { dlclose(loaded); continue; }
    void *handle = dlopen(library, RTLD_NOW | RTLD_GLOBAL);
    if (!handle) { fprintf(stderr, "MacLauncher graphics: %s\n", dlerror()); continue; }
    const struct mach_header_64 *header = graphics_attach_image(handle);
    const struct mach_header_64 **grown = header ? realloc(graphics_attach_owners, (graphics_attach_owner_count + 1) * sizeof *graphics_attach_owners) : NULL;
    if (!grown) continue;
    graphics_attach_owners = grown;
    graphics_attach_owners[graphics_attach_owner_count++] = header;
    graphics_attach_collect(header);
  }
  free(copy);
  // Runs for every image already loaded, then for each image loaded later.
  if (graphics_attach_binding_count) _dyld_register_func_for_add_image(graphics_attach_rebind);
}

#endif
