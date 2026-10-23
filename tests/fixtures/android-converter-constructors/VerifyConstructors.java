import java.net.*;
import java.nio.file.*;
public final class VerifyConstructors {
 public static void main(String[] args)throws Exception {
  try(var loader=new URLClassLoader(new URL[]{Path.of(args[0]).toUri().toURL()})) {
   Class<?> leaf=loader.loadClass("fixture.constructors.Leaf"),base=loader.loadClass("fixture.constructors.Base");
   Object instance=leaf.getMethod("make").invoke(null);
   if(instance.getClass()!=leaf||!base.isInstance(instance))throw new AssertionError();
   if(leaf.getConstructor(int.class).newInstance(17).getClass()!=leaf)throw new AssertionError();
   if(leaf.getConstructor().newInstance().getClass()!=leaf||base.getConstructor().newInstance().getClass()!=base)throw new AssertionError();
   System.out.println("PASS inherited constructor resolution and retained real constructor");
  }
 }
}
