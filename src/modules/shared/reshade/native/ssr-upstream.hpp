// Original Godot 4.4 constants. MIT; see ssr-MIT.txt.
#pragma once
#include <cstdint>
namespace macfx::ssr_host {
struct SceneData {
		float projection[2][16];
		float inv_projection[2][16];
		float eye_offset[2][4];
};
static_assert(sizeof(SceneData)==288,"Original Godot SSR constants changed");
struct Scale {
		int32_t screen_size[2];
		float camera_z_near;
		float camera_z_far;

		uint32_t orthogonal;
		uint32_t filter;
		uint32_t view_index;
		uint32_t pad1;
};
static_assert(sizeof(Scale)==32,"Original Godot SSR constants changed");
struct Main {
		float proj_info[4]; // 16 - 16

		int32_t screen_size[2]; //  8 - 24
		float camera_z_near; //  4 - 28
		float camera_z_far; //  4 - 32

		int32_t num_steps; //  4 - 36
		float depth_tolerance; //  4 - 40
		float distance_fade; //  4 - 44
		float curve_fade_in; //  4 - 48

		uint32_t orthogonal; //  4 - 52
		float filter_mipmap_levels; //  4 - 56
		uint32_t use_half_res; //  4 - 60
		uint32_t view_index; //  4 - 64

		// float projection[16];			// this is in our ScreenSpaceReflectionSceneData now
};
static_assert(sizeof(Main)==64,"Original Godot SSR constants changed");
struct Filter {
		float proj_info[4]; // 16 - 16

		uint32_t orthogonal; //  4 - 20
		float edge_tolerance; //  4 - 24
		int32_t increment; //  4 - 28
		uint32_t view_index; //  4 - 32

		int32_t screen_size[2]; //  8 - 40
		uint32_t vertical; //  4 - 44
		uint32_t steps; //  4 - 48
};
static_assert(sizeof(Filter)==48,"Original Godot SSR constants changed");
}
