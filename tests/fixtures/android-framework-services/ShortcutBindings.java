import java.nio.file.*;
import java.util.jar.*;
public final class ShortcutBindings {
    public static void main(String[] args)throws Exception{
        try(var jar=new JarFile(args[0])){
            for(var entries=jar.entries();entries.hasMoreElements();){var entry=entries.nextElement();
                if(!entry.getName().endsWith(".class")||!entry.getName().startsWith("com/android/server/pm/Shortcut"))continue;
                byte[] bytes;try(var in=jar.getInputStream(entry)){bytes=in.readAllBytes();}
                Path out=Path.of(args[1],entry.getName());Files.createDirectories(out.getParent());Files.write(out,ServicePortability.transform(entry.getName(),bytes));
            }
        }
    }
}
