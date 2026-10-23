import java.lang.reflect.*;
import maclauncher.android.web.WebKitView;

public final class WebKitDefaultProbe {
 public interface OriginalDefault {
  default String defaultValue(String input){return "original "+input;}
 }
 public static void main(String[] args)throws Exception {
  // Exercise the real shared proxy handler without creating a browser/window.
  Class<?> unsafe=Class.forName("sun.misc.Unsafe");Field field=unsafe.getDeclaredField("theUnsafe");field.setAccessible(true);
  Object allocator=field.get(null);
  WebKitView handler=(WebKitView)unsafe.getMethod("allocateInstance",Class.class).invoke(allocator,WebKitView.class);
  OriginalDefault proxy=(OriginalDefault)Proxy.newProxyInstance(WebKitDefaultProbe.class.getClassLoader(),new Class<?>[]{OriginalDefault.class},handler);
  if(!proxy.defaultValue("argument").equals("original argument"))throw new AssertionError("original default body");
  System.out.println("PASS shared WebKit proxy invokes original interface default method");
 }
}
