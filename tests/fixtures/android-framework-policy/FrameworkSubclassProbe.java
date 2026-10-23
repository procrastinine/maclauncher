import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;

public final class FrameworkSubclassProbe {
    private static byte[] type(String name,String parent,int access,String[] interfaces,String...methods){
        ClassWriter writer=new ClassWriter(0);writer.visit(Opcodes.V17,access,name,null,parent,interfaces);
        for(String entry:methods){boolean abstractMethod=entry.startsWith("abstract:");String method=abstractMethod?entry.substring(9):entry;
            var out=writer.visitMethod(Opcodes.ACC_PUBLIC|(abstractMethod?Opcodes.ACC_ABSTRACT:0),method,"()V",null,null);
            if(!abstractMethod){out.visitCode();out.visitInsn(Opcodes.RETURN);out.visitMaxs(0,1);}out.visitEnd();}
        writer.visitEnd();return writer.toByteArray();
    }
    private static void write(Path classes,String name,byte[] bytes)throws Exception{Path file=classes.resolve(name+".class");Files.createDirectories(file.getParent());Files.write(file,bytes);}
    private static byte[] forwarder(String name,boolean synthetic,boolean extra){
        String parent="android/example/Hidden";
        ClassWriter writer=new ClassWriter(0);writer.visit(Opcodes.V17,Opcodes.ACC_PUBLIC,name,null,parent,null);
        var method=writer.visitMethod(Opcodes.ACC_PUBLIC|(synthetic?Opcodes.ACC_SYNTHETIC|Opcodes.ACC_BRIDGE:0),"algorithm","()V",null,null);
        method.visitCode();if(extra)method.visitInsn(Opcodes.NOP);
        method.visitVarInsn(Opcodes.ALOAD,0);method.visitMethodInsn(Opcodes.INVOKESPECIAL,parent,"algorithm","()V",false);
        method.visitInsn(Opcodes.RETURN);method.visitMaxs(1,1);method.visitEnd();writer.visitEnd();return writer.toByteArray();
    }
    private static void failures(Path framework,Path classes,int count,String...expected)throws Exception{
        var actual=FrameworkSubclassAudit.check(framework,classes);
        if(actual.size()!=count)throw new AssertionError("Expected "+count+" failures: "+actual);
        for(String item:expected)if(actual.stream().noneMatch(value->value.contains(item)))throw new AssertionError("Missed "+item+": "+actual);
    }
    public static void main(String[] args)throws Exception{
        Path root=Path.of(args[0]),framework=root.resolve("publisher.jar"),classes=Files.createDirectories(root.resolve("classes"));
        int iface=Opcodes.ACC_PUBLIC|Opcodes.ACC_INTERFACE|Opcodes.ACC_ABSTRACT;
        var entries=new LinkedHashMap<String,byte[]>();
        entries.put("android/example/Base",type("android/example/Base","java/lang/Object",Opcodes.ACC_PUBLIC|Opcodes.ACC_ABSTRACT,null,"algorithm","abstract:platformCallback"));
        entries.put("android/example/Derived",type("android/example/Derived","android/example/Base",Opcodes.ACC_PUBLIC|Opcodes.ACC_ABSTRACT,null));
        entries.put("android/example/Hidden",type("android/example/Hidden","java/lang/Object",0,null,"algorithm"));
        entries.put("android/os/IInterface",type("android/os/IInterface","java/lang/Object",iface,null));
        entries.put("android/example/IService",type("android/example/IService","java/lang/Object",iface,new String[]{"android/os/IInterface"},"abstract:dispatch"));
        entries.put("android/example/IService$Default",type("android/example/IService$Default","java/lang/Object",Opcodes.ACC_PUBLIC,new String[]{"android/example/IService"},"dispatch"));
        entries.put("android/example/AlgorithmInterface",type("android/example/AlgorithmInterface","java/lang/Object",iface,null,"algorithm"));
        entries.put("android/example/Lookalike",type("android/example/Lookalike","java/lang/Object",iface,null,"abstract:algorithm"));
        try(var zip=new ZipOutputStream(Files.newOutputStream(framework))){for(var entry:entries.entrySet()){zip.putNextEntry(new ZipEntry(entry.getKey()+".class"));zip.write(entry.getValue());zip.closeEntry();}}
        write(classes,"owned/Bad",type("owned/Bad","android/example/Derived",Opcodes.ACC_PUBLIC,null,"algorithm"));
        failures(framework,classes,1,"android/example/Base.algorithm");
        write(classes,"owned/Indirect",type("owned/Indirect","owned/Bad",Opcodes.ACC_PUBLIC,null,"algorithm"));
        failures(framework,classes,2,"owned/Indirect -> android/example/Base.algorithm");
        Files.delete(classes.resolve("owned/Bad.class"));Files.delete(classes.resolve("owned/Indirect.class"));
        write(classes,"owned/DefaultOverride",type("owned/DefaultOverride","java/lang/Object",Opcodes.ACC_PUBLIC,new String[]{"android/example/AlgorithmInterface"},"algorithm"));
        failures(framework,classes,1,"android/example/AlgorithmInterface.algorithm");
        Files.delete(classes.resolve("owned/DefaultOverride.class"));
        write(classes,"owned/Lookalike",type("owned/Lookalike","android/example/Derived",Opcodes.ACC_PUBLIC,new String[]{"android/example/Lookalike"},"algorithm"));
        failures(framework,classes,1,"android/example/Base.algorithm");
        Files.delete(classes.resolve("owned/Lookalike.class"));
        write(classes,"owned/InventedBinder",type("owned/InventedBinder","java/lang/Object",iface,new String[]{"android/os/IInterface"},"abstract:algorithm"));
        write(classes,"owned/FalseEndpoint",type("owned/FalseEndpoint","android/example/Derived",Opcodes.ACC_PUBLIC,new String[]{"owned/InventedBinder"},"algorithm"));
        failures(framework,classes,1,"android/example/Base.algorithm");
        Files.delete(classes.resolve("owned/InventedBinder.class"));Files.delete(classes.resolve("owned/FalseEndpoint.class"));
        write(classes,"owned/Callback",type("owned/Callback","android/example/Derived",Opcodes.ACC_PUBLIC,null,"platformCallback"));
        write(classes,"owned/Endpoint",type("owned/Endpoint","android/example/IService$Default",Opcodes.ACC_PUBLIC,null,"dispatch"));
        failures(framework,classes,0);
        write(classes,"owned/AccessBridge",forwarder("owned/AccessBridge",true,false));
        failures(framework,classes,0);
        write(classes,"owned/FalseBridge",forwarder("owned/FalseBridge",true,true));
        failures(framework,classes,1,"owned/FalseBridge -> android/example/Hidden.algorithm");
        Files.delete(classes.resolve("owned/FalseBridge.class"));
        write(classes,"owned/ExplicitOverride",forwarder("owned/ExplicitOverride",false,false));
        failures(framework,classes,1,"owned/ExplicitOverride -> android/example/Hidden.algorithm");
        System.out.println("PASS subclass audit detects inherited, owned-intermediate and interface-default bypasses while preserving abstract callbacks and Binder endpoints");
    }
}
