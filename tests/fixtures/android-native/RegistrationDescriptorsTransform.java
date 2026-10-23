import java.nio.file.*;
import java.util.zip.ZipFile;
public final class RegistrationDescriptorsTransform {
    public static void main(String[] args)throws Exception{
        try(var archive=new ZipFile(args[0])){
            GraphicsPortability.initialize(archive);
            String name="android/graphics/Paint.class";
            byte[] bytes=archive.getInputStream(archive.getEntry(name)).readAllBytes();
            Path target=Path.of(args[1]).resolve(name);Files.createDirectories(target.getParent());
            Files.write(target,GraphicsPortability.transform(name,bytes));
        }
    }
}
