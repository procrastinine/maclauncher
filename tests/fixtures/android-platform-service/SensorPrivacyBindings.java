import java.nio.file.*;
import java.util.jar.JarFile;

/** Apply the current physical service-call adaptation to the original family. */
public final class SensorPrivacyBindings {
 public static void main(String[] args)throws Exception{
  try(var jar=new JarFile(args[0])){
   for(var entry:jar.stream().filter(e->e.getName().startsWith("com/android/server/sensorprivacy/")&&e.getName().endsWith(".class")).toList()){
    byte[] original;try(var input=jar.getInputStream(entry)){original=input.readAllBytes();}
    Path output=Path.of(args[1]).resolve(entry.getName());Files.createDirectories(output.getParent());Files.write(output,ServicePortability.transform(entry.getName(),original));
   }
  }
 }
}
