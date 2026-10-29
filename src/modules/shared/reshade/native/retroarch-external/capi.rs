// Copyright (c) MacLauncher contributors. MIT license.
#[repr(C)]
/// One authored external shader resource declaration.
pub struct LibraMTLExternalDeclarationV1 {
    /// Null-terminated authored shader identifier.
    pub name: *const c_char,
    /// 0: read-only 2D image; 1: float4x4 matrix.
    pub kind: u32,
    /// Reserved; must be zero.
    pub reserved: u32,
}
#[repr(C)]
/// Current read-only value of one declared shader resource.
pub struct LibraMTLExternalValueV1 {
    /// Null-terminated declared shader identifier.
    pub name: *const c_char,
    /// Zero for an image or one for a matrix.
    pub kind: u32,
    /// Reserved; must be zero.
    pub reserved: u32,
    /// Current Metal texture for image inputs; null for matrices.
    pub texture: PMTLTexture,
    /// Sixteen column-major GLSL values for matrix inputs.
    pub matrix: [f32; 16],
}
#[no_mangle]
/// Return the version of the optional external input API.
pub extern "C" fn libra_mtl_external_inputs_api() -> u32 { 1 }
/// Whether this exact chain uploads immutable per-encoder uniform snapshots.
#[no_mangle]
pub extern "C" fn libra_mtl_filter_chain_uniform_snapshots(chain: *const libra_mtl_filter_chain_t) -> u32 {
    let Some(chain) = (unsafe {chain.as_ref()}).and_then(|value|value.as_ref()) else {return 0;};
    u32::from(unsafe {chain.as_ref()}.uniform_snapshots_supported())
}
/// Total physical GPU buffer bytes for the requested prepared capacity.
/// Before allocation this is a conservative page bound; afterward it is the
/// actual MTLBuffer allocatedSize sum. UINT64_MAX denotes invalid/overflow.
#[no_mangle]
pub extern "C" fn libra_mtl_filter_chain_uniform_snapshot_bytes(chain: *const libra_mtl_filter_chain_t, capacity: usize) -> u64 {
    let Some(chain) = (unsafe {chain.as_ref()}).and_then(|value|value.as_ref()) else {return u64::MAX;};
    unsafe {chain.as_ref()}.uniform_snapshot_bytes(capacity)
}
/// Metadata-only availability; no command/history mutation or CPU wait.
#[no_mangle]
pub extern "C" fn libra_mtl_filter_chain_uniform_snapshots_available(chain: *const libra_mtl_filter_chain_t) -> u32 {
    let Some(chain) = (unsafe {chain.as_ref()}).and_then(|value|value.as_ref()) else {return 0;};
    u32::from(unsafe {chain.as_ref()}.uniform_snapshots_available())
}
extern_fn! {
    /// Worker-only immutable large-uniform arena preparation.
    fn libra_mtl_filter_chain_prepare_uniform_snapshots(
        chain: *mut libra_mtl_filter_chain_t,
        capacity: usize
    ) {
        assert_non_null!(chain);
        let chain = unsafe {(*chain).as_mut().ok_or(LibrashaderError::InvalidParameter("chain"))?.as_mut()};
        chain.prepare_uniform_snapshots(capacity)?;
    }
}
extern_fn! {
    /// Create the original Metal chain with explicit external resource names.
    fn libra_mtl_filter_chain_create_external(
        preset: *mut libra_shader_preset_t,
        queue: PMTLCommandQueue,
        options: *const MaybeUninit<filter_chain_mtl_opt_t>,
        declarations: *const LibraMTLExternalDeclarationV1,
        count: usize,
        out: *mut MaybeUninit<libra_mtl_filter_chain_t>
    ) |queue| {
        assert_non_null!(preset);assert_non_null!(out);
        if count > 128 || count > 0 && declarations.is_null() {return Err(LibrashaderError::InvalidParameter("external declarations"));}
        let declarations = if count == 0 {&[]} else {unsafe {slice::from_raw_parts(declarations, count)}};
        let mut names = Vec::with_capacity(count);
        for value in declarations {
            if value.name.is_null() {return Err(LibrashaderError::InvalidParameter("external name"));}
            if value.kind > 1 || value.reserved != 0 {return Err(LibrashaderError::InvalidParameter("external declaration kind"));}
            names.push((unsafe {CStr::from_ptr(value.name)}.to_str()?.to_owned(), value.kind));
        }
        let owned = unsafe {Box::from_raw((*preset).take().ok_or(LibrashaderError::InvalidParameter("preset"))?.as_ptr())};
        let options = if options.is_null() {None} else {Some(FromUninit::from_uninit(unsafe {options.read()}))};
        let chain = FilterChain::load_from_preset_external(*owned, queue.as_ref(), options.as_ref(), &names)?;
        unsafe {out.write(MaybeUninit::new(NonNull::new(Box::into_raw(Box::new(chain)))));}
    }
}
extern_fn! {
    /// Supply exact current values before one original filter-chain frame.
    fn libra_mtl_filter_chain_set_external(
        chain: *mut libra_mtl_filter_chain_t,
        values: *const LibraMTLExternalValueV1,
        count: usize
    ) {
        assert_non_null!(chain);
        if count > 128 || count > 0 && values.is_null() {return Err(LibrashaderError::InvalidParameter("external values"));}
        let chain = unsafe {(*chain).as_mut().ok_or(LibrashaderError::InvalidParameter("chain"))?.as_mut()};
        let values = if count == 0 {&[]} else {unsafe {slice::from_raw_parts(values, count)}};
        let mut inputs = Vec::with_capacity(count);
        for value in values {
            if value.name.is_null() {return Err(LibrashaderError::InvalidParameter("external name"));}
            if value.kind > 1 || value.reserved != 0 {return Err(LibrashaderError::InvalidParameter("external value kind"));}
            let name = unsafe {CStr::from_ptr(value.name)}.to_str()?.to_owned();
            let texture = if value.kind == 0 {
                Some(unsafe {objc2::rc::Retained::retain(value.texture as *mut ProtocolObject<dyn MTLTexture>)}
                    .ok_or(LibrashaderError::InvalidParameter("external texture"))?)
            } else {
                if !value.texture.is_null() {return Err(LibrashaderError::InvalidParameter("matrix texture"));}
                None
            };
            inputs.push(librashader::runtime::mtl::ExternalValue {name, texture, matrix: if value.kind == 1 {Some(value.matrix)} else {None}});
        }
        chain.set_external_inputs(inputs)?;
    }
}
