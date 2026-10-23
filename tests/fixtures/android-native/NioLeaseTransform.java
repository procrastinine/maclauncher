package maclauncher.android.portability;
import java.nio.file.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

public final class NioLeaseTransform implements Opcodes {
    public static void main(String[] args)throws Exception{
        byte[] input=Files.readAllBytes(Path.of(args[0]));ClassNode type=new ClassNode(ASM9);new ClassReader(input).accept(type,0);
        for(MethodNode method:type.methods)if(method.name.equals("accessible")){
            method.access&=~ACC_NATIVE;
            method.instructions.add(new VarInsnNode(ALOAD,0));
            if(method.desc.endsWith("Z)V")){
                method.instructions.add(new VarInsnNode(ILOAD,1));
                method.instructions.add(new MethodInsnNode(INVOKEVIRTUAL,"java/nio/ByteBuffer","setAccessible","(Z)V",false));
                method.instructions.add(new InsnNode(RETURN));
            }else{
                method.instructions.add(new MethodInsnNode(INVOKEVIRTUAL,"java/nio/ByteBuffer","isAccessible","()Z",false));
                method.instructions.add(new InsnNode(IRETURN));
            }
        }
        ClassWriter writer=new ClassWriter(ClassWriter.COMPUTE_MAXS);type.accept(writer);
        Files.write(Path.of(args[1]),NioPortability.transform(writer.toByteArray()));
    }
}
