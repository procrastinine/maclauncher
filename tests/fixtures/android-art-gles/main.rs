use aim_host_gpu::{Entry,Lib};
use aim_hostcall::gpu;
use std::ffi::CStr;
#[allow(dead_code)]
#[path="table.rs"] mod table;

unsafe fn call<T>(op:u32,value:&mut T)->i64 {
    unsafe {(aim_host_gpu::MODULE.call)(op,value as *mut T as u64,size_of::<T>() as u64)}
}
unsafe fn gl(name:&CStr,args:&[u64])->u64 {
    let index=table::ENTRIES.iter().position(|entry|entry.name==name).unwrap();
    unsafe {(aim_host_gpu::MODULE.call)(gpu::FN_TABLE_BASE+index as u32,args.as_ptr() as u64,args.len() as u64*8) as u64}
}
fn check(value:u64,message:&str){assert_ne!(value,0,"{message}");}
fn wait(fd:i32){unsafe {
    assert!(fd>=0);let mut poll=libc::pollfd{fd,events:libc::POLLIN,revents:0};
    assert_eq!(libc::poll(&mut poll,1,5000),1,"native GPU fence deadline");
    assert_ne!(poll.revents&libc::POLLIN,0);libc::close(fd);
}}
unsafe fn rgb_upload(){unsafe {
    let shader=|kind:u64,text:&CStr|{let shader=gl(c"glCreateShader",&[kind]);let source=text.as_ptr();gl(c"glShaderSource",&[shader,1,&source as *const _ as u64,0]);gl(c"glCompileShader",&[shader]);let mut ok=0i32;gl(c"glGetShaderiv",&[shader,0x8b81,&mut ok as *mut _ as u64]);assert_eq!(ok,1);shader};
    let vertex=shader(0x8b31,c"#version 300 es\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}");
    let fragment=shader(0x8b30,c"#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D pixels;out vec4 color;void main(){color=texture(pixels,uv);}");
    let program=gl(c"glCreateProgram",&[]);gl(c"glAttachShader",&[program,vertex]);gl(c"glAttachShader",&[program,fragment]);gl(c"glLinkProgram",&[program]);let mut linked=0i32;gl(c"glGetProgramiv",&[program,0x8b82,&mut linked as *mut _ as u64]);assert_eq!(linked,1);gl(c"glUseProgram",&[program]);gl(c"glViewport",&[0,0,8,4]);
    let mut texture=0u32;gl(c"glGenTextures",&[1,&mut texture as *mut _ as u64]);gl(c"glBindTexture",&[0x0de1,texture as u64]);gl(c"glTexParameteri",&[0x0de1,0x2801,0x2601]);gl(c"glTexParameteri",&[0x0de1,0x2800,0x2601]);
    for (extent,alignment) in [(2usize,1),(1024,8)] {
        let stride=(extent*3+alignment-1)&!(alignment-1);let mut source=vec![0u8;stride*extent];
        for row in source.chunks_exact_mut(stride){for p in row[..extent*3].chunks_exact_mut(3){p.copy_from_slice(&[255,64,32]);}}
        gl(c"glPixelStorei",&[0x0cf5,alignment as u64]);
        gl(c"glTexImage2D",&[0x0de1,0,0x1907,extent as u64,extent as u64,0,0x1907,0x1401,source.as_ptr() as u64]);
        assert_eq!(gl(c"glGetError",&[]),0,"original generated ninth stack argument and RGB8 upload");
        // Client bytes may be reused as soon as the upload returns. In
        // particular RGB conversion must not retain an unowned caller pointer.
        source.fill(0);
        gl(c"glDrawArrays",&[4,0,3]);let mut sample=[0u8;4];gl(c"glReadPixels",&[0,0,1,1,0x1908,0x1401,sample.as_mut_ptr() as u64]);assert_eq!(sample,[255,64,32,255],"original forwarded RGB8 draw");
        let mut fbo=0u32;gl(c"glGenFramebuffers",&[1,&mut fbo as *mut _ as u64]);gl(c"glBindFramebuffer",&[0x8d40,fbo as u64]);gl(c"glFramebufferTexture2D",&[0x8d40,0x8ce0,0x0de1,texture as u64,0]);assert_eq!(gl(c"glCheckFramebufferStatus",&[0x8d40]),0x8cd5);
        for y in [0,extent/2,extent-1]{for x in [0,extent/2,extent-1]{gl(c"glReadPixels",&[x as u64,y as u64,1,1,0x1908,0x1401,sample.as_mut_ptr() as u64]);assert_eq!(sample,[255,64,32,255],"original RGB8 texel via FBO");}}
        gl(c"glBindFramebuffer",&[0x8d40,0]);gl(c"glDeleteFramebuffers",&[1,&fbo as *const _ as u64]);println!("PASS forwarded RGB8 extent{} alignment{} actual draw and nine texels {:?}",extent,alignment,sample);
    }
    if let Ok(root)=std::env::var("MACLAUNCHER_ANDROID_EGL_CACHE") {
        let mut length=0i32;gl(c"glGetProgramiv",&[program,0x8741,&mut length as *mut _ as u64]);assert!(length>0);
        let mut binary=vec![0u8;length as usize];let mut format=0u32;gl(c"glGetProgramBinary",&[program,length as u64,0,&mut format as *mut _ as u64,binary.as_mut_ptr() as u64]);
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(2);
        while !std::fs::read_dir(std::path::Path::new(&root).join("egl-programs")).is_ok_and(|items|items.flatten().any(|item|item.path().extension().is_some_and(|value|value=="blob"))){assert!(std::time::Instant::now()<deadline,"original host EGL callback published a complete cache entry");std::thread::sleep(std::time::Duration::from_millis(10));}
        println!("PASS original GPU hostcall installed the shared persistent EGL cache");
    }
    gl(c"glDeleteTextures",&[1,&texture as *const _ as u64]);gl(c"glDeleteProgram",&[program]);gl(c"glDeleteShader",&[vertex]);gl(c"glDeleteShader",&[fragment]);assert_eq!(gl(c"glGetError",&[]),0);
}}
unsafe fn planar(display:u64) {unsafe {
    let shader=|kind:u64,text:&CStr|{let shader=gl(c"glCreateShader",&[kind]);let source=text.as_ptr();gl(c"glShaderSource",&[shader,1,&source as *const _ as u64,0]);gl(c"glCompileShader",&[shader]);let mut ok=0i32;gl(c"glGetShaderiv",&[shader,0x8b81,&mut ok as *mut _ as u64]);assert_eq!(ok,1);shader};
    let vertex=shader(0x8b31,c"#version 300 es\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}");
    let fragment=shader(0x8b30,c"#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D pixels;out vec4 color;void main(){color=texture(pixels,uv);}");
    let program=gl(c"glCreateProgram",&[]);gl(c"glAttachShader",&[program,vertex]);gl(c"glAttachShader",&[program,fragment]);gl(c"glLinkProgram",&[program]);let mut linked=0i32;gl(c"glGetProgramiv",&[program,0x8b82,&mut linked as *mut _ as u64]);assert_eq!(linked,1);gl(c"glUseProgram",&[program]);gl(c"glViewport",&[0,0,8,4]);
    for (fourcc,planes) in [(*b"NV12",2),(*b"NV21",2),(*b"YV12",3),(*b"P010",2)] {
        let memory=libc::mmap(std::ptr::null_mut(),16384,3,libc::MAP_PRIVATE|libc::MAP_ANON,-1,0);assert_ne!(memory,libc::MAP_FAILED);
        let layout=[gpu::VideoPlane{offset:0,stride:16,width:8,height:4},gpu::VideoPlane{offset:64,stride:16,width:4,height:2},gpu::VideoPlane{offset:96,stride:16,width:4,height:2}];
        let mut input=gpu::ImportBuffer{display,address:memory as u64,length:16384,width:8,height:4,stride_bytes:16,format:0x23,fourcc:u32::from_le_bytes(fourcc),plane_count:planes,planes:layout,..Default::default()};
        if &fourcc==b"NV12" {
            let mut invalid=input;invalid.planes[1].offset=16380;
            assert_eq!(call(gpu::FN_IMPORT_BUFFER,&mut invalid),-22,"reject source plane outside its mapping");
            assert_eq!(invalid.image,0);assert_eq!(invalid.lease,0);
        }
        assert_eq!(call(gpu::FN_IMPORT_BUFFER,&mut input),0,"original planar import");assert_ne!(input.image,0);assert_ne!(input.lease,0);
        let mut texture=0u32;gl(c"glGenTextures",&[1,&mut texture as *mut _ as u64]);gl(c"glBindTexture",&[0x0de1,texture as u64]);
        gl(c"glTexParameteri",&[0x0de1,0x2801,0x2600]);gl(c"glTexParameteri",&[0x0de1,0x2800,0x2600]);
        for frame in 0..3 {
            let (y,cb,cr)=match frame{0=>(81u16,90u16,240u16),1=>(41,240,110),_=>(235,128,128)};
            for plane in 0..planes as usize {let p=layout[plane];for row in 0..p.height {for x in 0..p.width {
                let pointer=(memory as *mut u8).add((p.offset+row*p.stride) as usize);
                if &fourcc==b"P010" {let pixel=pointer.cast::<u16>().add(x as usize*if plane==0{1}else{2});*pixel=if plane==0{y}else{cb}<<8;if plane!=0{*pixel.add(1)=cr<<8;}}
                else if plane==0{*pointer.add(x as usize)=y as u8;}
                else if &fourcc==b"YV12" {*pointer.add(x as usize)=if plane==1{cr}else{cb} as u8;}
                else{let pixel=pointer.add(x as usize*2);*pixel=if &fourcc==b"NV21"{cr}else{cb} as u8;*pixel.add(1)=if &fourcc==b"NV21"{cb}else{cr} as u8;}
            }}}
            assert_eq!(call(gpu::FN_VIDEO_IMAGE,&mut gpu::VideoImage{lease:input.lease,dataspace:0x102,operation:0}),0,"original video refresh");
            gl(c"glEGLImageTargetTexture2DOES",&[0x0de1,input.image]);gl(c"glBindFramebuffer",&[0x8d40,0]);gl(c"glDrawArrays",&[4,0,3]);
            let mut pixel=[0u8;4];gl(c"glReadPixels",&[0,0,1,1,0x1908,0x1401,pixel.as_mut_ptr() as u64]);
assert!(pixel[3]>250);if frame==0{assert!(pixel[0]>220&&pixel[1]<45&&pixel[2]<45,"red {pixel:?}");}else if frame==1{assert!(pixel[0]<45&&pixel[1]<45&&pixel[2]>220,"blue {pixel:?}");}else{assert!(pixel[0]>240&&pixel[1]>240&&pixel[2]>240,"white {pixel:?}");}
            println!("PASS planar {:?} frame{} {:?}",fourcc,frame,pixel);
        }
        assert_eq!(call(gpu::FN_VIDEO_IMAGE,&mut gpu::VideoImage{lease:input.lease,dataspace:0x102,operation:0}),0);
        check(gl(c"eglDestroyImageKHR",&[display,input.image]),"planar image destroy");
        assert_eq!(call(gpu::FN_VIDEO_IMAGE,&mut gpu::VideoImage{lease:input.lease,dataspace:0,operation:1}),0);
        assert_eq!(libc::munmap(memory,16384),0);
        gl(c"glDrawArrays",&[4,0,3]);let mut pixel=[0u8;4];gl(c"glReadPixels",&[0,0,1,1,0x1908,0x1401,pixel.as_mut_ptr() as u64]);assert!(pixel[0]>240&&pixel[1]>240&&pixel[2]>240);
        gl(c"glDeleteTextures",&[1,&texture as *const _ as u64]);
    }
    gl(c"glDeleteProgram",&[program]);gl(c"glDeleteShader",&[vertex]);gl(c"glDeleteShader",&[fragment]);assert_eq!(gl(c"glGetError",&[]),0);
    println!("PASS planar converted RGB survives pending conversion, image lease and source mapping retirement");
}}
fn main(){unsafe {
    let root=std::env::args().nth(1).unwrap();aim_host_gpu::set_library_dir(std::path::Path::new(&root));
    let (table_hash,table_len)=aim_host_gpu::table_identity();let mut bits=vec![0u64;table_len.div_ceil(64) as usize];
    assert_eq!(call(gpu::FN_INIT,&mut gpu::Init{table_hash,table_len,resolved:bits.as_mut_ptr() as u64,resolved_words:bits.len() as u64}),0);
    let vulkan=std::env::var("KL_ANGLE_BACKEND").as_deref()==Ok("vulkan");
    let format=std::env::args().nth(2).unwrap_or_else(||"rgba".into());
    let client_version=if format.starts_with("es1"){1}else if format=="es2"{2}else{3};
    let rgbx=format.ends_with("rgbx");let multisample=format.contains("msaa");
    let attributes=[0x3203i64,if vulkan{0x3450}else{0x3489},0x3038];
    let display=gl(c"eglGetPlatformDisplay",&[0x3202,0,attributes.as_ptr() as u64]);check(display,"display");
    check(gl(c"eglInitialize",&[display,0,0]),"initialize");
    check(gl(c"eglInitialize",&[display,0,0]),"repeat initialize");assert_eq!(gl(c"eglGetError",&[]),0x3000,"repeat original display initialization preserves its error state");
    let choose=[0x3040i32,if client_version==1{1}else if client_version==2{4}else{0x40},0x3033,1,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3032,multisample as i32,0x3031,if multisample{4}else{0},0x3038];
    let (mut config,mut count)=(0usize,0i32);check(gl(c"eglChooseConfig",&[display,choose.as_ptr() as u64,&mut config as *mut _ as u64,1,&mut count as *mut _ as u64]),"choose");assert_eq!(count,1);
    let context_attributes=[0x3098i32,client_version,if client_version<3{0x3038}else{0x30fb},if vulkan{1}else{0},0x3038];
    let context=gl(c"eglCreateContext",&[display,config as u64,0,context_attributes.as_ptr() as u64]);check(context,"context");
    let size=[0x3057i32,31,0x3056,17,0x3038];let surface=gl(c"eglCreatePbufferSurface",&[display,config as u64,size.as_ptr() as u64]);check(surface,"pbuffer");
    check(gl(c"eglMakeCurrent",&[display,surface,surface,context]),"current");
    let mut samples=0i32;gl(c"glGetIntegerv",&[0x80a9,&mut samples as *mut _ as u64]);
    if multisample{assert_eq!(samples,4,"the actual source framebuffer must be multisampled");}
    let version=gl(c"glGetString",&[0x1f02]);println!("backend={} version={}",if vulkan{"vulkan"}else{"metal"},CStr::from_ptr(version as *const i8).to_string_lossy());
    if format=="rgb-upload" {rgb_upload();check(gl(c"eglMakeCurrent",&[display,0,0,0]),"uncurrent");check(gl(c"eglDestroySurface",&[display,surface]),"surface cleanup");check(gl(c"eglDestroyContext",&[display,context]),"context cleanup");check(gl(c"eglTerminate",&[display]),"display cleanup");return;}
    if std::env::args().nth(2).as_deref()==Some("yuv") {planar(display);check(gl(c"eglMakeCurrent",&[display,0,0,0]),"uncurrent");check(gl(c"eglDestroySurface",&[display,surface]),"surface cleanup");check(gl(c"eglDestroyContext",&[display,context]),"context cleanup");check(gl(c"eglTerminate",&[display]),"display cleanup");return;}
    let mut file=b"/private/tmp/art-gles-buffer-XXXXXX\0".to_vec();let fd=libc::mkstemp(file.as_mut_ptr().cast());assert!(fd>=0);libc::unlink(file.as_ptr().cast());assert_eq!(libc::ftruncate(fd,16384),0);
    let address=libc::mmap(std::ptr::null_mut(),16384,3,libc::MAP_SHARED,fd,0);assert_ne!(address,libc::MAP_FAILED);
    let observer=libc::mmap(std::ptr::null_mut(),16384,3,libc::MAP_SHARED,fd,0);assert_ne!(observer,libc::MAP_FAILED);libc::close(fd);
    std::ptr::write_bytes(observer,0xcd,16384);
    let mut imported=gpu::ImportBuffer{display,address:address as u64,length:16384,width:31,height:17,stride_bytes:128,format:if rgbx{2}else{1},image:0,..Default::default()};
    assert_eq!(call(gpu::FN_IMPORT_BUFFER,&mut imported),0,"actual original shared buffer import");assert_ne!(imported.image,0);
    assert_eq!(libc::munmap(address,16384),0,"retire guest mapping while GPU object retains backing");
    let mut legacy_bindings=[0u32;2];
    if client_version==1{gl(c"glGenFramebuffersOES",&[2,legacy_bindings.as_mut_ptr() as u64]);}
    for color in [[1f32,0.,0.,1.],[0.,0.,1.,1.]] {
        let mut source=color;if rgbx{source[3]=0.25;}
        gl(c"glClearColor",&source.map(|v|v.to_bits() as u64));gl(c"glClear",&[0x4000]);
        if client_version==1{
            gl(c"glBindFramebufferOES",&[0x8ca9,legacy_bindings[0] as u64]);gl(c"glBindFramebufferOES",&[0x8ca8,legacy_bindings[1] as u64]);
            assert_eq!(gl(c"glGetError",&[]),0,"original ES1 OES application bindings are valid");
        }
        let mut present=gpu::Present{image:imported.image,src_width:31,src_height:17,dst_width:31,dst_height:17,fence:-1,_reserved:0};
        assert_eq!(call(gpu::FN_PRESENT,&mut present),0,"original present and native fence");wait(present.fence);
        assert_eq!(gl(c"glGetError",&[]),0,"presentation must preserve the original GL error state");
        if client_version==1{
            for (name,expected) in [(0x8ca6,legacy_bindings[0]),(0x8caa,legacy_bindings[1])]{let mut actual=0i32;gl(c"glGetIntegerv",&[name,&mut actual as *mut _ as u64]);assert_eq!(actual as u32,expected,"original ES1 framebuffer bindings survive presentation");}
            gl(c"glBindFramebufferOES",&[0x8d40,0]);
        }
        let bytes=std::slice::from_raw_parts(observer.cast::<u8>(),16384);
        let expected=[(color[0]*255.) as u8,0,(color[2]*255.) as u8,255];
        for y in 0..17 {for x in 0..31 {assert_eq!(&bytes[y*128+x*4..y*128+x*4+4],&expected,"GPU writes original padded buffer");}assert_eq!(&bytes[y*128+124..y*128+128],&[0xcd;4],"padding remains owned by gralloc");}
        println!("PASS shared GPU buffer {:?}, stride128, guest mapping retired, native fence signaled",expected);
    }
    if client_version<3{
        for (width,height) in [(31,17),(15,9)] {
            let bind=if client_version==1{c"glBindFramebufferOES"}else{c"glBindFramebuffer"};
            gl(bind,&[0x8d40,0]);gl(c"glDisable",&[0x0c11]);gl(c"glClearColor",&[0,0,1f32.to_bits() as u64,1f32.to_bits() as u64]);gl(c"glClear",&[0x4000]);
            gl(c"glEnable",&[0x0c11]);gl(c"glScissor",&[0,0,31,8]);gl(c"glClearColor",&[0,1f32.to_bits() as u64,0,1f32.to_bits() as u64]);gl(c"glClear",&[0x4000]);
            let mut present=gpu::Present{image:imported.image,src_width:31,src_height:17,dst_width:width,dst_height:height,fence:-1,_reserved:0};
            assert_eq!(call(gpu::FN_PRESENT,&mut present),0);wait(present.fence);
            assert_eq!(gl(c"glGetError",&[]),0,"legacy orientation/scaling keeps the original GL error state");
            assert_ne!(gl(c"glIsEnabled",&[0x0c11]),0,"legacy application scissor enable survives presentation");
            let bytes=std::slice::from_raw_parts(observer.cast::<u8>(),16384);
            assert_eq!(&bytes[..4],&[0,0,255,255],"legacy top Android row reads top source row");
            let bottom=(height as usize-1)*128+(width as usize-1)*4;
            assert_eq!(&bytes[bottom..bottom+4],&[0,255,0,255],"legacy bottom Android row reads bottom source row after scaling");
        }
        println!("PASS original GLES{} asymmetric rows and scaled Android origin preserved",client_version);
        if client_version==1{gl(c"glDeleteFramebuffersOES",&[2,legacy_bindings.as_ptr() as u64]);}
        check(gl(c"eglDestroyImageKHR",&[display,imported.image]),"legacy image cleanup");
        check(gl(c"eglMakeCurrent",&[display,0,0,0]),"legacy uncurrent");check(gl(c"eglDestroySurface",&[display,surface]),"legacy surface cleanup");check(gl(c"eglDestroyContext",&[display,context]),"legacy context cleanup");check(gl(c"eglTerminate",&[display]),"legacy display cleanup");
        assert_eq!(libc::munmap(observer,16384),0);
        println!("PASS original GLES{} presentation leaves no GL error and preserves both actual shared colors",client_version);return;
    }
    // Distinct rows prove that presentation resolves before reversing/scaling;
    // uniform clears alone cannot expose a wrong framebuffer origin. Application
    // GL bindings may be non-default when eglSwapBuffers is entered.
    for (width,height) in [(31,17),(15,9)] {
        gl(c"glBindFramebuffer",&[0x8d40,0]);
        gl(c"glDisable",&[0x0c11]);gl(c"glClearColor",&[0,0,1f32.to_bits() as u64,1f32.to_bits() as u64]);gl(c"glClear",&[0x4000]);
        gl(c"glEnable",&[0x0c11]);gl(c"glScissor",&[0,0,31,8]);gl(c"glClearColor",&[0,1f32.to_bits() as u64,0,1f32.to_bits() as u64]);gl(c"glClear",&[0x4000]);
        let mut bindings=[0u32;2];gl(c"glGenFramebuffers",&[2,bindings.as_mut_ptr() as u64]);
        gl(c"glBindFramebuffer",&[0x8ca9,bindings[0] as u64]);gl(c"glBindFramebuffer",&[0x8ca8,bindings[1] as u64]);
        let mut renderbuffer=0u32;gl(c"glGenRenderbuffers",&[1,&mut renderbuffer as *mut _ as u64]);gl(c"glBindRenderbuffer",&[0x8d41,renderbuffer as u64]);
        let mut present=gpu::Present{image:imported.image,src_width:31,src_height:17,dst_width:width,dst_height:height,fence:-1,_reserved:0};
        assert_eq!(call(gpu::FN_PRESENT,&mut present),0);wait(present.fence);
        assert_eq!(gl(c"glGetError",&[]),0,"resolve/flip/scale keeps the original GL error state");
        for (name,expected) in [(0x8ca6,bindings[0]),(0x8caa,bindings[1]),(0x8ca7,renderbuffer)] {let mut actual=0i32;gl(c"glGetIntegerv",&[name,&mut actual as *mut _ as u64]);assert_eq!(actual as u32,expected,"application GL binding survives presentation");}
        assert_ne!(gl(c"glIsEnabled",&[0x0c11]),0,"application scissor enable survives presentation");
        let bytes=std::slice::from_raw_parts(observer.cast::<u8>(),16384);
        assert_eq!(&bytes[..4],&[0,0,255,255],"top Android row reads top source row");
        let bottom=(height as usize-1)*128+(width as usize-1)*4;
        assert_eq!(&bytes[bottom..bottom+4],&[0,255,0,255],"bottom Android row reads bottom source row after scaling");
        gl(c"glBindFramebuffer",&[0x8d40,0]);gl(c"glDeleteFramebuffers",&[2,bindings.as_ptr() as u64]);gl(c"glBindRenderbuffer",&[0x8d41,0]);gl(c"glDeleteRenderbuffers",&[1,&renderbuffer as *const _ as u64]);gl(c"glDisable",&[0x0c11]);
    }
    // Restore the uniform input expected by the original lifetime assertions.
    gl(c"glClearColor",&[0,0,1f32.to_bits() as u64,1f32.to_bits() as u64]);gl(c"glClear",&[0x4000]);
    let mut present=gpu::Present{image:imported.image,src_width:31,src_height:17,dst_width:31,dst_height:17,fence:-1,_reserved:0};assert_eq!(call(gpu::FN_PRESENT,&mut present),0);wait(present.fence);
    println!("PASS resolve before flip/scale, actual asymmetric rows and application GL state preserved");
    let mut texture=0u32;gl(c"glGenTextures",&[1,&mut texture as *mut _ as u64]);gl(c"glBindTexture",&[0x0de1,texture as u64]);gl(c"glEGLImageTargetTexture2DOES",&[0x0de1,imported.image]);
    check(gl(c"eglDestroyImageKHR",&[display,imported.image]),"destroy image with live GL texture");
    // A GL texture reference remains usable after the original EGLImage and
    // guest mmap are gone. Readback is only this assertion, never presentation.
    let mut framebuffer=0u32;gl(c"glGenFramebuffers",&[1,&mut framebuffer as *mut _ as u64]);gl(c"glBindFramebuffer",&[0x8d40,framebuffer as u64]);gl(c"glFramebufferTexture2D",&[0x8d40,0x8ce0,0x0de1,texture as u64,0]);
    assert_eq!(gl(c"glCheckFramebufferStatus",&[0x8d40]),0x8cd5);
    let mut pixel=[0u8;4];gl(c"glReadPixels",&[0,0,1,1,0x1908,0x1401,pixel.as_mut_ptr() as u64]);assert_eq!(pixel,[0,0,255,255]);
    // Ordinary FBO rendering has no window presentation call. The original
    // native-fence operation must cover the shared image's publication too.
    for color in [[0f32,1.,0.,1.],[1.,0.,1.,1.]] {
        gl(c"glClearColor",&color.map(|v|v.to_bits() as u64));gl(c"glClear",&[0x4000]);
        wait(call(gpu::FN_FENCE,&mut gpu::Fence{display}) as i32);
        let bytes=std::slice::from_raw_parts(observer.cast::<u8>(),16384);
        let expected=color.map(|v|(v*255.) as u8);
        for y in 0..17 {for x in 0..31 {assert_eq!(&bytes[y*128+x*4..y*128+x*4+4],&expected,"native fence publishes cached imported FBO");}}
    }
    println!("PASS cached imported FBO writes visible after original native fence without presentation");
    // A completed acquire/publication cycle also preserves subsequent host
    // writes when the same imported image is read by its existing GL object.
    let bytes=std::slice::from_raw_parts_mut(observer.cast::<u8>(),16384);
    for y in 0..17 {for x in 0..31 {bytes[y*128+x*4..y*128+x*4+4].copy_from_slice(&[21,43,65,255]);}}
    gl(c"glReadPixels",&[0,0,1,1,0x1908,0x1401,pixel.as_mut_ptr() as u64]);assert_eq!(pixel,[21,43,65,255]);
    println!("PASS existing imported GL object observes host update after native-fence completion");
    gl(c"glDeleteFramebuffers",&[1,&framebuffer as *const _ as u64]);gl(c"glDeleteTextures",&[1,&texture as *const _ as u64]);
    assert_eq!(gl(c"glGetError",&[]),0,"original GL error state");
    check(gl(c"eglMakeCurrent",&[display,0,0,0]),"uncurrent");check(gl(c"eglDestroySurface",&[display,surface]),"destroy pbuffer");check(gl(c"eglDestroyContext",&[display,context]),"destroy context");check(gl(c"eglTerminate",&[display]),"terminate");
    assert_eq!(libc::munmap(observer,16384),0);
    println!("PASS original AIM GPU public API: live GL reference survives EGLImage/mmap retirement; complete cleanup");
}}
