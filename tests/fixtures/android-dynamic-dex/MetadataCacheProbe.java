import maclauncher.android.DynamicDex;
import maclauncher.android.framework.HostDexFiles;
import java.nio.ByteBuffer;
import java.nio.file.*;
import java.util.*;

/** Actual converter/cache proof with parent-only types supplied by metadata. */
public final class MetadataCacheProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),cache=Files.createDirectories(Path.of(args[1]));
        var parent=HostDexFiles.bootClassLoader(null);
        DynamicDex.configure(runtime,cache,runtime.resolve("dex2jvm.jar"),parent);
        Object owner=DemandDexProbe.session();
        try(var module=DynamicDex.buffers(new ByteBuffer[]{ByteBuffer.wrap(Files.readAllBytes(Path.of(args[2])))},parent)){
            byte[] bytes=module.classBytes("fixture.headers.Choice");
            check(bytes!=null&&bytes.length>0,"original converter supplies requested class bytes");
            var entries=owner.getClass().getDeclaredField("artifacts");entries.setAccessible(true);
            boolean consulted=false;
            for(Object artifact:((Map<?,?>)entries.get(owner)).values()){
                var field=artifact.getClass().getDeclaredField("parentHeaders");field.setAccessible(true);
                Map<?,?> facts=(Map<?,?>)field.get(artifact);
                consulted|=facts.containsKey("fixture/headers/HeaderLeft");
                check(!facts.containsKey("fixture/headers/Unrelated"),"unconsulted metadata does not enter class context");
            }
            check(consulted,"the upstream converter actually requests the tested fallback header");
            long workers=ProcessHandle.current().children().filter(child->child.isAlive()&&child.info().commandLine().orElse("").contains("DemandDexConvert")).count();
            check(workers==Integer.parseInt(args[3]),"expected active converters "+args[3]+", actual "+workers);
            DemandDexProbe.awaitPersistence();
            System.out.println("PASS consulted metadata cache workers="+workers);
        }finally{DynamicDex.hostShutdown();}
        var archives=owner.getClass().getDeclaredField("metadataArchives");archives.setAccessible(true);
        check(archives.get(owner)==null,"the Session retires its metadata resource owner");
    }
}
