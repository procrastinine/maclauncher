import java.nio.file.*;
import java.util.zip.*;

/** Apply the ordinary build boundary to just the changed upstream class. */
public class PropertyAccessorTransform {
 public static void main(String[] args)throws Exception {
  String name="android/animation/PropertyValuesHolder.class";
  try(var input=new ZipFile(args[0])) {
   byte[] original=input.getInputStream(input.getEntry(name)).readAllBytes();
   Path output=Path.of(args[1],name);Files.createDirectories(output.getParent());
   Files.write(output,UiPortability.transform(name,original));
  }
 }
}
