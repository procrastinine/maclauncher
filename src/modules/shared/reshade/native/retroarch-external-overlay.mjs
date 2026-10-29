import fs from 'node:fs';
import path from 'node:path';
const owned=relative=>fs.readFileSync(new URL(relative,import.meta.url),'utf8');
// Apply only to an owned immutable export of the exact declared upstream pin.
export function applyRetroarchExternalOverlay(root){
  function edit(file,old,replacement,count=1){
    const target=path.join(root,file),text=fs.readFileSync(target,'utf8');
    if(text.split(old).length-1!==count)throw Error('The pinned Slang external-input boundary changed: '+file);
    fs.writeFileSync(target,text.replaceAll(old,replacement));
  }
  const mtl='librashader-runtime-mtl/src/';
  edit('librashader-runtime-mtl/Cargo.toml','thiserror = "2"','thiserror = "2"\nblock2 = "=0.6.2"');
  edit('Cargo.lock','name = "librashader-runtime-mtl"\nversion = "0.12.1"\ndependencies = [\n "array-concat",',
    'name = "librashader-runtime-mtl"\nversion = "0.12.1"\ndependencies = [\n "array-concat",\n "block2 0.6.2",');
  fs.copyFileSync(new URL('./retroarch-external/external.rs',import.meta.url),path.join(root,mtl,'external.rs'));
  edit(mtl+'lib.rs','mod filter_chain;','mod filter_chain;\nmod external;\npub use external::{ExternalDeclaration, ExternalValue};');
  edit('librashader/src/lib.rs','            FilterChainMetal as FilterChain, MetalTextureRef,',
    '            FilterChainMetal as FilterChain, MetalTextureRef, ExternalDeclaration, ExternalValue,');
  edit(mtl+'error.rs','pub enum FilterChainError {','pub enum FilterChainError {\n    #[error("external shader input: {0}")]\n    ExternalInput(String),');
  edit(mtl+'filter_chain.rs','    passes: Box<[FilterPass]>,','    pub(crate) passes: Box<[FilterPass]>,');
  edit(mtl+'filter_chain.rs','device: Retained<ProtocolObject<dyn MTLDevice>>,\n}',`pub(crate) device: Retained<ProtocolObject<dyn MTLDevice>>,
    pub(crate) external_declarations: Vec<crate::external::ExternalDeclaration>,
    pub(crate) external_textures: FastHashMap<usize, InputTexture>,
    pub(crate) external_matrices: FastHashMap<librashader_common::map::ShortString, [f32;16]>,
    pub(crate) external_ready: bool,
    pub(crate) uniform_snapshots: crate::external::UniformSnapshots,
}`);
  edit(mtl+'filter_chain.rs','textures: &[TextureResource],\n    ) -> Result<(Vec<ShaderPassMeta>, ShaderSemantics), FilterChainError> {',
    'textures: &[TextureResource],\n        external: &[crate::external::ExternalDeclaration],\n    ) -> Result<(Vec<ShaderPassMeta>, ShaderSemantics), FilterChainError> {');
  edit(mtl+'filter_chain.rs','let (passes, semantics) = MSL::compile_preset_passes::<','let (passes, mut semantics) = MSL::compile_preset_passes::<');
  edit(mtl+'filter_chain.rs','        Ok((passes, semantics))',`        use librashader_reflect::reflect::semantics::{TextureSemanticMap, UniqueSemanticMap, TextureSemantics, UniformSemantic};
        use librashader_common::map::ShortString;
        for (index, (name, kind)) in external.iter().enumerate() {
            if semantics.texture_semantics.texture_semantic(name).is_some()
                || semantics.uniform_semantics.unique_semantic(name).is_some()
                || semantics.uniform_semantics.contains_key(name.as_str())
                || semantics.texture_semantics.contains_key(name.as_str()) {
                return Err(FilterChainError::ExternalInput(format!("External input conflicts with original shader semantics: {name}")));
            }
            if *kind == 0 {
                let size = format!("{name}Size");
                if semantics.uniform_semantics.contains_key(size.as_str()) || semantics.uniform_semantics.unique_semantic(&size).is_some() {
                    return Err(FilterChainError::ExternalInput(format!("External input size conflicts with shader semantics: {size}")));
                }
                let binding = TextureSemantics::User.semantics(textures.len() + index);
                semantics.texture_semantics.insert(ShortString::from(name.as_str()), binding);
                semantics.uniform_semantics.insert(ShortString::from(size), UniformSemantic::Texture(binding));
            } else {
                semantics.uniform_semantics.insert(ShortString::from(name.as_str()), UniformSemantic::ExternalMatrix);
            }
        }
        Ok((passes, semantics))`);
  edit(mtl+'filter_chain.rs','Self::load_from_pack_deferred_internal(preset, queue.device(), &cmd, options)',
    'Self::load_from_pack_deferred_internal(preset, queue.device(), &cmd, options, &[])',2);
  edit(mtl+'filter_chain.rs','    fn load_from_pack_deferred_internal(','    pub(crate) fn load_from_pack_deferred_internal(');
  edit(mtl+'filter_chain.rs',`        options: Option<&FilterChainOptionsMetal>,
    ) -> error::Result<FilterChainMetal> {
        let config = RuntimeParameters::new(&preset);
        let (passes, semantics) = compile_passes(preset.passes, &preset.textures)?;`,
    `        options: Option<&FilterChainOptionsMetal>,
        external: &[crate::external::ExternalDeclaration],
    ) -> error::Result<FilterChainMetal> {
        let config = RuntimeParameters::new(&preset);
        let (passes, semantics) = compile_passes(preset.passes, &preset.textures, external)?;`);
  edit(mtl+'filter_chain.rs','            common: FilterCommon {\n                luts,',`            common: FilterCommon {
                uniform_snapshots: crate::external::UniformSnapshots::new(&filters, framebuffer_init.uses_final_pass_as_feedback())?,
                external_declarations: external.to_vec(),
                external_textures: FastHashMap::default(),
                external_matrices: FastHashMap::default(),
                external_ready: external.is_empty(),
                luts,`);
  edit(mtl+'filter_chain.rs','        let max = std::cmp::min(self.passes.len(), self.common.config.passes_enabled());',`        let uniform_frame = self.common.uniform_snapshots.acquire(cmd)?;
        if !self.common.external_declarations.is_empty() {
            if !self.common.external_ready {return Err(FilterChainError::ExternalInput("Current scene inputs were not supplied for this frame".into()));}
            self.common.external_ready = false;
        }
        let max = std::cmp::min(self.passes.len(), self.common.config.passes_enabled());`);
  edit(mtl+'filter_pass.rs','            parent.luts.iter().map(|(u, i)| (*u, i.as_ref())),',
    '            parent.luts.iter().map(|(u, i)| (*u, i.as_ref())).chain(parent.external_textures.iter().map(|(u,i)|(*u,i))),');
  edit(mtl+'filter_pass.rs',`        if let Some(ubo) = &self.reflection.ubo {
            unsafe {`, `        if let Some(ubo) = &self.reflection.ubo {
            if ubo.size > 0 && ubo.size <= 4096 {unsafe {
                let bytes=std::ptr::NonNull::new_unchecked(self.uniform_storage.inner_ubo().as_ptr().cast_mut().cast());
                cmd.setVertexBytes_length_atIndex(bytes,ubo.size as usize,ubo.binding as usize);
                cmd.setFragmentBytes_length_atIndex(bytes,ubo.size as usize,ubo.binding as usize);
            }} else {unsafe {`);
  edit(mtl+'filter_pass.rs',`                cmd.setVertexBuffer_offset_atIndex(
                    Some(self.uniform_storage.inner_ubo().as_ref()),
                    0,
                    ubo.binding as usize,
                );
                cmd.setFragmentBuffer_offset_atIndex(
                    Some(self.uniform_storage.inner_ubo().as_ref()),
                    0,
                    ubo.binding as usize,
                )`, `                if ubo.size > 4096 {
                    let frame=uniform_frame.ok_or_else(||crate::error::FilterChainError::ExternalInput("Large uniform snapshots were not prepared".into()))?;
                    let (buffer,offset)=frame.snapshot(&self.uniform_storage.inner_ubo()[..ubo.size as usize])?;
                    cmd.setVertexBuffer_offset_atIndex(Some(&buffer),offset,ubo.binding as usize);
                    cmd.setFragmentBuffer_offset_atIndex(Some(&buffer),offset,ubo.binding as usize);
                }`);
  edit(mtl+'filter_pass.rs',`        if let Some(pcb) = &self.reflection.push_constant {
            unsafe {`, `        }
        if let Some(pcb) = &self.reflection.push_constant {
            if pcb.size > 0 && pcb.size <= 4096 {unsafe {
                let bytes=std::ptr::NonNull::new_unchecked(self.uniform_storage.inner_push().as_ptr().cast_mut().cast());
                cmd.setVertexBytes_length_atIndex(bytes,pcb.size as usize,pcb.binding.unwrap_or(1) as usize);
                cmd.setFragmentBytes_length_atIndex(bytes,pcb.size as usize,pcb.binding.unwrap_or(1) as usize);
            }} else {unsafe {`);
  edit(mtl+'filter_pass.rs',`                cmd.setVertexBuffer_offset_atIndex(
                    Some(self.uniform_storage.inner_push().as_ref()),
                    0,
                    pcb.binding.unwrap_or(1) as usize,
                );
                cmd.setFragmentBuffer_offset_atIndex(
                    Some(self.uniform_storage.inner_push().as_ref()),
                    0,
                    pcb.binding.unwrap_or(1) as usize,
                )`, `                if pcb.size > 4096 {
                    let frame=uniform_frame.ok_or_else(||crate::error::FilterChainError::ExternalInput("Large push snapshots were not prepared".into()))?;
                    let (buffer,offset)=frame.snapshot(&self.uniform_storage.inner_push()[..pcb.size as usize])?;
                    cmd.setVertexBuffer_offset_atIndex(Some(&buffer),offset,pcb.binding.unwrap_or(1) as usize);
                    cmd.setFragmentBuffer_offset_atIndex(Some(&buffer),offset,pcb.binding.unwrap_or(1) as usize);
                }`);
  edit(mtl+'filter_pass.rs','        pass_index: usize,','        uniform_frame: Option<&crate::external::UniformFrame>,\n        pass_index: usize,',2);
  // build_semantics does not retain/use the arena; only the exact draw owns it.
  edit(mtl+'filter_pass.rs','    fn build_semantics<\'a>(\n        &mut self,\n        uniform_frame: Option<&crate::external::UniformFrame>,','    fn build_semantics<\'a>(\n        &mut self,');
  edit(mtl+'filter_chain.rs','                        &cmd,\n                        index,','                        &cmd,\n                        uniform_frame.as_ref(),\n                        index,',2);
  edit(mtl+'filter_chain.rs','                    &cmd,\n                    index,','                    &cmd,\n                    uniform_frame.as_ref(),\n                    index,');
  edit(mtl+'filter_pass.rs','        parent.draw_quad.draw_quad(&cmd, vbo_type);','        }\n        parent.draw_quad.draw_quad(&cmd, vbo_type);');
  edit(mtl+'filter_pass.rs','        // flush to buffers',`        for (name, meta) in &self.reflection.meta.external_matrix_meta {
            if let Some(matrix) = parent.external_matrices.get(name) {
                let transpose = |value: &[f32;16]| {let mut result=[0.0;16];for y in 0..4 {for x in 0..4 {result[y*4+x]=value[x*4+y];}}result};
                let transposed = transpose(matrix);
                let offset = meta.variable.offset;
                self.uniform_storage.bind_mat4(MemberOffset {ubo:offset.ubo,push:None},if meta.ubo_row_major {&transposed} else {matrix},None,&());
                self.uniform_storage.bind_mat4(MemberOffset {ubo:None,push:offset.push},if meta.push_row_major {&transposed} else {matrix},None,&());
            }
        }
        // flush to buffers`);
  edit(mtl+'filter_pass.rs','            renderpass.setFragmentTexture_atIndex(Some(&texture.texture), binding.binding as usize);',
    '            renderpass.setVertexTexture_atIndex(Some(&texture.texture), binding.binding as usize);\n            renderpass.setVertexSamplerState_atIndex(Some(sampler), binding.binding as usize);\n            renderpass.setFragmentTexture_atIndex(Some(&texture.texture), binding.binding as usize);');
  const semantics='librashader-reflect/src/reflect/semantics.rs';
  edit(semantics,'    Texture(Semantic<TextureSemantics>),\n}',
    '    Texture(Semantic<TextureSemantics>),\n    /// Explicit read-only external float4x4 input.\n    ExternalMatrix,\n}');
  edit(semantics,'            Some(UniformSemantic::Unique(_)) => None,','            Some(UniformSemantic::Unique(_) | UniformSemantic::ExternalMatrix) => None,');
  edit(semantics,'            Some(UniformSemantic::Texture(_)) => None,','            Some(UniformSemantic::Texture(_) | UniformSemantic::ExternalMatrix) => None,');
  edit(semantics,'pub struct BindingMeta {',`pub struct BindingMeta {
    #[cfg_attr(feature = "serde", serde(default))]
    pub external_matrix_meta: FastHashMap<ShortString, ExternalMatrixMeta>,`);
  edit(semantics,'/// Reflection metadata about the various bindings for this shader.',`#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ExternalMatrixMeta {
    pub variable: VariableMeta,
    pub ubo_row_major: bool,
    pub push_row_major: bool,
}
/// Reflection metadata about the various bindings for this shader.`);
  const cross='librashader-reflect/src/reflect/cross/mod.rs';
  edit(cross,'            if let Some(parameter) = semantics.uniform_semantics.unique_semantic(&name) {',`            if matches!(semantics.uniform_semantics.get(name.as_ref()), Some(crate::reflect::semantics::UniformSemantic::ExternalMatrix)) {
                let Some(info) = UniqueSemantics::MVP.validate_type(&range_type.inner) else {
                    return Err(blame.error(SemanticsErrorKind::InvalidTypeForSemantic(name.to_string())));
                };
                let stride = ast.member_decoration_by_handle(resource.base_type_id,range.index,Decoration::MatrixStride)?.and_then(|v|v.as_literal());
                // Original TypeInfo sizes count scalar elements, not bytes.
                if info.size * info.columns != 16 || stride != Some(16) {
                    return Err(blame.error(SemanticsErrorKind::InvalidTypeForSemantic(name.to_string())));
                }
                let row_major=ast.member_decoration_by_handle(resource.base_type_id,range.index,Decoration::RowMajor)?.is_some();
                let key=ShortString::from(name.as_ref());
                let entry=meta.external_matrix_meta.entry(key.clone()).or_insert_with(||crate::reflect::semantics::ExternalMatrixMeta {
                    variable:VariableMeta {id:key,offset:MemberOffset {ubo:None,push:None},size:64},ubo_row_major:false,push_row_major:false
                });
                if let Some(expected)=entry.variable.offset.offset(offset_type) {
                    let expected_order=match offset_type {UniformMemberBlock::Ubo=>entry.ubo_row_major,UniformMemberBlock::PushConstant=>entry.push_row_major};
                    if expected != range.offset || expected_order != row_major {
                        return Err(blame.error(SemanticsErrorKind::InvalidTypeForSemantic(name.to_string())));
                    }
                }
                *entry.variable.offset.offset_mut(offset_type)=Some(range.offset);
                match offset_type {UniformMemberBlock::Ubo=>entry.ubo_row_major=row_major,UniformMemberBlock::PushConstant=>entry.push_row_major=row_major}
            } else if let Some(parameter) = semantics.uniform_semantics.unique_semantic(&name) {`);
  const capi='librashader-capi/src/runtime/mtl/filter_chain.rs';
  fs.appendFileSync(path.join(root,capi),'\n'+owned('./retroarch-external/capi.rs'));
}
