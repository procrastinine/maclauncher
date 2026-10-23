import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Resource algorithms stay upstream; only the native array ABI can change. */
public final class ResourceBoundaryProbe implements Opcodes {
    static final String TYPED="android/content/res/TypedArray",ASSETS="android/content/res/AssetManager";
    static final String RAW="(JIILandroid/content/res/XmlBlock$Parser;[IJJ)V";
    static final String ARRAYS="(JIILandroid/content/res/XmlBlock$Parser;[I[I[I)V";
    static byte[] body(MethodNode source){
        var copy=new MethodNode(source.access,source.name,source.desc,source.signature,source.exceptions.toArray(String[]::new));source.accept(copy);
        for(var instruction:copy.instructions.toArray())if(instruction instanceof FrameNode||instruction instanceof LineNumberNode)copy.instructions.remove(instruction);
        copy.localVariables=null;copy.visibleLocalVariableAnnotations=null;copy.invisibleLocalVariableAnnotations=null;
        var writer=new ClassWriter(ClassWriter.COMPUTE_MAXS);writer.visit(V21,ACC_PUBLIC,"Body",null,"java/lang/Object",null);
        copy.accept(writer.visitMethod(copy.access,copy.name,copy.desc,copy.signature,copy.exceptions.toArray(String[]::new)));writer.visitEnd();return writer.toByteArray();
    }
    static ClassNode parse(byte[] bytes){var node=new ClassNode();new ClassReader(bytes).accept(node,0);return node;}
    static AbstractInsnNode next(AbstractInsnNode node){do{node=node.getNext();}while(node!=null&&node.getOpcode()<0);return node;}
    static void restoreTypedBoundary(MethodNode method){
        for(var instruction:method.instructions.toArray()){
            if(instruction instanceof FieldInsnNode field&&field.getOpcode()==GETFIELD&&field.owner.equals(TYPED)&&field.name.equals("mData")){
                var nonNull=next(field);var convert=nonNull==null?null:next(nonNull);
                if(nonNull instanceof MethodInsnNode call&&call.owner.equals("java/util/Objects")&&call.name.equals("nonNull")&&convert!=null&&convert.getOpcode()==I2L){
                    field.name="mDataAddress";field.desc="J";method.instructions.remove(nonNull);method.instructions.remove(convert);
                }
            }else if(instruction instanceof MethodInsnNode call&&call.owner.equals("maclauncher/android/framework/JvmPortability")&&call.name.equals("newUnpaddedArray")){
                call.owner="dalvik/system/VMRuntime";call.name="newNonMovableArray";call.desc="(Ljava/lang/Class;I)Ljava/lang/Object;";call.setOpcode(INVOKEVIRTUAL);
            }else if(instruction.getOpcode()==POP2&&next(instruction)!=null&&next(instruction).getOpcode()==LCONST_0){
                var zero=next(instruction);method.instructions.set(instruction,new MethodInsnNode(INVOKEVIRTUAL,"dalvik/system/VMRuntime","addressOf","(Ljava/lang/Object;)J",false));method.instructions.remove(zero);
            }
        }
    }
    static void restoreArrayOverload(MethodNode method){
        method.desc=RAW;
        for(var instruction:method.instructions){
            if(instruction instanceof VarInsnNode var){
                int old=var.var;var.var=old>=9?old+2:old>=8?old+1:old;
                if((old==7||old==8)&&var.getOpcode()==ALOAD)var.setOpcode(LLOAD);
            }else if(instruction instanceof IincInsnNode var){var.var=var.var>=9?var.var+2:var.var>=8?var.var+1:var.var;
            }else if(instruction instanceof MethodInsnNode call&&call.owner.equals(ASSETS)&&call.name.equals("nativeApplyStyleWithArray")){
                call.name="nativeApplyStyle";call.desc="(JJIIJ[IJJ)V";
            }
        }
    }
    public static void main(String[] args)throws Exception{
        int checked=0;
        try(var archive=new ZipFile(args[0])){
            for(String type:List.of(TYPED,ASSETS)){
                byte[] original;try(var in=archive.getInputStream(archive.getEntry(type+".class"))){original=in.readAllBytes();}
                byte[] transformed=ResourcePortability.transform(type+".class",original);
                var before=parse(original);var after=parse(transformed);var methods=new HashMap<String,MethodNode>();for(var method:after.methods)methods.put(method.name+method.desc,method);
                for(var method:before.methods){
                    var found=Objects.requireNonNull(methods.get(method.name+method.desc));
                    if(type.equals(TYPED))restoreTypedBoundary(found);
                    if(!Arrays.equals(body(method),body(found)))throw new AssertionError("Resource algorithm changed: "+type+"."+method.name+method.desc);
                    checked++;
                }
                if(type.equals(ASSETS)){
                    var array=Objects.requireNonNull(methods.get("applyStyle"+ARRAYS));restoreArrayOverload(array);
                    if(!Arrays.equals(body(methods.get("applyStyle"+RAW)),body(array)))throw new AssertionError("Array ABI dropped upstream validation or control flow");
                }
                if(args.length>1){Path output=Path.of(args[1],type+".class");Files.createDirectories(output.getParent());Files.write(output,transformed);}
            }
        }
        System.out.println("PASS "+checked+" original resource method bodies and derived native array ABI");
    }
}
