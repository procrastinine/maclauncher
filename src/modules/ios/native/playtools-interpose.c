// Address declarations only: calls use the Swift ABI in playtools-paths.swift.
extern void ml_playtools_file_url(void);
extern void ml_foundation_file_url(void) __asm__("_$s10Foundation3URLV15fileURLWithPathACSSh_tcfC");
__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *replacement; const void *original; } file_url = {
    (const void *)&ml_playtools_file_url, (const void *)&ml_foundation_file_url
};
