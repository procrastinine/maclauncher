import maclauncher.android.portability.PortableCalls;
import java.nio.file.*;
import java.util.zip.*;
/** Focused fixture build: normalize just the original archive client. */
public final class StrictJarNormalize {
    public static void main(String[] args)throws Exception{
        String name="android/util/jar/StrictJarFile.class";
        try(var input=new ZipFile(args[0]);var stream=input.getInputStream(input.getEntry(name))){
            byte[] bytes=new PortableCalls().normalize(stream.readAllBytes());
            bytes=FilesystemPortability.transform(name,bytes);
            Path file=Path.of(args[1],name);Files.createDirectories(file.getParent());Files.write(file,bytes);
        }
    }
}
