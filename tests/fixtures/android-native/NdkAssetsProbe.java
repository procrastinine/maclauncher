import android.content.res.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
import maclauncher.android.test.NativeResourceSupport;

public final class NdkAssetsProbe {
    static native void verify(AssetManager assets,String platform,String loose,String obb,int density,int orientation,String language);
    static void entry(ZipOutputStream zip,String name,boolean compressed)throws Exception{
        byte[] bytes="0123456789".getBytes(StandardCharsets.UTF_8);var item=new ZipEntry(name);
        if(!compressed){var crc=new CRC32();crc.update(bytes);item.setMethod(ZipEntry.STORED);item.setSize(bytes.length);item.setCompressedSize(bytes.length);item.setCrc(crc.getValue());}
        zip.putNextEntry(item);zip.write(bytes);zip.closeEntry();
    }
    public static void main(String[] args)throws Exception{
        Path data=Path.of(args[0]),apk=data.resolve("fixture.apk"),loose=Files.createDirectories(data.resolve("loose")),obb=Files.createDirectories(data.resolve("obb"));
        try(var zip=new ZipOutputStream(Files.newOutputStream(apk))){entry(zip,"assets/stored.txt",false);entry(zip,"assets/compressed.txt",true);entry(zip,"assets/nested/file.txt",false);}
        Files.writeString(loose.resolve("loose.txt"),"0123456789");Files.writeString(loose.resolve("empty.txt"),"");Files.createDirectory(loose.resolve("directory"));
        // Existing OBB bank discovery serves indexed audio entries by basename.
        try(var zip=new ZipOutputStream(Files.newOutputStream(obb.resolve("fixture.obb")))){entry(zip,"assets/Audio/fixture.bank",false);}
        Resources resources=NativeResourceSupport.configure(apk);
        System.load(Path.of(args[1]).toRealPath().toString());System.load(Path.of(args[2]).toRealPath().toString());
        Configuration config=resources.getConfiguration();
        verify(resources.getAssets(),args[3],loose.toString(),obb.toString(),config.densityDpi,config.orientation,config.getLocales().get(0).getLanguage());
        System.out.println("PASS original NDK configuration family and shared APK/loose/OBB asset ownership");
    }
}
