package maclauncher.android.fixture;
import java.nio.file.*;import java.util.zip.*;
/** Test manifests compiled by AAPT2 from adjacent XML; parsed by the real framework. */
public final class PackageManifest {
 public static void add(Path apk,String name)throws Exception{
  Path temporary=Files.createTempFile(apk.getParent(),"manifest-",".apk");
  try(var output=new ZipOutputStream(Files.newOutputStream(temporary))){
   if(Files.exists(apk))try(var input=new ZipInputStream(Files.newInputStream(apk))){for(ZipEntry entry;(entry=input.getNextEntry())!=null;){if(entry.getName().equals("AndroidManifest.xml"))continue;output.putNextEntry(new ZipEntry(entry.getName()));input.transferTo(output);output.closeEntry();}}
   output.putNextEntry(new ZipEntry("AndroidManifest.xml"));Files.copy(Path.of("tests/fixtures/android-framework-services/manifests",name+".xml.bin"),output);output.closeEntry();
  }catch(Throwable failure){Files.deleteIfExists(temporary);throw failure;}
  Files.move(temporary,apk,StandardCopyOption.REPLACE_EXISTING);
 }
}
