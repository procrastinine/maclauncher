import maclauncher.android.portability.PortableCalls;
import java.nio.file.*;
import java.util.jar.*;
/** Builds a focused publisher overlay for descriptor boundary tests only. */
public final class DescriptorArchiveProbe {
    public static void main(String[] args)throws Exception{Path output=Path.of(args[1]);PortableCalls portable=new PortableCalls();try(JarFile jar=new JarFile(args[0])){var entries=jar.entries();while(entries.hasMoreElements()){var entry=entries.nextElement();String name=entry.getName();if(!name.endsWith(".class")||!(name.startsWith("android/os/ParcelFileDescriptor")||name.startsWith("android/os/FileObserver")||name.startsWith("libcore/io/")||name.equals("dalvik/system/SocketTagger.class")))continue;byte[] bytes=DescriptorPortability.transform(name,portable.normalize(jar.getInputStream(entry).readAllBytes()));Path target=output.resolve(name);Files.createDirectories(target.getParent());Files.write(target,bytes);}}}
}
