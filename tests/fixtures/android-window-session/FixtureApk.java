package android.content.res;
import java.nio.file.*;
import java.util.List;
import java.util.zip.*;
public final class FixtureApk {
 public static void main(String[] args)throws Exception {
  byte[] bytes=ResourceFixtureData.table(true,List.of(ResourceFixtureData.value("","",0,0,0)),"Owned resource fixture");
  try(var zip=new ZipOutputStream(Files.newOutputStream(Path.of(args[0])))){zip.putNextEntry(new ZipEntry("resources.arsc"));zip.write(bytes);zip.closeEntry();if(args.length>1){zip.putNextEntry(new ZipEntry("AndroidManifest.xml"));Files.copy(Path.of(args[1]),zip);zip.closeEntry();}}
 }
}
