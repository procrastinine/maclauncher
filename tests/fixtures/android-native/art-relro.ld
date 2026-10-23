PHDRS { text PT_LOAD FILEHDR PHDRS FLAGS(5); data PT_LOAD FLAGS(6); dynamic PT_DYNAMIC FLAGS(6); relro PT_GNU_RELRO FLAGS(4); }
SECTIONS {
 . = SIZEOF_HEADERS;
 .note.android.ident : { *(.note.android.ident) } :text
 .dynsym : { *(.dynsym) } :text
 .gnu.hash : { *(.gnu.hash) } :text
 .hash : { *(.hash) } :text
 .dynstr : { *(.dynstr) } :text
 .rela.dyn : { *(.rela.dyn) } :text
 .text : { *(.text*) } :text
 . = ALIGN(65536);
 .data.rel.ro : { *(.data.rel.ro*) } :data :relro
 .dynamic : { *(.dynamic) } :data :dynamic :relro
 .got : { *(.got*) } :data :relro
 .relro_padding : { . = ALIGN(4096); } :data :relro
 .data : { *(.data*) } :data
 .bss : { *(.bss*) *(COMMON) } :data
 /DISCARD/ : { *(.eh_frame*) *(.comment) }
}
