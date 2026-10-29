// Copyright (c) MacLauncher contributors. MIT license.
use crate::error::{FilterChainError, Result};
use crate::filter_chain::FilterChainMetal;
use crate::options::FilterChainOptionsMetal;
use crate::texture::InputTexture;
use librashader_common::map::{FastHashMap, ShortString};
use librashader_common::{FilterMode, WrapMode};
use librashader_presets::ShaderPreset;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_metal::{MTLCommandBuffer, MTLCommandQueue, MTLDevice, MTLResource, MTLTexture, MTLTextureType, MTLTextureUsage};
use objc2_metal::{MTLBuffer, MTLResourceOptions};
use std::cell::Cell;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};

/// A frame's large blocks occupy one prepared arena. The completion block
/// owns only this slot lease, never the chain or its command buffer.
pub(crate) struct UniformSlot {
    buffer: Retained<ProtocolObject<dyn MTLBuffer>>,
    token: AtomicU64,
    managed: bool,
}
// Metal resource retention is thread-safe. Only the encoding thread holding
// the unique token writes bytes; completion threads touch only token atomics.
unsafe impl Send for UniformSlot {}
unsafe impl Sync for UniformSlot {}

struct UniformLease {slot: Arc<UniformSlot>, token: u64}
impl UniformLease {
    fn retire(&self) {
        let _ = self.slot.token.compare_exchange(self.token, 0, Ordering::AcqRel, Ordering::Acquire);
    }
}
impl Drop for UniformLease {
    fn drop(&mut self) {
        // An unsubmitted command drops its completion block without calling
        // it. A submitted block is retained by Metal through GPU completion.
        self.retire();
    }
}
pub(crate) struct UniformFrame {
    lease: Arc<UniformLease>,
    cursor: Cell<usize>,
}
impl UniformFrame {
    pub(crate) fn snapshot(&self, bytes: &[u8]) -> Result<(Retained<ProtocolObject<dyn MTLBuffer>>, usize)> {
        let offset = align(self.cursor.get(), 256).ok_or_else(|| uniform_error("Uniform snapshot offset overflow"))?;
        let end = offset.checked_add(bytes.len()).ok_or_else(|| uniform_error("Uniform snapshot size overflow"))?;
        if end > self.lease.slot.buffer.length() {
            return Err(uniform_error("The prepared uniform frame arena is too small"));
        }
        // This token cannot be reused until the exact GPU fence retires it.
        unsafe {std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.lease.slot.buffer.contents().as_ptr().cast::<u8>().add(offset), bytes.len());}
        if self.lease.slot.managed {
            self.lease.slot.buffer.didModifyRange(objc2_foundation::NSRange {location: offset, length: bytes.len()});
        }
        self.cursor.set(end);
        Ok((self.lease.slot.buffer.clone(), offset))
    }
}
fn uniform_error(message: &str) -> FilterChainError {FilterChainError::ExternalInput(message.into())}
fn align(value: usize, boundary: usize) -> Option<usize> {value.checked_add(boundary-1).map(|value|value&!(boundary-1))}

pub(crate) struct UniformSnapshots {
    bytes_per_frame: usize,
    slots: Vec<Arc<UniformSlot>>,
    next: AtomicU64,
}
impl UniformSnapshots {
    pub(crate) fn new(passes: &[crate::filter_pass::FilterPass], feedback: bool) -> Result<Self> {
        let mut bytes = 0usize;
        let mut largest_pass = 0usize;
        for pass in passes {
            let mut pass_bytes = 0usize;
            for size in [pass.reflection.ubo.as_ref().map_or(0, |block|block.size), pass.reflection.push_constant.as_ref().map_or(0, |block|block.size)] {
                if size > 4096 {
                    let size = align(size as usize, 256).ok_or_else(||uniform_error("Uniform block size overflow"))?;
                    pass_bytes = pass_bytes.checked_add(size).ok_or_else(||uniform_error("Uniform pass size overflow"))?;
                }
            }
            largest_pass = largest_pass.max(pass_bytes);
            bytes = bytes.checked_add(pass_bytes).ok_or_else(||uniform_error("Uniform frame size overflow"))?;
        }
        // Runtime passes_enabled can make any prefix's final pass the one
        // drawn twice for feedback. Reserve the largest possible extra draw.
        if feedback {bytes = bytes.checked_add(largest_pass).ok_or_else(||uniform_error("Uniform feedback size overflow"))?;}
        Ok(Self {bytes_per_frame: bytes, slots: Vec::new(), next: AtomicU64::new(1)})
    }
    pub(crate) fn supported(&self) -> bool {self.bytes_per_frame == 0 || !self.slots.is_empty()}
    pub(crate) fn available(&self) -> bool {self.bytes_per_frame == 0 || self.slots.iter().any(|slot|slot.token.load(Ordering::Acquire)==0)}
    pub(crate) fn bytes(&self, capacity: usize) -> u64 {
        if self.bytes_per_frame == 0 {return 0;}
        if capacity == 0 {return u64::MAX;}
        if self.slots.len() >= capacity {
            return self.slots.iter().try_fold(0u64, |sum,slot|sum.checked_add(slot.buffer.allocatedSize() as u64)).unwrap_or(u64::MAX);
        }
        // Before allocation, reserve a conservative device-page bound. After
        // preparation, report actual allocatedSize for physical accounting.
        align(self.bytes_per_frame, 65536).and_then(|bytes|bytes.checked_mul(capacity)).and_then(|bytes|u64::try_from(bytes).ok()).unwrap_or(u64::MAX)
    }
    pub(crate) fn prepare(&mut self, device: &ProtocolObject<dyn MTLDevice>, capacity: usize) -> Result<()> {
        if self.bytes_per_frame == 0 {return Ok(());}
        if capacity == 0 || self.bytes(capacity)==u64::MAX || self.bytes_per_frame>device.maxBufferLength() {
            return Err(uniform_error("The requested uniform snapshot capacity exceeds the device buffer contract"));
        }
        if capacity <= self.slots.len() {return Ok(());}
        let managed = !cfg!(all(target_arch="aarch64",target_vendor="apple"));
        let storage = if managed {MTLResourceOptions::StorageModeManaged} else {MTLResourceOptions::StorageModeShared};
        // Publish additions only after every requested allocation succeeded.
        let mut additions = Vec::with_capacity(capacity-self.slots.len());
        for _ in self.slots.len()..capacity {
            let buffer = device.newBufferWithLength_options(self.bytes_per_frame, storage).ok_or(FilterChainError::BufferError)?;
            additions.push(Arc::new(UniformSlot {buffer, managed, token: AtomicU64::new(0)}));
        }
        self.slots.extend(additions);
        Ok(())
    }
    pub(crate) fn acquire(&self, commands: &ProtocolObject<dyn MTLCommandBuffer>) -> Result<Option<UniformFrame>> {
        if self.bytes_per_frame == 0 {return Ok(None);}
        if self.slots.is_empty() {return Err(uniform_error("Prepare large Slang uniform snapshots before frame encoding"));}
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        if token == 0 {return Err(uniform_error("Uniform snapshot identity exhausted"));}
        let Some(slot) = self.slots.iter().find(|slot|slot.token.compare_exchange(0,token,Ordering::AcqRel,Ordering::Acquire).is_ok()) else {
            return Err(uniform_error("The prepared Slang uniform snapshot capacity is busy"));
        };
        let lease = Arc::new(UniformLease {slot: slot.clone(), token});
        let completion = lease.clone();
        let block = block2::RcBlock::new(move |_commands: std::ptr::NonNull<ProtocolObject<dyn MTLCommandBuffer>>| {completion.retire();});
        unsafe {commands.addCompletedHandler(block2::RcBlock::as_ptr(&block) as _);}
        Ok(Some(UniformFrame {lease, cursor: Cell::new(0)}))
    }
}

pub type ExternalDeclaration = (String, u32);
pub struct ExternalValue {
    pub name: String,
    pub texture: Option<Retained<ProtocolObject<dyn MTLTexture>>>,
    /// Column-major GLSL matrix values. Reflection handles row-major storage.
    pub matrix: Option<[f32; 16]>,
}
pub(crate) fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 512 && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
impl FilterChainMetal {
    /// Whether all original pass blocks use immutable per-encoder uploads.
    pub fn uniform_snapshots_supported(&self) -> bool {
        self.common.uniform_snapshots.supported()
    }
    pub fn uniform_snapshot_bytes(&self, capacity: usize) -> u64 {self.common.uniform_snapshots.bytes(capacity)}
    pub fn prepare_uniform_snapshots(&mut self, capacity: usize) -> Result<()> {self.common.uniform_snapshots.prepare(&self.common.device, capacity)}
    pub fn uniform_snapshots_available(&self) -> bool {self.common.uniform_snapshots.available()}
    pub fn load_from_preset_external(
        preset: ShaderPreset,
        queue: &ProtocolObject<dyn MTLCommandQueue>,
        options: Option<&FilterChainOptionsMetal>,
        declarations: &[ExternalDeclaration],
    ) -> Result<Self> {
        let mut seen = std::collections::HashSet::new();
        if declarations.len() > 128 || declarations.iter().any(|(name, kind)|
            !valid_name(name) || *kind > 1 || !seen.insert(name.as_str())) {
            return Err(FilterChainError::ExternalInput("Invalid external shader declarations".into()));
        }
        let pack = librashader_pack::ShaderPresetPack::load_from_preset::<FilterChainError>(preset)?;
        let commands = queue.commandBuffer().ok_or(FilterChainError::FailedToCreateCommandBuffer)?;
        let chain = Self::load_from_pack_deferred_internal(pack, queue.device(), &commands, options, declarations)?;
        // This is the original chain-creation preparation boundary, never frame encoding.
        commands.commit();
        commands.waitUntilCompleted();
        Ok(chain)
    }
    pub fn set_external_inputs(&mut self, values: Vec<ExternalValue>) -> Result<()> {
        self.common.external_ready = false;
        if values.len() != self.common.external_declarations.len() {
            return Err(FilterChainError::ExternalInput("Every declared shader input needs a current value".into()));
        }
        let mut textures = FastHashMap::default();
        let mut matrices = FastHashMap::default();
        let mut seen = std::collections::HashSet::new();
        for value in values {
            if !seen.insert(value.name.clone()) {
                return Err(FilterChainError::ExternalInput("Duplicate external shader input".into()));
            }
            let Some((index, (_, kind))) = self.common.external_declarations.iter().enumerate()
                .find(|(_, (name, _))| name == &value.name) else {
                return Err(FilterChainError::ExternalInput("Undeclared external shader input".into()));
            };
            if *kind == 0 {
                let Some(texture) = value.texture else {return Err(FilterChainError::ExternalInput("A shader image input is missing".into()));};
                if value.matrix.is_some() || texture.textureType() != MTLTextureType::Type2D || texture.sampleCount() != 1
                    || !std::ptr::eq::<ProtocolObject<dyn MTLDevice>>(texture.device().as_ref(), self.common.device.as_ref())
                    || !texture.usage().contains(MTLTextureUsage::ShaderRead) {
                    return Err(FilterChainError::ExternalInput("Shader inputs need readable resolved images on the current device".into()));
                }
                textures.insert(self.common.luts.len() + index, InputTexture {
                    texture, wrap_mode: WrapMode::ClampToEdge, filter_mode: FilterMode::Nearest, mip_filter: FilterMode::Nearest,
                });
            } else {
                let Some(matrix) = value.matrix else {return Err(FilterChainError::ExternalInput("A shader matrix input is missing".into()));};
                if value.texture.is_some() || matrix.iter().any(|v| !v.is_finite()) {
                    return Err(FilterChainError::ExternalInput("Shader matrices need sixteen finite values".into()));
                }
                matrices.insert(ShortString::from(value.name), matrix);
            }
        }
        self.common.external_textures = textures;
        self.common.external_matrices = matrices;
        self.common.external_ready = true;
        Ok(())
    }
}
