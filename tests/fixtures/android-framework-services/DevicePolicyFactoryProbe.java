import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/** Applies the production factory adaptation without rebuilding unrelated framework classes. */
public final class DevicePolicyFactoryProbe {
    public static void main(String[] args)throws Exception {
        int changed=0;
        try(var archive=new ZipFile(args[0])){
            for(var entry:Collections.list(archive.entries())){
                String name=entry.getName();
                if(!name.startsWith("android/app/SystemServiceRegistry$")||!name.endsWith(".class"))continue;
                byte[] original=archive.getInputStream(entry).readAllBytes(),adapted=ServicePortability.transform(name,original);
                if(Arrays.equals(original,adapted))continue;
                Path output=Path.of(args[1]).resolve(name);Files.createDirectories(output.getParent());Files.write(output,adapted);changed++;
            }
        }
        if(changed!=1)throw new AssertionError("Expected exactly the original device-policy client factory, found "+changed);
        System.out.println("PASS one original device-policy factory; other service factories unchanged");
    }
}
