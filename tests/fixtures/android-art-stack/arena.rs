#[test]
fn real_initial_stack_mapping_uses_existing_top_without_clobbering() {
    let len=crate::loader::PAGE;
    assert_eq!(super::map_stack(super::HI-super::LO+len,libc::PROT_READ),Err(-(crate::errno::ENOMEM as i64)));
    let at=super::map_stack(len,libc::PROT_READ|libc::PROT_WRITE).unwrap();
    assert_eq!(at,super::HI-len);
    unsafe{(at as*mut u64).write(0xfeed_abc0);}
    // Darwin's non-fixed first-fit hint must fail at the occupied arena top,
    // retaining the real existing mapping and its bytes.
    assert!(super::map_stack(len,libc::PROT_READ|libc::PROT_WRITE).is_err());
    assert_eq!(unsafe{(at as*const u64).read()},0xfeed_abc0);
    assert_eq!(unsafe{libc::munmap(at as*mut _,len as usize)},0);
}
