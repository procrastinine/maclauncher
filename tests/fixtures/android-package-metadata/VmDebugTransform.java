import java.nio.file.*;
import java.util.jar.JarFile;
public final class VmDebugTransform {
 public static void main(String[] args)throws Exception {
  try(var jar=new JarFile(args[0])){
   var name="dalvik/system/VMDebug.class";var output=Path.of(args[1],name);Files.createDirectories(output.getParent());
   Files.write(output,NativeBindings.transform(jar.getInputStream(jar.getJarEntry(name)).readAllBytes()));
  }
 }
}
