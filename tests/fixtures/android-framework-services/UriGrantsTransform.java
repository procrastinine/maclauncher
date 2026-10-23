import java.nio.file.*;
import java.util.jar.*;
public final class UriGrantsTransform {
    public static void main(String[] args)throws Exception {
        try(var jar=new JarFile(args[0])){
            for(var entries=jar.entries();entries.hasMoreElements();){var entry=entries.nextElement();if(!entry.getName().startsWith("com/android/server/uri/")||!entry.getName().endsWith(".class"))continue;
                byte[] original;try(var input=jar.getInputStream(entry)){original=input.readAllBytes();}
                byte[] changed=ServicePortability.transform(entry.getName(),original);if(changed==original)continue;
                Path file=Path.of(args[1],entry.getName());Files.createDirectories(file.getParent());Files.write(file,changed);
            }
        }
    }
}
