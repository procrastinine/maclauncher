// SPDX-License-Identifier: LGPL-2.1-or-later
// This build includes binary shader translation; HLSL/effect authoring is excluded.
#include "vkd3d_shader_private.h"
int preproc_lexer_parse(const struct vkd3d_shader_compile_info *info,struct vkd3d_shader_code *out,struct vkd3d_shader_message_context *messages){return VKD3D_ERROR_NOT_IMPLEMENTED;}
int hlsl_compile_effect(const struct vkd3d_shader_compile_info *info,struct vkd3d_shader_message_context *messages,struct vkd3d_shader_code *out){return VKD3D_ERROR_NOT_IMPLEMENTED;}
int hlsl_parse(const struct vkd3d_shader_compile_info *info,struct vkd3d_shader_message_context *messages,struct vsir_program *program,struct vkd3d_shader_code *reflection){return VKD3D_ERROR_NOT_IMPLEMENTED;}

int fx_parse(const struct vkd3d_shader_compile_info *info,struct vkd3d_shader_code *out,struct vkd3d_shader_message_context *messages){return VKD3D_ERROR_NOT_IMPLEMENTED;}
int tx_parse(const struct vkd3d_shader_compile_info *info,struct vkd3d_shader_code *out,struct vkd3d_shader_message_context *messages){return VKD3D_ERROR_NOT_IMPLEMENTED;}
