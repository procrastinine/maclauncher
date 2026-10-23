import android.util.jar.StrictJarFile;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import maclauncher.android.framework.*;

public final class StrictJarFileProbe {
    private static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    public static void main(String[] args)throws Exception{
        var loop=maclauncher.android.fixture.RuntimeFixture.initialize(args[0],args[1]);
        if(args.length>2)System.load(args[2]);
        Path file=Path.of(args[1]).resolve("archive.jar");byte[] payload="Original Android archive streams".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        try(var output=new ZipOutputStream(Files.newOutputStream(file))){
            for(String name:List.of("META-INF/MANIFEST.MF","deflated.txt","stored.txt")){
                byte[] bytes=name.endsWith(".MF")?"Manifest-Version: 1.0\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.UTF_8):payload;
                var entry=new ZipEntry(name);
                if(name.equals("stored.txt")){var crc=new CRC32();crc.update(bytes);entry.setMethod(ZipEntry.STORED);entry.setSize(bytes.length);entry.setCompressedSize(bytes.length);entry.setCrc(crc.getValue());}
                output.putNextEntry(entry);output.write(bytes);output.closeEntry();
            }
        }
        try{
            for(boolean verify:new boolean[]{false,true}){
                StrictJarFile jar=new StrictJarFile(file.toString(),verify,true);
                try{
                    Set<String> names=new HashSet<>();var entries=jar.iterator();while(entries.hasNext())names.add(entries.next().getName());check(names.size()==3,"actual ZIP enumeration");
                    check(jar.findEntry("absent")==null,"missing ZIP entry");
                    for(String name:List.of("stored.txt","deflated.txt")){
                        ZipEntry entry=jar.findEntry(name);try(var stream=jar.getInputStream(entry)){check(Arrays.equals(payload,stream.readAllBytes()),"original stored/deflated stream: "+name);}
                        check(jar.getCertificateChains(entry)==null,"unsigned archive identity");
                    }
                    if(verify)check(jar.getManifest().getMainAttributes().getValue("Manifest-Version").equals("1.0"),"original manifest parser");
                    var unfinished=jar.iterator();check(unfinished.hasNext(),"partially consumed iterator");
                }finally{jar.close();jar.close();}
            }
            var descriptor=android.system.Os.open(file.toString(),android.system.OsConstants.O_RDONLY,0);
            StrictJarFile owned=new StrictJarFile(descriptor,false,false);check(owned.findEntry("stored.txt")!=null,"descriptor-backed archive");owned.close();check(!descriptor.valid(),"original descriptor close");
            // No native index/iteration owner remains after the original Java close path.
            for(String field:List.of("archives","iterations")){var access=HostStrictJarFile.class.getDeclaredField(field);access.setAccessible(true);check(((Map<?,?>)access.get(null)).isEmpty(),"ZIP owners retired: "+field);}
        }finally{HostLooper.close(loop);}
        System.out.println("PASS original StrictJarFile enumeration, stored/deflated reads, manifest verification and descriptor retirement");
    }
}
