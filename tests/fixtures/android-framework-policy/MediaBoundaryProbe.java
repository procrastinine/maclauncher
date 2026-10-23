import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Checks real publisher descriptors against exact implemented host native boundaries. */
public final class MediaBoundaryProbe {
    private static ClassNode parse(byte[] bytes){ClassNode node=new ClassNode();new ClassReader(bytes).accept(node,0);return node;}
    private static byte[] code(MethodNode method){ClassWriter writer=new ClassWriter(0);writer.visit(Opcodes.V21,Opcodes.ACC_PUBLIC,"Probe",null,"java/lang/Object",null);method.accept(writer);writer.visitEnd();return writer.toByteArray();}
    public static void main(String[] args)throws Exception {
        int natives=0,preserved=0;
        try(JarFile upstream=new JarFile(args[0])){
            for(String name:List.of("android/media/SoundPool.class","android/media/MediaPlayer.class","android/media/AudioRecord.class","android/media/AudioTrack.class","android/media/AudioSystem.class","android/media/AudioPortEventHandler.class","android/media/audiopolicy/AudioProductStrategy.class","android/media/audiopolicy/AudioVolumeGroup.class","android/hardware/Camera.class")) {
                byte[] original=upstream.getInputStream(upstream.getJarEntry(name)).readAllBytes();
                ClassNode before=parse(original),after=parse(NativeBindings.transform(original));
                if(before.methods.size()!=after.methods.size()||before.fields.size()!=after.fields.size())throw new AssertionError("Framework members were hidden: "+name);
                for(int i=0;i<before.methods.size();i++){
                    MethodNode from=before.methods.get(i),to=after.methods.get(i);
                    if(!from.name.equals(to.name)||!from.desc.equals(to.desc))throw new AssertionError("Framework method changed identity");
                    if(name.equals("android/media/AudioTrack.class")&&(to.access&Opcodes.ACC_NATIVE)!=0)throw new AssertionError("AudioTrack native boundary is unbound: "+to.name+to.desc);
                    if((from.access&Opcodes.ACC_NATIVE)!=0&&(to.access&Opcodes.ACC_NATIVE)==0){
                        for(AbstractInsnNode instruction:to.instructions)if(instruction instanceof MethodInsnNode call){
                            try(InputStream stream=MediaBoundaryProbe.class.getClassLoader().getResourceAsStream(call.owner+".class")){
                                if(stream==null)throw new AssertionError("Missing native adapter: "+call.owner);
                                ClassNode host=parse(stream.readAllBytes());
                                if(host.methods.stream().noneMatch(method->method.name.equals(call.name)&&method.desc.equals(call.desc)&&(method.access&Opcodes.ACC_STATIC)!=0))throw new AssertionError("Missing native boundary: "+call.owner+"."+call.name+call.desc);
                            }
                        }
                        natives++;
                    }else{
                        if(!Arrays.equals(code(from),code(to)))throw new AssertionError("Upstream implementation replaced: "+name+"."+from.name+from.desc);
                        preserved++;
                    }
                }
            }
        }
        if(natives<60||preserved<100)throw new AssertionError("Incomplete media family coverage");
        System.out.println("PASS "+natives+" exact media native bindings and "+preserved+" unchanged upstream methods");
    }
}
