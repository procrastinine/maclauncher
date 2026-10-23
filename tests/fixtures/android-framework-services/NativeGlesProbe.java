import android.opengl.*;import java.nio.*;import java.nio.file.*;import maclauncher.android.bridge.*;
/** Original Android EGL/GLES adapters against the installed Metal ANGLE provider, without a window. */
public final class NativeGlesProbe {
 static void check(boolean okay,String message){if(!okay)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception {
  Path graphics=Path.of(args[0]),angle=Path.of(args[1]);
  if(args.length>2){Path nativeRoot=graphics.getParent();System.setProperty("klepton.bridge",nativeRoot.resolve("libklepton-jvm.dylib").toString());System.load(System.getProperty("klepton.bridge"));System.load(nativeRoot.resolve("libnativebinding.dylib").toString());
  maclauncher.android.framework.JvmNativeMemory.configure(nativeRoot.resolve("libandroid_runtime.dylib"));maclauncher.android.framework.JvmNativeMemory.initialize();}System.setProperty("klepton.graphics",graphics.toString());System.load(graphics.toString());Graphics.configureHost(null,angle.toString(),16,16);NativeSurface.configureGraphics(graphics.toString());
  for(String name:new String[]{"GLES10","GLES10Ext","GLES11","GLES11Ext","GLES20","GLES30","GLES31","GLES31Ext","GLES32","EGL14","EGL15","EGLExt"})Class.forName("android.opengl."+name);
  Class.forName("com.google.android.gles_jni.GLImpl");
  EGLDisplay display=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);int[] major=new int[2];check(EGL14.eglInitialize(display,major,0,major,1),"initialize Metal ANGLE");
  EGLConfig[] configs=new EGLConfig[1];int[] count={0};check(EGL14.eglChooseConfig(display,new int[]{EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_PBUFFER_BIT,EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_NONE},0,configs,0,1,count,0)&&count[0]>0,"choose exact RGBA8 pbuffer");
  EGLContext context=EGL14.eglCreateContext(display,configs[0],EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,3,EGL14.EGL_NONE},0);check(!context.equals(EGL14.EGL_NO_CONTEXT),"create GLES3");EGLSurface surface=EGL14.eglCreatePbufferSurface(display,configs[0],new int[]{EGL14.EGL_WIDTH,16,EGL14.EGL_HEIGHT,16,EGL14.EGL_NONE},0);
  try{check(EGL14.eglMakeCurrent(display,surface,surface,context),"current");GLES20.glClearColor(1,0,0,1);GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
   ByteBuffer bytes=ByteBuffer.allocateDirect(12).order(ByteOrder.nativeOrder());bytes.position(4);GLES20.glReadPixels(0,0,1,1,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,bytes);check((bytes.get(4)&255)==255&&bytes.get(5)==0&&(bytes.get(7)&255)==255&&bytes.position()==4,"direct buffer position and real rendered pixel");
   IntBuffer heap=IntBuffer.wrap(new int[]{123,0,0,0,0,456},1,4).slice();GLES20.glGetIntegerv(GLES20.GL_VIEWPORT,heap);check(heap.get(2)==16&&heap.get(3)==16,"heap slice backing and offset");
   int[] names=new int[3];GLES30.glGenVertexArrays(1,names,1);check(names[0]==0&&names[1]!=0&&names[2]==0,"original GLES3 offset output");GLES30.glBindVertexArray(names[1]);check(GLES30.glIsVertexArray(names[1]),"GLES3 actual object");GLES30.glDeleteVertexArrays(1,names,1);
   if(args.length>2)utilities();
   check(GLES20.glGetError()==GLES20.GL_NO_ERROR,"native GL error state");
   check(EGL14.eglSwapBuffers(display,surface),"offscreen EGL swap remains owned by ANGLE");
   var legacy=(javax.microedition.khronos.egl.EGL10)javax.microedition.khronos.egl.EGLContext.getEGL();check(legacy.eglGetCurrentContext().getGL() instanceof javax.microedition.khronos.opengles.GL11,"original complete GLImpl");check(com.google.android.gles_jni.EGLImpl.getInitCount(legacy.eglGetCurrentDisplay())==1,"shared native EGL ownership count");
  }finally{EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);EGL14.eglDestroySurface(display,surface);EGL14.eglDestroyContext(display,context);EGL14.eglTerminate(display);EGL14.eglReleaseThread();}
  System.out.println("PASS upstream complete EGL/GLES JNI registration, actual Metal pixel, direct/heap NIO and GLES3 ownership");
 }
 static void utilities(){
  int[] texture={0},framebuffer={0};GLES20.glGenTextures(1,texture,0);GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,texture[0]);
  android.graphics.Bitmap bitmap=android.graphics.Bitmap.createBitmap(new int[]{0xffff0000,0xff0000ff,0x80402010,0xff00ff00},2,2,android.graphics.Bitmap.Config.ARGB_8888);
  check(GLUtils.getInternalFormat(bitmap)==GLES20.GL_RGBA&&GLUtils.getType(bitmap)==GLES20.GL_UNSIGNED_BYTE,"original bitmap format");
  GLUtils.texImage2D(GLES20.GL_TEXTURE_2D,0,bitmap,0);
  GLES20.glGenFramebuffers(1,framebuffer,0);GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER,framebuffer[0]);GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER,GLES20.GL_COLOR_ATTACHMENT0,GLES20.GL_TEXTURE_2D,texture[0],0);
  check(GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER)==GLES20.GL_FRAMEBUFFER_COMPLETE,"uploaded original bitmap texture");
  ByteBuffer pixels=ByteBuffer.allocateDirect(16);GLES20.glReadPixels(0,0,2,2,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,pixels);
  check((pixels.get(0)&255)==255&&pixels.get(2)==0&&pixels.get(4)==0&&(pixels.get(6)&255)==255,"NDK RGBA channel ownership");
  check((pixels.get(8)&255)==32&&(pixels.get(9)&255)==16&&(pixels.get(10)&255)==8&&(pixels.get(11)&255)==128,"premultiplied alpha preserved");
  android.graphics.Bitmap patch=android.graphics.Bitmap.createBitmap(new int[]{0xffffff00},1,1,android.graphics.Bitmap.Config.ARGB_8888);GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D,0,1,1,patch);
  GLES20.glReadPixels(1,1,1,1,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,pixels);check((pixels.get(0)&255)==255&&(pixels.get(1)&255)==255&&pixels.get(2)==0,"original subimage upload");
  check(bitmap.getPixel(0,0)==0xffff0000&&bitmap.getPixel(1,0)==0xff0000ff,"original Bitmap survives borrow");bitmap.recycle();patch.recycle();
  GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER,0);GLES20.glDeleteFramebuffers(1,framebuffer,0);GLES20.glDeleteTextures(1,texture,0);
  ByteBuffer rgb=ByteBuffer.allocateDirect(48),encoded=ByteBuffer.allocateDirect(ETC1.getEncodedDataSize(4,4)),decoded=ByteBuffer.allocateDirect(48),header=ByteBuffer.allocateDirect(ETC1.ETC_PKM_HEADER_SIZE);
  for(int i=0;i<16;i++)rgb.put(i*3,(byte)255);
  ETC1.encodeImage(rgb,4,4,3,12,encoded);ETC1.decodeImage(encoded,decoded,4,4,3,12);check((decoded.get(0)&255)>245&&(decoded.get(1)&255)<10,"original ETC1 codec");
  ETC1.formatHeader(header,4,4);check(ETC1.isValid(header)&&ETC1.getWidth(header)==4&&ETC1.getHeight(header)==4,"original ETC1 header");
  float[] sphere=new float[4];Visibility.computeBoundingSphere(new float[]{-1,0,0,1,0,0},0,2,sphere,0);check(sphere[0]==0&&sphere[3]==1,"original Visibility geometry");
  System.out.println("PASS original OpenGL utilities: Bitmap texture upload, subimage, pixel channels, alpha, ETC1 and Visibility");
 }

}
