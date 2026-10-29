#version 450
// One draw-graph operation captures the complete scene tuple and requested
// attachments. Its radiance output orders the later identity return copy.
layout(local_size_x=8,local_size_y=8,local_size_z=1) in;
layout(set=0,binding=0) uniform sampler2D source_color;
layout(set=0,binding=1) uniform sampler2D source_depth;
layout(set=0,binding=2) uniform sampler2D source_motion;
#ifdef CAPTURE_NORMAL
layout(set=0,binding=3) uniform sampler2D source_normal;
layout(rgba8,set=0,binding=8) uniform writeonly image2D target_normal;
#endif
#ifdef CAPTURE_SPECULAR
layout(set=0,binding=4) uniform sampler2D source_specular;
layout(rgba16f,set=0,binding=9) uniform writeonly image2D target_specular;
#endif
layout(rgba16f,set=0,binding=5) uniform writeonly image2D target_radiance;
layout(r32f,set=0,binding=6) uniform writeonly image2D target_depth;
layout(rg16f,set=0,binding=7) uniform writeonly image2D target_motion;
void main(){
    ivec2 p=ivec2(gl_GlobalInvocationID.xy);
    if(any(greaterThanEqual(p,imageSize(target_radiance))))return;
    imageStore(target_radiance,p,texelFetch(source_color,p,0));
    imageStore(target_depth,p,vec4(texelFetch(source_depth,p,0).r,0.0,0.0,0.0));
    imageStore(target_motion,p,vec4(texelFetch(source_motion,p,0).rg,0.0,0.0));
#ifdef CAPTURE_NORMAL
    imageStore(target_normal,p,texelFetch(source_normal,p,0));
#endif
#ifdef CAPTURE_SPECULAR
    imageStore(target_specular,p,texelFetch(source_specular,p,0));
#endif
}
