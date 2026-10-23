package maclauncher.android.bridge;
import java.util.*;
public final class NativeSymbols {
    static{System.load(System.getProperty("klepton.graphics"));}
    private static native int check(String[] names);
    public static int validate(){
        Set<String> names=new TreeSet<>();
        for(var method:android.opengl.GLES20.class.getDeclaredMethods())if(method.getName().startsWith("gl"))names.add(method.getName());
        names.addAll(List.of("glGetFloatv","glGetBooleanv","glIsEnabled","glColorMask","glBindFramebuffer","glDisable","glEnable","glClearColor","glClear","glGetIntegerv","glReadPixels","eglGetPlatformDisplayEXT","eglInitialize","eglTerminate","eglChooseConfig","eglGetConfigAttrib","eglCreateContext","eglDestroyContext","eglCreatePbufferSurface","eglDestroySurface","eglMakeCurrent","eglSwapBuffers","eglGetCurrentContext","eglGetError"));
        if("1".equals(System.getenv("KLEPTON_METAL_PRESENT")))names.addAll(List.of("eglQueryString","eglQueryDisplayAttribEXT","eglQueryDeviceAttribEXT","eglCreatePbufferFromClientBuffer","eglCreateSync","eglDestroySync","eglWaitSync","glFlush"));
        return check(names.toArray(String[]::new));
    }
    public static void main(String[] args){System.out.println("PASS actual installed ANGLE exports resolved without creating a device: "+validate());}
}
