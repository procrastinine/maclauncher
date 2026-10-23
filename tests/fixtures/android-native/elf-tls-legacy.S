.section .data.rel.ro,"aw",@progbits
.p2align 3
tls_legacy_index:
/* LLVM no longer links the older dynamic TLS relocation family. The fixture
 * producer replaces these two ordinary dynamic relocations with the ELF ABI's
 * DTPMOD64/DTPREL64 records after linking, retaining a real GOT and PLT call. */
.xword tls_legacy_module_marker
.xword tls_legacy_offset_marker

.text
.p2align 2
.global tls_legacy_address
.type tls_legacy_address,%function
tls_legacy_address:
    adrp x0,tls_legacy_index
    add x0,x0,:lo12:tls_legacy_index
    b __tls_get_addr
.size tls_legacy_address,.-tls_legacy_address
