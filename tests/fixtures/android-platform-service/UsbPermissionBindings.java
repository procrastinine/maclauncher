import java.nio.file.*;
import java.util.jar.JarFile;
public final class UsbPermissionBindings {
    public static void main(String[] args)throws Exception{
        String name="com/android/server/usb/UsbUserPermissionManager.class";
        try(var jar=new JarFile(args[0])){
            byte[] original=jar.getInputStream(jar.getJarEntry(name)).readAllBytes();
            Path target=Path.of(args[1]).resolve(name);Files.createDirectories(target.getParent());
            Files.write(target,ServicePortability.transform(name,original));
        }
    }
}
