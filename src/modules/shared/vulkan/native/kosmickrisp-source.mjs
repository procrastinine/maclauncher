import fs from 'node:fs';
import path from 'node:path';
export function adaptedKosmicSources(sourceRoot) {
const base = path.resolve(sourceRoot);
const edits = new Map();
function edit(name, apply) {
  const relative = 'src/kosmickrisp/' + name;
  const before = edits.get(relative) ?? fs.readFileSync(path.join(base, relative), 'utf8');
  function replace(from, to) {
    if (!before.includes(from)) throw new Error(`${relative}: missing original anchor ${from.slice(0, 100)}`);
    return before.replace(from, to);
  }
  edits.set(relative, apply(before, replace));
}

edit('vulkan/kk_shader.h', (s) => s
  .replace('#include "kk_private.h"', '#include "kk_private.h"\n#include "poly/nir/poly_nir.h"')
  .replace('   /* Required for fragment shader cull distance discards. */', `   /* Poly owns geometry lowering; these data survive original shader caching. */
   bool has_geometry;
   uint64_t original_outputs;
   struct poly_gs_info geometry;
   uint32_t geometry_variant_mask;

   /* Required for fragment shader cull distance discards. */`)
  .replace('         mtl_compute_pipeline_state *pre_render[3];', '         mtl_compute_pipeline_state *pre_render[3];\n         mtl_compute_pipeline_state *geometry[3];')
  .replace('   struct msl_compile_data msl_data[MESA_SHADER_STAGES];', `   struct msl_compile_data msl_data[MESA_SHADER_STAGES];
   /* Main, count and pre-GS compute, with the raster copy in normal stage MSL. */
   struct msl_compile_data geometry_msl[3];`)
  .replace('         bool uses_flat_varyings;', '         bool uses_flat_varyings;\n         uint64_t flat_outputs;'));

edit('vulkan/kk_shader.c', (s) => {
  s = s.replace('   shader->info.stage = nir->info.stage;', '   shader->info.stage = nir->info.stage;\n   shader->info.original_outputs = nir->info.outputs_written;');
  s = s.replace('static bool\nfs_uses_flat_varying(nir_shader *nir)', 'static uint64_t\nfs_flat_output_mask(nir_shader *nir)');
  const maskStart = s.indexOf('fs_flat_output_mask(nir_shader *nir)');
  const maskEnd = s.indexOf('static void\ngather_shader_info',maskStart);
  let mask = s.slice(maskStart,maskEnd);
  mask = mask.replace('{\n   nir_foreach_function_impl', '{\n   uint64_t result = 0;\n   nir_foreach_function_impl')
   .replace('                  return true;', '                  result |= BITFIELD64_BIT(nir_intrinsic_io_semantics(intr).location);')
   .replace('   return false;', '   return result;');
  s = s.slice(0,maskStart) + mask + s.slice(maskEnd);
  s = s.replace('      shader->info.fs.uses_flat_varyings = fs_uses_flat_varying(nir);',
    '      shader->info.fs.flat_outputs = fs_flat_output_mask(nir);\n      shader->info.fs.uses_flat_varyings = shader->info.fs.flat_outputs != 0;');
  const tailStart = s.indexOf('   NIR_PASS(_, nir, kk_nir_lower_poly);', s.indexOf('kk_compile_shader(struct'));
  const tailEnd = s.indexOf('   *shader_out = shader;', tailStart);
  let tail = s.slice(tailStart, tailEnd);
  tail = tail.replace('   struct msl_compile_data *data = &shader->msl_data[stage];\n', '');
  const helper = `/* Metal indirect dispatch rounds to workgroups; Poly receives exact API grids. */
static void
kk_guard_poly_grid(nir_shader *nir, bool geometry)
{
   nir_builder b_ = nir_builder_at(nir_before_impl(nir_shader_get_entrypoint(nir)));
   nir_builder *b = &b_;
   nir_def *base = geometry ? nir_load_geometry_param_buffer_poly(b)
                            : nir_load_vertex_param_buffer_poly(b);
   unsigned offset = geometry ? offsetof(struct poly_geometry_params, grid)
                              : offsetof(struct poly_vertex_params, grid);
   nir_def *grid = nir_load_global(b, 2, 32, nir_iadd_imm(b, base, offset), .align_mul = 4);
   nir_def *id = nir_load_global_invocation_id(b, 32);
   nir_push_if(b, nir_ior(b, nir_uge(b, nir_channel(b, id, 0), nir_channel(b, grid, 0)),
                            nir_uge(b, nir_channel(b, id, 1), nir_channel(b, grid, 1))));
   nir_jump(b, nir_jump_return);
   nir_pop_if(b, NULL);
   nir_progress(true, b->impl, nir_metadata_none);
}

/* Compile all original Poly variants through the same Kosmic MSL owner. */
static void
kk_generate_msl(struct kk_device *dev, nir_shader *nir,
                const struct vk_graphics_pipeline_state *state,
                struct msl_compile_data *data)
{
   struct kk_physical_device *pdev = kk_device_physical(dev);
${tail}}

`;
  s = s.slice(0, tailStart) + `   kk_generate_msl(dev, nir, state, &shader->msl_data[stage]);\n\n` + s.slice(tailEnd);
  s = s.replace('static VkResult\nkk_compile_shader(struct', helper + 'static VkResult\nkk_compile_shader(struct');
  s = s.replace('      if (nir->info.next_stage == MESA_SHADER_TESS_CTRL) {',
    '      if (nir->info.next_stage == MESA_SHADER_TESS_CTRL ||\n          nir->info.next_stage == MESA_SHADER_GEOMETRY) {');
  s = s.replace('      NIR_PASS(_, nir, poly_nir_lower_tes, true);', `      bool before_gs = nir->info.next_stage == MESA_SHADER_GEOMETRY;
      NIR_PASS(_, nir, poly_nir_lower_tes, !before_gs);
      if (before_gs) {
         NIR_PASS(_, nir, nir_lower_io_to_scalar, nir_var_shader_out, NULL, NULL);
         NIR_PASS(_, nir, poly_nir_lower_vs_before_gs);
         nir->info.stage = MESA_SHADER_COMPUTE;
         memset(&nir->info.cs, 0, sizeof(nir->info.cs));
         NIR_PASS(_, nir, poly_nir_lower_sw_vs);
      }`);
  s = s.replace('   kk_generate_msl(dev, nir, state, &shader->msl_data[stage]);', `   if (stage == MESA_SHADER_GEOMETRY) {
      nir_shader *count = NULL, *rast = NULL, *pre = NULL;
      shader->info.has_geometry = true;
      NIR_PASS(_, nir, poly_nir_lower_gs, &count, &rast, &pre,
               &shader->info.geometry);
      nir_shader *variants[] = { nir, count, pre };
      for (unsigned i = 0; i < ARRAY_SIZE(variants); ++i) {
         if (!variants[i]) continue;
         shader->info.geometry_variant_mask |= BITFIELD_BIT(i);
         variants[i]->info.stage = MESA_SHADER_COMPUTE;
         memset(&variants[i]->info.cs, 0, sizeof(variants[i]->info.cs));
         variants[i]->info.workgroup_size[0] = i == 2 ? 1 : 64;
         variants[i]->info.workgroup_size[1] = variants[i]->info.workgroup_size[2] = 1;
         if (i != 2) kk_guard_poly_grid(variants[i], true);
         msl_preprocess_nir(variants[i]);
         kk_generate_msl(dev, variants[i], state, &shader->geometry_msl[i]);
      }
      nir = rast;
      msl_preprocess_nir(nir);
   }
   if (nir->info.stage == MESA_SHADER_COMPUTE &&
       nir->info.next_stage == MESA_SHADER_GEOMETRY)
      kk_guard_poly_grid(nir, false);
   kk_generate_msl(dev, nir, state, &shader->msl_data[stage]);`);
  // A graphics pipeline keeps its own MSL and handles, just like original stage MSL.
  s = s.replace('      info->vs.additional_stages_bits |= BITFIELD_BIT(stage);', `      if (s->info.has_geometry) {
         info->has_geometry = true;
         info->geometry = s->info.geometry;
         info->geometry_variant_mask = s->info.geometry_variant_mask;
         u_foreach_bit(v, info->geometry_variant_mask) {
            vs->geometry_msl[v].code = ralloc_strdup(NULL, s->geometry_msl[v].code);
            vs->geometry_msl[v].entrypoint_name =
               ralloc_strdup(NULL, s->geometry_msl[v].entrypoint_name);
         }
      }
      info->vs.additional_stages_bits |= BITFIELD_BIT(stage);`);
  s = s.replace('   info->vs.topology =', `   if (info->has_geometry) {
      info->vs.topology = info->geometry.mode == MESA_PRIM_POINTS
         ? MTL_PRIMITIVE_TOPOLOGY_CLASS_POINT
         : (info->geometry.mode == MESA_PRIM_LINE_STRIP
            ? MTL_PRIMITIVE_TOPOLOGY_CLASS_LINE
            : MTL_PRIMITIVE_TOPOLOGY_CLASS_TRIANGLE);
      return;
   }
   info->vs.topology =`);
  s = s.replace('   const struct msl_compile_data *vs_data = &vs->msl_data[vs_stage];', `   u_foreach_bit(v, vs->info.geometry_variant_mask) {
      result = kk_compile_compute_pipeline(device, &vs->geometry_msl[v],
         v == 2 ? 1 : 64, &pipe->gfx.geometry[v]);
      if (result != VK_SUCCESS) return result;
   }
   const struct msl_compile_data *vs_data = &vs->msl_data[vs_stage];`);
  s = s.replace('(i == 0u) ? 64u : vs->info.vs.tess_local_thread_size;',
    '(i == 1u) ? vs->info.vs.tess_local_thread_size : 64u;');
  s = s.replace('   bool tess = false;', '   bool tess = false, geometry = false;');
  s = s.replace('         tess = true;\n         break;', '         tess = true;');
  s = s.replace('      const struct vk_shader_compile_info *info = &infos[i];\n      if (info->nir->info.stage == MESA_SHADER_TESS_CTRL',
    '      const struct vk_shader_compile_info *info = &infos[i];\n      geometry |= info->nir->info.stage == MESA_SHADER_GEOMETRY;\n      if (info->nir->info.stage == MESA_SHADER_TESS_CTRL');
  s = s.replace('      bool emulated_stage = tess && (nir->info.stage == MESA_SHADER_VERTEX ||\n                                     nir->info.stage == MESA_SHADER_TESS_CTRL);',
    `      bool emulated_stage = (tess && (nir->info.stage == MESA_SHADER_VERTEX ||
                                     nir->info.stage == MESA_SHADER_TESS_CTRL)) ||
                            (geometry && (nir->info.stage == MESA_SHADER_VERTEX ||
                                          nir->info.stage == MESA_SHADER_TESS_EVAL));`);
  s = s.replace('   struct msl_compile_data *data = &shader->msl_data[shader->info.stage];', `   u_foreach_bit(v, shader->info.geometry_variant_mask) {
      if (shader->info.stage == MESA_SHADER_VERTEX)
         mtl_release(pipe->gfx.geometry[v]);
      ralloc_free(shader->geometry_msl[v].entrypoint_name);
      ralloc_free(shader->geometry_msl[v].code);
   }
   struct msl_compile_data *data = &shader->msl_data[shader->info.stage];`);
  // Original blob layout is extended by the variant payloads, never raw handles.
  const serializeStart = s.indexOf('static void\nkk_msl_serialize');
  const serializeEnd = s.indexOf('static bool\nkk_shader_serialize', serializeStart);
  const oldSerialize = s.slice(serializeStart, serializeEnd);
  const genericSerialize = oldSerialize.replace('kk_msl_serialize(struct kk_shader *shader, mesa_shader_stage stage,\n                 struct blob *blob)',
    'kk_msl_data_serialize(struct msl_compile_data *data, struct blob *blob)')
    .replace('   struct msl_compile_data *data = &shader->msl_data[stage];\n', '');
  s = s.slice(0, serializeStart) + genericSerialize + `static void
kk_msl_serialize(struct kk_shader *shader, mesa_shader_stage stage, struct blob *blob)
{
   kk_msl_data_serialize(&shader->msl_data[stage], blob);
}

` + s.slice(serializeEnd);
  s = s.replace('   return !blob->out_of_memory;', `   u_foreach_bit(v, shader->info.geometry_variant_mask)
      kk_msl_data_serialize(&shader->geometry_msl[v], blob);
   return !blob->out_of_memory;`);
  s = s.replace('kk_msl_deserialize(struct blob_reader *blob, mesa_shader_stage stage,\n                   struct kk_shader *shader)',
    'kk_msl_data_deserialize(struct blob_reader *blob, struct msl_compile_data *data)');
  s = s.replace('   struct msl_compile_data *data = &shader->msl_data[stage];\n   data->entrypoint_name', '   data->entrypoint_name');
  s = s.replace('static VkResult\nkk_deserialize_shader', `static VkResult
kk_msl_deserialize(struct blob_reader *blob, mesa_shader_stage stage, struct kk_shader *shader)
{
   return kk_msl_data_deserialize(blob, &shader->msl_data[stage]);
}

static VkResult
kk_deserialize_shader`);
  s = s.replace('   if (info.stage == MESA_SHADER_COMPUTE) {', `   u_foreach_bit(v, info.geometry_variant_mask) {
      result = kk_msl_data_deserialize(blob, &shader->geometry_msl[v]);
      if (result != VK_SUCCESS) goto fail;
   }
   if (info.stage == MESA_SHADER_COMPUTE) {`);
  s = s.replace('#include "poly/nir/poly_nir.h"', '#include "poly/nir/poly_nir.h"\n#include "poly/geometry.h"');
  s = s.replace('nir_shader *nir_shaders[shader_count + 1u];', 'nir_shader *nir_shaders[shader_count + 2u];');
  s = s.replace('struct kk_shader *shaders[shader_count + 1u];', 'struct kk_shader *shaders[shader_count + 2u];');
  s = s.replace('   bool tess = false, geometry = false;', '   bool tess = false, geometry = false, explicit_geometry = false, xfb = false;');
  s = s.replace('      geometry |= info->nir->info.stage == MESA_SHADER_GEOMETRY;', `      explicit_geometry |= info->nir->info.stage == MESA_SHADER_GEOMETRY;
      xfb |= info->nir->xfb_info != NULL;
      geometry |= info->nir->info.stage == MESA_SHADER_GEOMETRY || info->nir->xfb_info != NULL;`);
  s = s.replace('      /* For tessellation pipelines, some stages may be emulated in compute */', `      if (!explicit_geometry && xfb && nir->xfb_info)
         nir->info.next_stage = MESA_SHADER_GEOMETRY;
      /* For tessellation pipelines, some stages may be emulated in compute */`);
  const emptyOriginal = `   uint32_t total_shaders = shader_count;
   if (state && infos[shader_count - 1u].stage != MESA_SHADER_FRAGMENT) {
      nir_shaders[shader_count] =
         get_empty_nir(dev, MESA_SHADER_FRAGMENT, state, features);
      total_shaders += 1u;
   }`;
  s = s.replace(emptyOriginal, `   uint32_t total_shaders = shader_count;
   if (!explicit_geometry && xfb) {
      nir_shader *producer = NULL;
      unsigned insert = shader_count;
      for (unsigned i = 0; i < shader_count; ++i) {
         if (nir_shaders[i]->xfb_info) producer = nir_shaders[i];
         if (nir_shaders[i]->info.stage == MESA_SHADER_FRAGMENT) insert = i;
      }
      assert(producer && state);
      size_t key_size = poly_passthrough_gs_key_size(producer->xfb_info->output_count);
      struct poly_passthrough_gs_key *key = rzalloc_size(NULL, key_size);
      key->prim = u_decomposed_prim(vk_topology_to_mesa(state->ia->primitive_topology));
      if (tess) {
         key->prim = producer->info.tess.point_mode ? MESA_PRIM_POINTS :
            (producer->info.tess._primitive_mode == TESS_PRIMITIVE_ISOLINES ? MESA_PRIM_LINES : MESA_PRIM_TRIANGLES);
      }
      key->outputs = producer->info.outputs_written;
      key->clip_distance_array_size = producer->info.clip_distance_array_size;
      key->cull_distance_array_size = producer->info.cull_distance_array_size;
      memcpy(key->xfb_stride, producer->info.xfb_stride, sizeof(key->xfb_stride));
      memcpy(&key->xfb_info, producer->xfb_info,
             nir_xfb_info_size(producer->xfb_info->output_count));
      nir_foreach_function_impl(impl, producer) {
         nir_foreach_block(block, impl) {
            nir_foreach_instr(instr, block) {
               if (instr->type != nir_instr_type_intrinsic) continue;
               nir_intrinsic_instr *intr = nir_instr_as_intrinsic(instr);
               if (intr->intrinsic != nir_intrinsic_store_output) continue;
               unsigned slot = nir_intrinsic_io_semantics(intr).location;
               key->output_components[slot] = MAX2(key->output_components[slot],
                  nir_intrinsic_component(intr) + intr->num_components);
               key->output_types[slot] = nir_intrinsic_src_type(intr);
            }
         }
      }
      nir_builder builder = nir_builder_init_simple_shader(MESA_SHADER_GEOMETRY,
         producer->options, "Poly transform feedback passthrough");
      poly_nir_passthrough_gs(&builder, key);
      ralloc_free(key);
      builder.shader->info.io_lowered = true;
      msl_preprocess_nir(builder.shader);
      for (unsigned i = total_shaders; i > insert; --i)
         nir_shaders[i] = nir_shaders[i - 1];
      nir_shaders[insert] = builder.shader;
      ++total_shaders;
   }
   if (state && nir_shaders[total_shaders - 1]->info.stage != MESA_SHADER_FRAGMENT) {
      nir_shaders[total_shaders] = get_empty_nir(dev, MESA_SHADER_FRAGMENT, state, features);
      ++total_shaders;
   }`);
  s = s.replace('   nir_opt_varyings_bulk(nir_shaders, total_shaders, true, UINT32_MAX,', `   /* Preserve upstream XFB side effects through the original varying linker,
    * before Poly lowers those IO stores to Metal device writes. */
   for (unsigned i = 0; i < total_shaders; ++i) {
      if (nir_shaders[i]->xfb_info)
         NIR_PASS(_, nir_shaders[i], nir_io_add_intrinsic_xfb_info);
   }
   nir_opt_varyings_bulk(nir_shaders, total_shaders, true, UINT32_MAX,`);
  s = s.replace(`      /* Free generated fragment shader */
      if (shader_count != total_shaders)
         kk_shader_destroy(&dev->vk, shaders[shader_count], pAllocator);`, `      /* Generated Poly and empty-fragment leaves are already copied into the
       * original vertex pipeline and share its normal lifetime. */`);
  s = s.replace('      for (uint32_t i = 0; i < shader_count; i++) {\n         kk_shader_destroy(&dev->vk, shaders[i], pAllocator);', '      for (uint32_t i = 0; i < total_shaders; i++) {\n         kk_shader_destroy(&dev->vk, shaders[i], pAllocator);');
  s = s.replace('      memcpy(shaders_out, shaders, shader_count * sizeof(*shaders_out));', `      for (unsigned i = 0; i < shader_count; ++i) {
         for (unsigned j = 0; j < total_shaders; ++j)
            if (shaders[j]->vk.stage == infos[i].stage) shaders_out[i] = &shaders[j]->vk;
      }
      for (unsigned j = 0; j < total_shaders; ++j) {
         bool original = false;
         for (unsigned i = 0; i < shader_count; ++i) original |= shaders[j]->vk.stage == infos[i].stage;
         if (!original) kk_shader_destroy(&dev->vk, shaders[j], pAllocator);
      }`);
  return s;
});

edit('vulkan/kk_cmd_buffer.h', s => s.replace('#define KK_CMD_BUFFER_H', '#define KK_CMD_BUFFER_H\n#include "gallium/include/pipe/p_defines.h"').replace('   uint64_t tess_params;', `   uint64_t tess_params;
   uint64_t geometry_params;
   uint32_t provoking_last;
   /* Query destinations are supplied by the command-buffer owner. */
   uint64_t geometry_statistics[PIPE_STAT_QUERY_COUNT];`).replace('   struct kk_per_draw_data per_draw_data;', `   struct kk_per_draw_data per_draw_data;
   struct kk_addr_range xfb[POLY_MAX_SO_BUFFERS];
   uint64_t xfb_offsets;
   uint64_t xfb_query[POLY_MAX_VERTEX_STREAMS];
   uint64_t primitives_query[POLY_MAX_VERTEX_STREAMS];
   bool xfb_enabled;`)
   .replace('#include "gallium/include/pipe/p_defines.h"', '#include "gallium/include/pipe/p_defines.h"\n#include "poly/geometry.h"'));

edit('vulkan/kk_nir_lower_descriptors.c', s => s.replace('   case nir_intrinsic_load_tess_param_buffer_poly:', `   case nir_intrinsic_load_provoking_last: {
      b->cursor = nir_before_instr(&intrin->instr);
      nir_def *word = load_per_draw(b, 1, 32,
         nir_imm_int(b, kk_per_draw_offset(provoking_last)), 4);
      nir_def_replace(&intrin->def, nir_ine_imm(b, word, 0));
      return true;
   }
   case nir_intrinsic_ro_to_rw_poly:
      /* Kosmic uses the same physical Metal GPU address for either access. */
      nir_def_replace(&intrin->def, intrin->src[0].ssa);
      return true;
   case nir_intrinsic_load_geometry_param_buffer_poly:
      return lower_sysval_to_per_draw(b, intrin, geometry_params);
   case nir_intrinsic_load_stat_query_address_poly: {
      b->cursor = nir_before_instr(&intrin->instr);
      unsigned offset = kk_per_draw_offset(geometry_statistics) +
                        nir_intrinsic_base(intrin) * sizeof(uint64_t);
      nir_def_replace(&intrin->def, load_per_draw(b, 1, 64,
                         nir_imm_int(b, offset), 8));
      return true;
   }
   case nir_intrinsic_load_tess_param_buffer_poly:`));

edit('libkk/kk_geometry.cl', s => s + `
/* Original Poly allocation and topology calculations, bound to Metal grids. */
KERNEL(1)
libkk_gs_setup_indirect(uint64_t index_buffer, constant uint32_t *draw,
   global struct poly_vertex_params *vp, global struct poly_geometry_params *p,
   global struct poly_heap *heap, uint64_t vs_outputs, uint32_t index_size_B,
   uint32_t index_buffer_range_el, uint32_t prim, int is_prefix_summing,
   uint32_t max_indices, enum poly_gs_shape shape)
{
   poly_gs_setup_indirect(index_buffer, draw, vp, p, heap, vs_outputs,
      index_size_B, index_buffer_range_el, prim, is_prefix_summing,
      max_indices, shape);
   /* Metal indirect dispatch specifies workgroups, not global threads. */
   vp->grid[3] = (vp->grid[0] + 63) / 64;
   vp->grid[4] = vp->grid[1];
   vp->grid[5] = 1;
   p->grid[3] = (p->grid[0] + 63) / 64;
   p->grid[4] = p->grid[1];
   p->grid[5] = 1;
}

KERNEL(1024)
libkk_prefix_sum_geometry(global struct poly_geometry_params *p)
{
   local uint scratch[32];
   poly_prefix_sum(scratch, p->count_buffer, p->input_primitives,
      p->count_buffer_stride / 4, cl_group_id.x, 1024);
}

KERNEL(1)
libkk_xfb_counter_copy(uint64_t source, uint64_t destination)
{
   *(global uint32_t *)destination = source ? *(global uint32_t *)source : 0;
}

KERNEL(1)
libkk_xfb_draw(constant uint32_t *counter, global uint32_t *draw,
              uint32_t instance_count, uint32_t first_instance,
              uint32_t counter_offset, uint32_t vertex_stride)
{
   draw[0] = max((int)*counter - (int)counter_offset, 0) / vertex_stride;
   draw[1] = instance_count;
   draw[2] = 0;
   draw[3] = first_instance;
}
`);

edit('vulkan/kk_cmd_draw.c', s => {
  s = s.replace('   /* Tessellation will always require per draw data to be submitted. */',
    '   if (vertex && vertex->info.has_geometry)\n      mask |= BITFIELD_BIT(MESA_SHADER_GEOMETRY);\n\n   /* Tessellation will always require per draw data to be submitted. */');
  s = s.replace('      .primitive_type = tess ? 0u : mesa_prim_to_mtl_primitive_type(data->prim),',
    '      .primitive_type = (tess || cmd->state.shaders[MESA_SHADER_GEOMETRY]) ? 0u : mesa_prim_to_mtl_primitive_type(data->prim),');
  const launch = `/* One Metal compute owner executes Poly VS/GS and raster-copy stages. */
static struct kk_draw_data
kk_launch_geometry(struct kk_cmd_buffer *cmd, struct kk_draw_data draw,
                    enum mesa_prim input_prim)
{
   struct kk_device *dev = kk_cmd_buffer_device(cmd);
   struct kk_graphics_state *gfx = &cmd->state.gfx;
   struct kk_shader *vs = cmd->state.shaders[MESA_SHADER_VERTEX];
   struct kk_shader *tes = cmd->state.shaders[MESA_SHADER_TESS_EVAL];
   struct poly_gs_info *info = &vs->info.geometry;
   struct kk_per_draw_data *per_draw = &gfx->per_draw_data;
   struct kk_shader *producer = tes ? tes : vs;
   uint64_t heap = kk_heap(cmd);

   if (tes) input_prim = gfx->tess.prim;

   /* CPU command data is uploaded once; the original setup kernel handles
    * direct, indexed and indirect draws through the same parameter owner. */
   uint64_t input_draw = draw.grid.addr;
   if (!kk_grid_is_indirect(draw.grid)) {
      uint32_t words[5] = { draw.grid.size.x, draw.grid.size.y, 0,
                           draw.vertex_offset, draw.grid.size.z };
      if (!draw.index.el_size_B) {
         words[2] = draw.vertex_offset;
         words[3] = draw.grid.size.z;
      }
      input_draw = kk_pool_upload(cmd, words, sizeof(words), 4).gpu;
   }

   const uint32_t wg_size[3] = {64, 1, 1};
   struct poly_vertex_params vertex;
   poly_vertex_params_init(&vertex, producer->info.original_outputs, wg_size);
   struct poly_geometry_params geometry;
   poly_geometry_params_init(&geometry, input_prim, wg_size);
   struct kk_shader *fs = cmd->state.shaders[MESA_SHADER_FRAGMENT];
   geometry.flat_outputs = fs ? fs->info.fs.flat_outputs : 0;
   per_draw->provoking_last = cmd->vk.dynamic_graphics_state.rs.provoking_vertex == VK_PROVOKING_VERTEX_MODE_LAST_VERTEX_EXT;
   geometry.count_buffer_stride = info->count_words * 4;

   /* Inactive query destinations are valid command-local scratch, as in
    * Honeykrisp. The original Poly programs may update them unconditionally. */
   uint32_t zero[32] = {0};
   uint64_t scratch = kk_pool_upload(cmd, zero, sizeof(zero), 8).gpu;
   for (unsigned i = 0; i < POLY_MAX_VERTEX_STREAMS; ++i) {
      geometry.prims_generated_counter[i] = scratch + 4 * i;
      geometry.xfb_prims_generated_counter[i] = scratch + 16 + 4 * i;
      geometry.xfb_overflow[i] = scratch + 32 + 4 * i;
      geometry.xfb_base_original[i] = scratch;
      geometry.xfb_offs_ptrs[i] = scratch + 48 + 4 * i;
      if (gfx->primitives_query[i])
         geometry.prims_generated_counter[i] = gfx->primitives_query[i];
      if (gfx->xfb_query[i]) {
         geometry.xfb_prims_generated_counter[i] = gfx->xfb_query[i];
         geometry.prims_generated_counter[i] = gfx->xfb_query[i] + sizeof(uint64_t);
      }
      if (gfx->xfb_enabled) {
         geometry.xfb_base_original[i] = gfx->xfb[i].addr;
         geometry.xfb_size[i] = gfx->xfb[i].range;
         geometry.xfb_offs_ptrs[i] = gfx->xfb_offsets + i * sizeof(uint32_t);
      }
   }
   geometry.xfb_any_overflow = scratch + 64;
   for (unsigned i = 0; i < PIPE_STAT_QUERY_COUNT; ++i)
      per_draw->geometry_statistics[i] = scratch + 72;
   if (geometry.count_buffer_stride && !info->prefix_sum)
      geometry.count_buffer = scratch + 80;

   struct kk_ptr vp = kk_pool_upload(cmd, &vertex, sizeof(vertex), 8);
   struct kk_ptr gp = kk_pool_upload(cmd, &geometry, sizeof(geometry), 8);
   per_draw->vertex_params = vp.gpu;
   per_draw->geometry_params = gp.gpu;
   per_draw->vertex_outputs = producer->info.original_outputs;
   per_draw->index_size = draw.index.el_size_B;
   per_draw->base_vertex_addr = upload_base_vertex(cmd, &draw);
   per_draw->base_instance_addr = upload_base_instance(cmd, &draw);
   struct kk_ptr data = kk_pool_upload(cmd, per_draw, sizeof(*per_draw), 8);
   mtl_set_address(cmd->argument_table, data.gpu, 2);

   struct libkk_gs_setup_indirect_args setup = {
      .index_buffer = draw.index.gpu.addr,
      .draw = input_draw, .vp = vp.gpu, .p = gp.gpu, .heap = heap,
      .vs_outputs = producer->info.original_outputs,
      .index_size_B = draw.index.el_size_B,
      .index_buffer_range_el = draw.index.el_size_B
         ? draw.index.gpu.range / draw.index.el_size_B : 0,
      .prim = input_prim, .is_prefix_summing = info->prefix_sum,
      .max_indices = info->max_indices, .shape = info->shape,
   };
   libkk_gs_setup_indirect_struct(cmd, kk_grid_1d(1), true, setup);
   mtl_compute_encoder *enc = cs_get_compute(cmd);
   struct mtl_size local = {64, 1, 1};
   mtl_barrier_after_encoder_stages(enc, MTL_STAGE_DISPATCH, MTL_STAGE_DISPATCH);
   mtl_compute_set_pipeline_state(enc, vs->pipeline.gfx.pre_render[tes ? 2 : 0]);
   kk_dispatch_compute(enc, kk_grid_indirect(vp.gpu +
      offsetof(struct poly_vertex_params, grid) + 3 * sizeof(uint32_t)), local);

   bool queries = false;
   for (unsigned i = 0; i < POLY_MAX_VERTEX_STREAMS; ++i)
      queries |= gfx->xfb_query[i] || gfx->primitives_query[i];
   if (info->xfb || queries) {
      if (info->count_words) {
         mtl_barrier_after_encoder_stages(enc, MTL_STAGE_DISPATCH, MTL_STAGE_DISPATCH);
         mtl_compute_set_pipeline_state(enc, vs->pipeline.gfx.geometry[1]);
         kk_dispatch_compute(enc, kk_grid_indirect(gp.gpu +
            offsetof(struct poly_geometry_params, grid) + 3 * sizeof(uint32_t)), local);
      }
      if (info->prefix_sum)
         libkk_prefix_sum_geometry(cmd, kk_grid_1d(1024 * info->count_words), true, gp.gpu);
      enc = cs_get_compute(cmd);
      mtl_barrier_after_encoder_stages(enc, MTL_STAGE_DISPATCH, MTL_STAGE_DISPATCH);
      mtl_compute_set_pipeline_state(enc, vs->pipeline.gfx.geometry[2]);
      kk_dispatch_compute(enc, kk_grid_1d(1), (struct mtl_size){1, 1, 1});
   }

   mtl_barrier_after_encoder_stages(enc, MTL_STAGE_DISPATCH, MTL_STAGE_DISPATCH);
   mtl_compute_set_pipeline_state(enc, vs->pipeline.gfx.geometry[0]);
   kk_dispatch_compute(enc, kk_grid_indirect(gp.gpu +
      offsetof(struct poly_geometry_params, grid) + 3 * sizeof(uint32_t)), local);
   mtl_barrier_after_encoder_stages(enc, MTL_STAGE_DISPATCH, MTL_STAGE_ALL);

   draw.grid = kk_grid_indirect(gp.gpu + offsetof(struct poly_geometry_params, draw));
   draw.vertex_offset = 0;
   memset(&draw.index, 0, sizeof(draw.index));
   if (info->shape == POLY_GS_SHAPE_DYNAMIC_INDEXED) {
      draw.index.el_size_B = 4;
      draw.index.gpu.addr = dev->heap->gpu + sizeof(struct poly_heap);
      draw.index.gpu.range = dev->heap->size_B - sizeof(struct poly_heap);
   } else if (info->shape == POLY_GS_SHAPE_STATIC_INDEXED) {
      /* Metal has no 8-bit index type. Preserve every original topology value,
       * expanding the original restart marker to the real 16-bit marker. */
      uint16_t topology[64];
      for (unsigned i = 0; i < info->max_indices; ++i)
         topology[i] = info->topology[i] == 0xff ? 0xffff : info->topology[i];
      draw.index.el_size_B = 2;
      draw.index.gpu.addr = kk_pool_upload(cmd, topology, info->max_indices * 2, 2).gpu;
      draw.index.gpu.range = info->max_indices * 2;
   }
   draw.primitive_type = mesa_prim_to_mtl_primitive_type(info->mode);
   return draw;
}

`;
  s = s.replace('/* Get modifiable per draw data. */', launch + '/* Get modifiable per draw data. */');
  s = s.replace('      if (tess)\n         draw_data = kk_launch_tess(cmd, draw_data);',
    '      if (tess)\n         draw_data = kk_launch_tess(cmd, draw_data);\n      if (cmd->state.shaders[MESA_SHADER_VERTEX]->info.has_geometry)\n         draw_data = kk_launch_geometry(cmd, draw_data, data->prim);');
  s += `
VKAPI_ATTR void VKAPI_CALL
kk_CmdBindTransformFeedbackBuffersEXT(VkCommandBuffer commandBuffer,
   uint32_t firstBinding, uint32_t bindingCount, const VkBuffer *pBuffers,
   const VkDeviceSize *pOffsets, const VkDeviceSize *pSizes)
{
   VK_FROM_HANDLE(kk_cmd_buffer, cmd, commandBuffer);
   for (unsigned i = 0; i < bindingCount; ++i) {
      VK_FROM_HANDLE(kk_buffer, buffer, pBuffers[i]);
      cmd->state.gfx.xfb[firstBinding + i] = kk_buffer_addr_range(buffer,
         pOffsets[i], pSizes ? pSizes[i] : VK_WHOLE_SIZE);
   }
}

static void
kk_begin_end_xfb(VkCommandBuffer commandBuffer, uint32_t first,
   uint32_t count, const VkBuffer *buffers, const VkDeviceSize *offsets, bool begin)
{
   VK_FROM_HANDLE(kk_cmd_buffer, cmd, commandBuffer);
   struct kk_graphics_state *gfx = &cmd->state.gfx;
   gfx->xfb_enabled = begin;
   if (!gfx->xfb_offsets)
      gfx->xfb_offsets = kk_pool_alloc(cmd, POLY_MAX_SO_BUFFERS * 4, 4).gpu;
   for (unsigned i = 0; i < (begin ? POLY_MAX_SO_BUFFERS : count); ++i) {
      unsigned slot = begin ? i : first + i;
      bool selected = slot >= first && slot - first < count && buffers &&
                      buffers[slot - first] != VK_NULL_HANDLE;
      uint64_t source = 0, destination = gfx->xfb_offsets + slot * 4;
      if (selected) {
         VK_FROM_HANDLE(kk_buffer, buffer, buffers[slot - first]);
         source = vk_buffer_address(&buffer->vk, offsets ? offsets[slot - first] : 0);
      }
      if (!begin) {
         if (!selected) continue;
         uint64_t tmp = destination; destination = source; source = tmp;
      }
      libkk_xfb_counter_copy(cmd, kk_grid_1d(1), true, source, destination);
   }
}

VKAPI_ATTR void VKAPI_CALL
kk_CmdBeginTransformFeedbackEXT(VkCommandBuffer commandBuffer, uint32_t first,
   uint32_t count, const VkBuffer *buffers, const VkDeviceSize *offsets)
{
   kk_begin_end_xfb(commandBuffer, first, count, buffers, offsets, true);
}

VKAPI_ATTR void VKAPI_CALL
kk_CmdEndTransformFeedbackEXT(VkCommandBuffer commandBuffer, uint32_t first,
   uint32_t count, const VkBuffer *buffers, const VkDeviceSize *offsets)
{
   kk_begin_end_xfb(commandBuffer, first, count, buffers, offsets, false);
}

VKAPI_ATTR void VKAPI_CALL
kk_CmdDrawIndirectByteCountEXT(VkCommandBuffer commandBuffer,
   uint32_t instanceCount, uint32_t firstInstance, VkBuffer counterBuffer,
   VkDeviceSize counterBufferOffset, uint32_t counterOffset, uint32_t vertexStride)
{
   VK_FROM_HANDLE(kk_cmd_buffer, cmd, commandBuffer);
   VK_FROM_HANDLE(kk_buffer, counter, counterBuffer);
   uint64_t draw = kk_pool_alloc(cmd, sizeof(VkDrawIndirectCommand), 4).gpu;
   libkk_xfb_draw(cmd, kk_grid_1d(1), true,
      vk_buffer_address(&counter->vk, counterBufferOffset), draw,
      instanceCount, firstInstance, counterOffset, vertexStride);
   const struct vk_dynamic_graphics_state *dyn = &cmd->vk.dynamic_graphics_state;
   struct kk_draw_command data = {
      .prim = vk_topology_to_mesa(dyn->ia.primitive_topology),
      .upload_mask = build_per_draw_upload_mask(cmd),
      .draw_count = 1, .indirect = true,
      .indirect_command = { .addr = draw, .stride = sizeof(VkDrawIndirectCommand) },
   };
   kk_draw(cmd, &data);
}
`;
  return s;
});

edit('vulkan/kk_query_pool.c', s => {
  s = s.replace('   case VK_QUERY_TYPE_TIMESTAMP:\n      return 1;', `   case VK_QUERY_TYPE_TIMESTAMP:
   case VK_QUERY_TYPE_PRIMITIVES_GENERATED_EXT:
      return 1;
   case VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT:
      return 2;`);
  s = s.replaceAll('   uint32_t index =\n      kk_pool_is_ts(pool) ? query : kk_pool_index_ptr(pool)[query];', `   uint32_t index = kk_pool_is_oq(pool) ? kk_pool_index_ptr(pool)[query]
                                                : query * kk_reports_per_query(pool);`);
  s = s.replaceAll('kk_pool_is_ts(pool) ? 0u : pool->bo->gpu + pool->index_start',
    'kk_pool_is_oq(pool) ? pool->bo->gpu + pool->index_start : 0u');
  s = s.replace(`VKAPI_ATTR void VKAPI_CALL
kk_CmdBeginQuery(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
                 uint32_t query, VkQueryControlFlags flags)`, `static void
kk_begin_query(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
               uint32_t query, VkQueryControlFlags flags, uint32_t index)`);
  s = s.replace('   cmd->state.gfx.occlusion.mode = flags & VK_QUERY_CONTROL_PRECISE_BIT', `   if (pool->vk.query_type == VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT) {
      cmd->state.gfx.xfb_query[index] = kk_query_report_addr(kk_cmd_buffer_device(cmd), pool, query);
      return;
   }
   if (pool->vk.query_type == VK_QUERY_TYPE_PRIMITIVES_GENERATED_EXT) {
      cmd->state.gfx.primitives_query[index] = kk_query_report_addr(kk_cmd_buffer_device(cmd), pool, query);
      return;
   }
   cmd->state.gfx.occlusion.mode = flags & VK_QUERY_CONTROL_PRECISE_BIT`);
  s = s.replace(`VKAPI_ATTR void VKAPI_CALL
kk_CmdEndQuery(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
               uint32_t query)`, `static void
kk_end_query(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
             uint32_t query, uint32_t index)`);
  s = s.replace(`   cmd->state.gfx.occlusion.mode = MTL_VISIBILITY_RESULT_MODE_DISABLED;
   cmd->state.gfx.dirty |= KK_DIRTY_OCCLUSION;`, `   if (pool->vk.query_type == VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT) {
      cmd->state.gfx.xfb_query[index] = 0;
   } else if (pool->vk.query_type == VK_QUERY_TYPE_PRIMITIVES_GENERATED_EXT) {
      cmd->state.gfx.primitives_query[index] = 0;
   } else {
      cmd->state.gfx.occlusion.mode = MTL_VISIBILITY_RESULT_MODE_DISABLED;
      cmd->state.gfx.dirty |= KK_DIRTY_OCCLUSION;
   }`);
  s += `
VKAPI_ATTR void VKAPI_CALL
kk_CmdBeginQuery(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
   uint32_t query, VkQueryControlFlags flags)
{
   kk_begin_query(commandBuffer, queryPool, query, flags, 0);
}
VKAPI_ATTR void VKAPI_CALL
kk_CmdEndQuery(VkCommandBuffer commandBuffer, VkQueryPool queryPool, uint32_t query)
{
   kk_end_query(commandBuffer, queryPool, query, 0);
}
VKAPI_ATTR void VKAPI_CALL
kk_CmdBeginQueryIndexedEXT(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
   uint32_t query, VkQueryControlFlags flags, uint32_t index)
{
   kk_begin_query(commandBuffer, queryPool, query, flags, index);
}
VKAPI_ATTR void VKAPI_CALL
kk_CmdEndQueryIndexedEXT(VkCommandBuffer commandBuffer, VkQueryPool queryPool,
   uint32_t query, uint32_t index)
{
   kk_end_query(commandBuffer, queryPool, query, index);
}
`;
  return s;
});

// The adapted provider owns Poly geometry and transform-feedback execution.
edit('vulkan/kk_debug.c', s => s.replace('experimental_flags, 0);', 'experimental_flags, KK_EXPERIMENTAL_CUSTOM_BORDER);'));

edit('vulkan/kk_physical_device.c', s => s
 .replace('      /* Optional extensions */', `      .EXT_transform_feedback = true,
      .EXT_primitives_generated_query = true,
      /* Optional extensions */`)
 .replace('      .tessellationShader = true,', `      .tessellationShader = true,
      .geometryShader = true,
      .transformFeedback = true,
      .geometryStreams = false,
      .primitivesGeneratedQuery = true,
      .primitivesGeneratedQueryWithRasterizerDiscard = true,
      .primitivesGeneratedQueryWithNonZeroStreams = false,`)
 .replace('      .transformFeedbackRasterizationStreamSelect = true,', '      .transformFeedbackRasterizationStreamSelect = false,'));

return Object.fromEntries(edits);
}
