import android.opengl.*;
import java.nio.ByteBuffer;
import java.util.Arrays;

/** Original ART EGL/GLES JNI and native GLES share one current pbuffer. */
public final class ArtGlesReadbackProbe {
    private static native int upload(int width,int height,int alignment);
    private static native long context();
    private static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    public static void main(String[] args){
        System.load(args[0]);
        EGLDisplay display=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);int[] version=new int[2];check(EGL14.eglInitialize(display,version,0,version,1),"eglInitialize");
        int[] choose={EGL14.EGL_SURFACE_TYPE,EGL14.EGL_PBUFFER_BIT,EGL14.EGL_RENDERABLE_TYPE,0x40,EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_NONE};EGLConfig[] configs=new EGLConfig[1];int[] count={0};check(EGL14.eglChooseConfig(display,choose,0,configs,0,1,count,0)&&count[0]>0,"eglChooseConfig");
        EGLContext context=EGL14.eglCreateContext(display,configs[0],EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,3,EGL14.EGL_NONE},0);
        EGLSurface surface=EGL14.eglCreatePbufferSurface(display,configs[0],new int[]{EGL14.EGL_WIDTH,2,EGL14.EGL_HEIGHT,2,EGL14.EGL_NONE},0);check(EGL14.eglMakeCurrent(display,surface,surface,context),"eglMakeCurrent");
        try{
            check(context.getNativeHandle()==context(),"Original Java and native EGL current-context identity");
            System.out.println("CONTEXT Java/native="+Long.toHexString(context())+" version="+GLES20.glGetString(GLES20.GL_VERSION));
            for(int width:new int[]{2,1024}){
                int texture=upload(width,width,width==2?1:8);check(texture>0,"native RGB8 source upload");
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D,texture);
                int[] fbo={0};GLES20.glGenFramebuffers(1,fbo,0);GLES20.glBindFramebuffer(GLES30.GL_READ_FRAMEBUFFER,fbo[0]);GLES20.glFramebufferTexture2D(GLES30.GL_READ_FRAMEBUFFER,GLES20.GL_COLOR_ATTACHMENT0,GLES20.GL_TEXTURE_2D,texture,0);check(GLES20.glCheckFramebufferStatus(GLES30.GL_READ_FRAMEBUFFER)==GLES20.GL_FRAMEBUFFER_COMPLETE,"read FBO complete");GLES20.glPixelStorei(GLES20.GL_PACK_ALIGNMENT,1);
                ByteBuffer bytes=ByteBuffer.allocateDirect(4);
                for(int y:new int[]{0,width/2,width-1})for(int x:new int[]{0,width/2,width-1}){
                    bytes.put(0,(byte)0xa5);bytes.put(1,(byte)0x5a);bytes.put(2,(byte)0xc3);bytes.put(3,(byte)0x3c);bytes.clear();
                    GLES20.glReadPixels(x,y,1,1,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,bytes);int error=GLES20.glGetError();int[] sample={bytes.get(0)&255,bytes.get(1)&255,bytes.get(2)&255,bytes.get(3)&255};
                    check(error==0&&Arrays.equals(sample,new int[]{255,64,32,255}),"Original Java readback extent="+width+" at="+x+","+y+" error="+error+" actual="+Arrays.toString(sample));
                }
                GLES20.glBindFramebuffer(GLES30.GL_READ_FRAMEBUFFER,0);GLES20.glDeleteFramebuffers(1,fbo,0);GLES20.glDeleteTextures(1,new int[]{texture},0);System.out.println("PASS original ART JNI reads native RGB8 texture extent"+width+" through direct ByteBuffer and READ_FRAMEBUFFER");
            }
        }finally{EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);EGL14.eglDestroySurface(display,surface);EGL14.eglDestroyContext(display,context);EGL14.eglTerminate(display);}
    }
}
