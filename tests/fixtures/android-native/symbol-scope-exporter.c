/* An independently loaded local ELF. Never execute the C++ marker. */
void scope_ios_marker(void *) __asm__("_ZNSt6__ndk18ios_base4initEPv");
void scope_ios_marker(void *object) { (void)object; }
int scope_local_only(void) { return 19; }
