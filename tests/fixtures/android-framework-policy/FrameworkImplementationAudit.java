import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.objectweb.asm.*;
import org.objectweb.asm.tree.*;

/** Independent test of publisher Java bodies. No production normalizer is loaded. */
public final class FrameworkImplementationAudit implements Opcodes {
    private static final String HOST="maclauncher/android/framework/";
    private static final String MEDIA="maclauncher/android/media/";
    private static final String QUEUE="android/os/MessageQueue";
    private static final String ARRAY="android/content/res/TypedArray";
    private static final String REGISTRY="libcore/util/NativeAllocationRegistry";
    private static Map<String,String> loaderParents=Map.of();
    static void loaderHierarchy(Map<String,String> parents){loaderParents=Map.copyOf(parents);}
    private static boolean dexLoader(String owner){
        if(!owner.startsWith("dalvik/system/"))return false;
        var visited=new HashSet<String>();
        for(String at=owner;at!=null&&visited.add(at);at=loaderParents.get(at))if(at.equals("java/lang/ClassLoader"))return true;
        return false;
    }
    private record Call(int opcode,String owner,String name,String descriptor) {
        MethodInsnNode instruction(){return new MethodInsnNode(opcode,owner,name,descriptor,false);}
    }
    private static Call call(int opcode,String owner,String name,String descriptor){return new Call(opcode,owner,name,descriptor);}
    private static Call call(AbstractInsnNode instruction){return instruction instanceof MethodInsnNode c?call(c.getOpcode(),c.owner,c.name,c.desc):null;}
    private static boolean isCall(AbstractInsnNode instruction,int opcode,String owner,String name,String descriptor){return Objects.equals(call(instruction),call(opcode,owner,name,descriptor));}
    private static List<AbstractInsnNode> code(MethodNode method){return Arrays.stream(method.instructions.toArray()).filter(i->i.getOpcode()>=0).toList();}
    private static AbstractInsnNode next(AbstractInsnNode node){do{node=node.getNext();}while(node!=null&&node.getOpcode()<0);return node;}
    private static AbstractInsnNode previous(AbstractInsnNode node){do{node=node.getPrevious();}while(node!=null&&node.getOpcode()<0);return node;}
    private static boolean opcode(AbstractInsnNode node,int opcode){return node!=null&&node.getOpcode()==opcode;}
    private static boolean variable(AbstractInsnNode node,int opcode,int slot){return node instanceof VarInsnNode v&&v.getOpcode()==opcode&&v.var==slot;}
    private static void remove(MethodNode method,AbstractInsnNode... nodes){for(var node:nodes)method.instructions.remove(node);}
    private static String unmap(String value){
        if(value==null)return null;
        return value.replace(HOST+"JvmCleaner$Runner",REGISTRY+"$CleanerRunner")
            .replace(HOST+"JvmCleaner","sun/misc/Cleaner")
            .replace(HOST+"JvmCompoundEnumeration","sun/misc/CompoundEnumeration");
    }

    /** The embedded service boundary changes the receiver representation, not
     * its callers' algorithms. Match the exact original invocation and complete
     * descriptor in this method; an arbitrary call to a host helper is rejected. */
    private static void serviceCalls(String owner,MethodNode original,MethodNode adapted){
        var packages=Map.ofEntries(
            Map.entry("hostHasSignatureCapability","hasSignatureCapability"),Map.entry("hostGetPackageUid","getPackageUid"),
            Map.entry("hostFilterAppAccess","filterAppAccess"),Map.entry("hostGetApplicationInfo","getApplicationInfo"),
            Map.entry("hostResolveContentProvider","resolveContentProvider"),Map.entry("hostGrantImplicitAccess","grantImplicitAccess"),
            Map.entry("hostGetPackageStateInternal","getPackageStateInternal"),Map.entry("hostGetPackageStates","getPackageStates"),
            Map.entry("hostGetAndroidPackage","getAndroidPackage"),Map.entry("hostGetPackage","getPackage"),
            Map.entry("hostWasPackageEverLaunched","wasPackageEverLaunched"),Map.entry("hostIsPackageStopped","isPackageStopped"));
        var activities=Map.of("hostHandleIncomingUser","handleIncomingUser","hostEnforceCallingPermission","enforceCallingPermission",
            "hostCheckContentProviderUriPermission","checkContentProviderUriPermission","hostUidCapability","getUidCapability");
        var users=Map.of("hostAddUserRestrictionsListener","addUserRestrictionsListener","hostRemoveUserRestrictionsListener","removeUserRestrictionsListener",
            "hostGetProfileParentId","getProfileParentId","hostGetUserRestriction","getUserRestriction","hostGetUserIds","getUserIds");
        var pending=Map.ofEntries(
            Map.entry("getUidProcessState","android/app/ActivityManagerInternal"),Map.entry("enforceBroadcastOptionsPermissions","android/app/ActivityManagerInternal"),
            Map.entry("tempAllowlistForPendingIntent","android/app/ActivityManagerInternal"),Map.entry("broadcastIntentInPackage","android/app/ActivityManagerInternal"),
            Map.entry("startServiceInPackage","android/app/ActivityManagerInternal"),Map.entry("startActivitiesInPackage","com/android/server/wm/ActivityTaskManagerInternal"),
            Map.entry("startActivityInPackage","com/android/server/wm/ActivityTaskManagerInternal"),Map.entry("sendActivityResult","com/android/server/wm/ActivityTaskManagerInternal"),
            Map.entry("isUidForeground","com/android/server/wm/ActivityTaskManagerInternal"),Map.entry("clearPendingResultForActivity","com/android/server/wm/ActivityTaskManagerInternal"),
            Map.entry("remove","com/android/server/AlarmManagerInternal"),Map.entry("getCurrentOrTargetUserId","com/android/server/am/UserController"),
            Map.entry("scheduleUpdateBinderHeavyHitterWatcherConfig","com/android/server/am/ActivityManagerService"));
        for(var node:adapted.instructions.toArray()){
            if(!(node instanceof MethodInsnNode call)||call.getOpcode()!=INVOKESTATIC)continue;
            if(owner.startsWith("android/app/SystemServiceRegistry$")&&original.name.equals("createService")
                &&Type.getReturnType(original.desc).getDescriptor().equals("Landroid/app/admin/DevicePolicyManager;")
                &&call.owner.equals("android/os/ServiceManager")&&call.name.equals("getService")&&call.desc.equals("(Ljava/lang/String;)Landroid/os/IBinder;")){
                for(var candidate:original.instructions)if(isCall(candidate,INVOKESTATIC,call.owner,"getServiceOrThrow",call.desc)){call.name="getServiceOrThrow";break;}
                continue;
            }
            String sourceOwner=null,sourceName=null;
            if(call.owner.equals(HOST+"HostPackages")&&packages.containsKey(call.name)){
                sourceOwner="android/content/pm/PackageManagerInternal";sourceName=packages.get(call.name);
            }else if(call.owner.equals(HOST+"HostActivityManager")&&activities.containsKey(call.name)){
                sourceOwner="android/app/ActivityManagerInternal";sourceName=activities.get(call.name);
            }else if(call.owner.equals(HOST+"HostUserService")&&users.containsKey(call.name)){
                sourceOwner="com/android/server/pm/UserManagerInternal";sourceName=users.get(call.name);
            }else if(call.owner.equals(HOST+"HostAppOps")&&call.name.equals("hostSetGlobalRestriction")){
                sourceOwner="android/app/AppOpsManagerInternal";sourceName="setGlobalRestriction";
            }else if(call.owner.equals(HOST+"HostPendingIntentDispatch")&&pending.containsKey(call.name)
                &&Set.of("com/android/server/am/PendingIntentController","com/android/server/am/PendingIntentRecord","com/android/server/am/ActivityManagerConstants").contains(owner)){
                sourceOwner=pending.get(call.name);sourceName=call.name;
                if(sourceOwner.equals("com/android/server/am/ActivityManagerService")&&!(owner.equals("com/android/server/am/ActivityManagerConstants")&&original.name.equals("<init>")))continue;
            }
            if(sourceOwner==null)continue;
            for(var candidate:original.instructions){
                if(!(candidate instanceof MethodInsnNode source)||(source.getOpcode()!=INVOKEVIRTUAL&&source.getOpcode()!=INVOKEINTERFACE)
                    ||!source.owner.equals(sourceOwner)||!source.name.equals(sourceName))continue;
                String descriptor="(Ljava/lang/Object;"+source.desc.substring(1).replace("Lcom/android/server/wm/Task;","Ljava/lang/Object;");
                if(!descriptor.equals(call.desc))continue;
                call.setOpcode(source.getOpcode());call.owner=source.owner;call.name=source.name;call.desc=source.desc;call.itf=source.itf;break;
            }
        }
    }

    /* Every entry describes a JVM/native ABI substitution, never permission to
       ignore a class or an arbitrary method body. All surrounding code is compared. */
    private static Call equivalent(String owner,MethodNode method,Call value){
        if(value==null)return null;
        int op=value.opcode;String o=value.owner,n=value.name,d=value.descriptor;
        if(!unmap(o).equals(o))return call(op,unmap(o),n,unmap(d));
        if((o.startsWith(HOST)||o.startsWith(MEDIA))&&op!=INVOKESTATIC)return value;
        if(o.equals(HOST+"JvmPortability")){
            if(n.equals("newUnpaddedArray")&&d.equals("(Ljava/lang/Object;Ljava/lang/Class;I)Ljava/lang/Object;"))
                return call(INVOKEVIRTUAL,"dalvik/system/VMRuntime",owner.equals(ARRAY)?"newNonMovableArray":n,"(Ljava/lang/Class;I)Ljava/lang/Object;");
            if(n.equals("eldest")&&d.equals("(Ljava/util/LinkedHashMap;)Ljava/util/Map$Entry;"))return call(INVOKEVIRTUAL,"java/util/LinkedHashMap",n,"()Ljava/util/Map$Entry;");
            if(n.equals("adjustLanguageCode")&&d.equals("(Ljava/lang/String;)Ljava/lang/String;"))return call(INVOKESTATIC,"java/util/Locale",n,d);
            if((n.equals("logE")||n.equals("logW"))&&(d.equals("(Ljava/lang/String;)V")||d.equals("(Ljava/lang/String;Ljava/lang/Throwable;)V")))return call(INVOKESTATIC,"java/lang/System",n,d);
        }
        if(o.equals("java/lang/System")&&n.equals("arraycopy")&&op==INVOKESTATIC){
            Type[] args=Type.getArgumentTypes(d);
            if(args.length==5&&Type.getReturnType(d).equals(Type.VOID_TYPE)&&args[1].equals(Type.INT_TYPE)&&args[3].equals(Type.INT_TYPE)&&args[4].equals(Type.INT_TYPE)
                &&(args[0].getSort()==Type.ARRAY||args[0].equals(Type.getType(Object.class)))&&(args[2].getSort()==Type.ARRAY||args[2].equals(Type.getType(Object.class))))return call(op,o,n,"(Ljava/lang/Object;ILjava/lang/Object;II)V");
        }
        if(o.equals(HOST+"HostFileDescriptor")&&op==INVOKESTATIC){
            if(n.equals("socketDescriptor")&&(d.equals("(Ljava/net/Socket;)Ljava/io/FileDescriptor;")||d.equals("(Ljava/net/DatagramSocket;)Ljava/io/FileDescriptor;")))return call(INVOKEVIRTUAL,Type.getArgumentTypes(d)[0].getInternalName(),"getFileDescriptor$","()Ljava/io/FileDescriptor;");
            Map<String,String> names=Map.of("getInt","getInt$","setInt","setInt$","isSocket","isSocket$","getOwnerId","getOwnerId$","setOwnerId","setOwnerId$","release","release$","cloneForFork","cloneForFork");
            if(names.containsKey(n)&&d.startsWith("(Ljava/io/FileDescriptor;"))return call(INVOKEVIRTUAL,"java/io/FileDescriptor",names.get(n),"("+d.substring("(Ljava/io/FileDescriptor;".length()));
        }
        if(o.equals(HOST+"JvmNativeMemory")&&d.equals("(J)V")&&(n.equals("registerAllocation")||n.equals("registerFree")))return call(INVOKESTATIC,REGISTRY,n.equals("registerAllocation")?"registerNativeAllocation":"registerNativeFree",d);
        if(o.equals(HOST+"HostStrictJarFile")&&n.equals("dataOffset")&&d.equals("(Ljava/util/zip/ZipEntry;)J"))return call(INVOKEVIRTUAL,"java/util/zip/ZipEntry","getDataOffset","()J");
        if((owner.equals("com/android/internal/util/ArtFastDataInput")||owner.equals("com/android/internal/util/ArtFastDataOutput"))&&o.equals(HOST+"HostCharset")&&op==INVOKESTATIC&&
            ((n.equals("toModifiedUtf8Bytes")&&d.equals("(Ljava/lang/String;[BII)I"))||(n.equals("fromModifiedUtf8Bytes")&&d.equals("([BII)Ljava/lang/String;"))))
            return call(op,"android/util/CharsetUtils",n,d.replace("[B","J"));
        if(o.equals(HOST+"HostFilesystem")&&n.equals("environment")&&(d.equals("(Ljava/lang/String;)Ljava/lang/String;")||d.equals("()Ljava/util/Map;")))return call(INVOKESTATIC,"java/lang/System","getenv",d);
        if(o.equals(HOST+"HostNio")&&op==INVOKESTATIC)return call(op,"java/nio/NioUtils",n,d);
        if(o.equals(HOST+"HostEcParameters")&&op==INVOKESTATIC){
            if(n.equals("getCurveName")&&d.equals("(Ljava/security/spec/ECParameterSpec;)Ljava/lang/String;"))return call(INVOKEVIRTUAL,"java/security/spec/ECParameterSpec",n,"()Ljava/lang/String;");
            if(n.equals("setCurveName")&&d.equals("(Ljava/security/spec/ECParameterSpec;Ljava/lang/String;)V"))return call(INVOKEVIRTUAL,"java/security/spec/ECParameterSpec",n,"(Ljava/lang/String;)V");
        }
        if(owner.equals("com/android/server/content/ContentService$ObserverCollector")&&o.equals(HOST+"HostActivityManager")&&n.equals("hostUidProcessState")&&d.equals("(Landroid/app/ActivityManagerInternal;I)I"))return call(INVOKEVIRTUAL,"android/app/ActivityManagerInternal","getUidProcessState","(I)I");
        if(o.equals(HOST+"HostFrameworkLibraries")&&n.equals("loadLibrary")&&d.equals("(Ljava/lang/String;)V"))return call(INVOKESTATIC,"java/lang/System",n,d);
        if(owner.equals("dalvik/system/DelegateLastClassLoader")&&o.equals(HOST+"HostDexFiles")&&n.equals("bootClassLoader")&&d.equals("(Ljava/lang/Class;)Ljava/lang/ClassLoader;"))return call(INVOKEVIRTUAL,"java/lang/Class","getClassLoader","()Ljava/lang/ClassLoader;");
        if(owner.equals("dalvik/system/DexPathList")&&o.equals("maclauncher/android/bridge/GuestNativeLoader")&&n.equals("mapLibraryName")&&d.equals("(Ljava/lang/String;)Ljava/lang/String;"))return call(INVOKESTATIC,"java/lang/System",n,d);
        if(owner.equals("android/content/res/ResourcesImpl$ThemeImpl")&&o.equals("android/content/res/AssetManager")&&n.equals("applyStyle")&&d.equals("(JIILandroid/content/res/XmlBlock$Parser;[I[I[I)V"))return call(op,o,n,"(JIILandroid/content/res/XmlBlock$Parser;[IJJ)V");
        return call(op,unmap(o),n,unmap(d));
    }

    /** Remove only exact lifecycle additions. Unknown instructions remain and fail comparison. */
    private static void lifecycle(String owner,MethodNode method){
        for(AbstractInsnNode node:method.instructions.toArray()){
            if(node.getPrevious()==null&&node!=method.instructions.getFirst())continue;
            Call c=call(node);if(c==null)continue;
            AbstractInsnNode before=previous(node),after=next(node);
            if(c.opcode!=INVOKESTATIC)continue;
            String o=c.owner,n=c.name,d=c.descriptor;
            if(o.equals(HOST+"HostFilesystem")&&owner.equals("android/os/Environment")&&opcode(after,ARETURN)
                &&(n.equals("file")&&d.equals("(Ljava/io/File;)Ljava/io/File;")&&Type.getReturnType(method.desc).equals(Type.getType(java.io.File.class))
                    ||n.equals("mapPath")&&d.equals("(Ljava/lang/String;)Ljava/lang/String;")&&method.name.equals("getDirectoryPath")))remove(method,node);
            else if(o.equals(HOST+"HostFilesystem")&&owner.equals("android/graphics/fonts/SystemFonts")&&n.equals("directoryPath")&&d.equals("(Ljava/lang/String;)Ljava/lang/String;")&&opcode(after,ARETURN)&&method.desc.equals("()Ljava/lang/String;")&&(method.name.equals("getFontsXmlDir")||method.name.equals("getSystemFontDir")))remove(method,node);
            else if(o.equals(HOST+"JvmNativeMemory")&&owner.equals(REGISTRY)){
                if(n.equals("initialize")&&d.equals("()V")&&method.name.equals("<clinit>")&&opcode(after,RETURN))remove(method,node);
                else if(n.equals("allocationLoader")&&d.equals("(Ljava/lang/ClassLoader;)Ljava/lang/ClassLoader;")&&method.name.equals("<init>")&&variable(before,ALOAD,1)&&variable(after,ASTORE,1)&&previous(before)==null)remove(method,before,node,after);

            }else if(o.equals(HOST+"HostAsyncTasks")&&owner.equals("android/os/AsyncTask")){
                if(n.equals("attachExecutors")&&d.equals("()V")&&method.name.equals("execute")&&(method.access&ACC_STATIC)!=0&&before==null)remove(method,node);
                else if(d.equals("(Landroid/os/AsyncTask;)V")&&variable(before,ALOAD,0)&&opcode(after,RETURN)&&(n.equals("attach")&&method.name.equals("<init>")||n.equals("finished")&&method.name.equals("finish")))remove(method,before,node);
            }else if(o.equals(HOST+"HostWindowManager")&&owner.equals("android/view/ViewRootImpl")){
                if(n.equals("prepareView")&&d.equals("(Landroid/view/ViewRootImpl;Landroid/view/WindowManager$LayoutParams;)V")&&method.name.equals("setView")&&variable(before,ALOAD,2)&&variable(previous(before),ALOAD,0)&&previous(previous(before))==null)remove(method,previous(before),before,node);
                else if(d.equals("(Landroid/view/ViewRootImpl;)V")&&variable(before,ALOAD,0)&&(n.equals("viewAttached")&&method.name.equals("setView")&&opcode(after,RETURN)||n.equals("viewDetached")&&method.name.equals("dispatchDetachedFromWindow")&&previous(before)==null))remove(method,before,node);
            }else if(o.equals(HOST+"HostInputManager")&&owner.equals("android/view/ViewRootImpl")&&method.name.equals("getInputToken")&&n.equals("inputToken")&&d.equals("(Landroid/view/ViewRootImpl;Landroid/os/IBinder;)Landroid/os/IBinder;")&&opcode(before,SWAP)&&variable(previous(before),ALOAD,0)&&opcode(after,ARETURN))remove(method,previous(before),before,node);
            else if(o.equals(HOST+"HostDexFiles")&&owner.equals("dalvik/system/BaseDexClassLoader")&&n.equals("parent")&&d.equals("(Ljava/lang/ClassLoader;)Ljava/lang/ClassLoader;")&&isCall(after,INVOKESPECIAL,"java/lang/ClassLoader","<init>","(Ljava/lang/ClassLoader;)V"))remove(method,node);
            else if(o.equals(HOST+"HostLooper")){
                if(n.equals("attachQueue")&&owner.equals(QUEUE)&&method.name.equals("<init>")&&d.equals("(Landroid/os/MessageQueue;)V")&&variable(before,ALOAD,0)&&opcode(after,RETURN))remove(method,before,node);
                else if(n.equals("attachLooper")&&owner.equals("android/os/Looper")&&method.name.equals("<init>")&&d.equals("(Landroid/os/Looper;)V")&&variable(before,ALOAD,0)&&opcode(after,RETURN))remove(method,before,node);
                else if(n.equals("afterNext")&&owner.equals(QUEUE)&&method.name.equals("next")&&d.equals("(Landroid/os/MessageQueue;Landroid/os/Message;)Landroid/os/Message;")&&opcode(before,SWAP)&&variable(previous(before),ALOAD,0)&&opcode(after,ARETURN))remove(method,previous(before),before,node);
                else if(n.equals("quitAllowed")&&owner.equals(QUEUE)&&d.equals("(Landroid/os/MessageQueue;Z)Z")&&before instanceof FieldInsnNode field&&field.getOpcode()==GETFIELD&&field.owner.equals(QUEUE)&&field.name.equals("mQuitAllowed")&&opcode(previous(before),DUP))remove(method,previous(before),node);
                else if(n.equals("loopExit")&&d.equals("()V")&&(owner.equals("android/os/Looper")&&method.name.equals("loop")||owner.equals("android/os/HandlerThread")&&method.name.equals("run"))&&opcode(after,RETURN))remove(method,node);
                else if(n.equals("poll")&&owner.equals(QUEUE)&&method.desc.equals("()Landroid/os/Message;")&&d.equals("(Landroid/os/MessageQueue;JI)Z")&&after instanceof JumpInsnNode branch&&branch.getOpcode()==IFNE&&opcode(next(after),ACONST_NULL)&&opcode(next(next(after)),ARETURN)&&next(branch.label)==next(next(next(after)))){
                    method.instructions.set(node,new MethodInsnNode(INVOKEVIRTUAL,QUEUE,"nativePollOnce","(JI)V",false));remove(method,next(next(after)),next(after),after);
                }
            }
        }
        loopCatch(owner,method);
        callback(owner,method);
    }

    /** Recognize inserted platform lifecycle operations, then compare every
     * original instruction and branch. No method or class body is exempted. */
    private static void platformLifecycle(String owner,MethodNode method){
        var ins=code(method);
        // Exact VM name/array representation entry; every instruction in the
        // original delegation body must still follow the non-array branch.
        if(dexLoader(owner)&&method.name.equals("loadClass")&&method.desc.equals("(Ljava/lang/String;Z)Ljava/lang/Class;")
            &&ins.size()>=10&&variable(ins.get(0),ALOAD,1)
            &&isCall(ins.get(1),INVOKESTATIC,HOST+"HostDexFiles","className","(Ljava/lang/String;)Ljava/lang/String;")
            &&variable(ins.get(2),ASTORE,1)&&variable(ins.get(3),ALOAD,1)&&variable(ins.get(4),ALOAD,0)
            &&isCall(ins.get(5),INVOKESTATIC,HOST+"HostDexFiles","arrayClass","(Ljava/lang/String;Ljava/lang/ClassLoader;)Ljava/lang/Class;")
            &&opcode(ins.get(6),DUP)&&ins.get(7) instanceof JumpInsnNode ordinary&&ordinary.getOpcode()==IFNULL
            &&opcode(ins.get(8),ARETURN)&&next(ordinary.label)==ins.get(9)&&opcode(ins.get(9),POP)){
            for(int i=0;i<10;i++)method.instructions.remove(ins.get(i));ins=code(method);
        }
        if(method.name.equals("<clinit>")&&dexLoader(owner)&&ins.size()>=2
            &&isCall(ins.get(0),INVOKESTATIC,owner,"registerAsParallelCapable","()Z")&&opcode(ins.get(1),POP))
            remove(method,ins.get(0),ins.get(1));
        if(method.name.equals("<clinit>")&&(owner.startsWith("android/opengl/")||owner.startsWith("com/google/android/gles_jni/"))
            &&ins.size()>=2&&ins.get(0) instanceof LdcInsnNode type&&Objects.equals(type.cst,Type.getObjectType(owner))
            &&isCall(ins.get(1),INVOKESTATIC,HOST+"HostGles","register","(Ljava/lang/Class;)V"))remove(method,ins.get(0),ins.get(1));
        if(owner.equals("com/android/server/accounts/AccountManagerService$Session")){
            for(var instruction:method.instructions.toArray()){
                String hook=method.name.equals("<init>")?"createdSession":method.name.equals("close")&&method.desc.equals("()V")?"retiredSession":null;
                if(hook!=null&&isCall(instruction,INVOKESTATIC,HOST+"HostAccountAccess",hook,"(Ljava/lang/Object;)V")
                    &&variable(previous(instruction),ALOAD,0)&&opcode(next(instruction),RETURN))remove(method,previous(instruction),instruction);
            }
            ins=code(method);
            if(method.name.equals("bind")&&method.desc.equals("()V")&&ins.size()>=5&&variable(ins.get(0),ALOAD,0)
                &&isCall(ins.get(1),INVOKESTATIC,HOST+"HostAccountAccess","bindSession","(Ljava/lang/Object;)Z")
                &&ins.get(2) instanceof JumpInsnNode branch&&branch.getOpcode()==IFNE&&opcode(ins.get(3),RETURN)&&next(branch.label)==ins.get(4))
                remove(method,ins.get(0),ins.get(1),ins.get(2),ins.get(3));
        }
        if(owner.equals("android/view/ViewRootImpl")&&method.name.equals("finishInputEvent")&&method.desc.equals("(Landroid/view/ViewRootImpl$QueuedInputEvent;)V")){
            ins=code(method);String event="android/view/ViewRootImpl$QueuedInputEvent";
            if(ins.size()>=11&&variable(ins.get(0),ALOAD,1)&&field(ins.get(1),GETFIELD,event,"mEvent","Landroid/view/InputEvent;")
                &&variable(ins.get(2),ALOAD,1)&&field(ins.get(3),GETFIELD,event,"mFlags","I")&&field(ins.get(4),GETSTATIC,event,"FLAG_FINISHED_HANDLED","I")
                &&opcode(ins.get(5),IAND)&&ins.get(6) instanceof JumpInsnNode no&&no.getOpcode()==IFEQ&&opcode(ins.get(7),ICONST_1)
                &&ins.get(8) instanceof JumpInsnNode ready&&ready.getOpcode()==GOTO&&opcode(ins.get(9),ICONST_0)
                &&next(no.label)==ins.get(9)&&next(ready.label)==ins.get(10)
                &&isCall(ins.get(10),INVOKESTATIC,HOST+"HostWindowManager","inputFinished","(Landroid/view/InputEvent;Z)V"))
                for(int i=0;i<11;i++)method.instructions.remove(ins.get(i));
        }
        if(owner.equals("android/animation/PropertyValuesHolder")&&method.name.equals("setupSetterOrGetter")
            &&method.desc.equals("(Ljava/lang/Class;Ljava/util/HashMap;Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/reflect/Method;")){
            for(var returned:method.instructions.toArray()){
                if(returned.getOpcode()!=ARETURN)continue;ins=code(method);int end=ins.indexOf(returned),start=end-9;if(start<0)continue;
                if(opcode(ins.get(start),DUP)&&ins.get(start+1) instanceof JumpInsnNode absent&&absent.getOpcode()==IFNULL
                    &&opcode(ins.get(start+2),DUP)&&isCall(ins.get(start+3),INVOKEVIRTUAL,"java/lang/reflect/Method","getModifiers","()I")
                    &&isCall(ins.get(start+4),INVOKESTATIC,"java/lang/reflect/Modifier","isPublic","(I)Z")
                    &&ins.get(start+5) instanceof JumpInsnNode nonpublic&&nonpublic.getOpcode()==IFEQ&&next(absent.label)==returned&&next(nonpublic.label)==returned
                    &&opcode(ins.get(start+6),DUP)&&opcode(ins.get(start+7),ICONST_1)
                    &&isCall(ins.get(start+8),INVOKEVIRTUAL,"java/lang/reflect/Method","setAccessible","(Z)V"))
                    for(int i=start;i<end;i++)method.instructions.remove(ins.get(i));
            }
        }
    }
    private static boolean field(AbstractInsnNode instruction,int opcode,String owner,String name,String descriptor){
        return instruction instanceof FieldInsnNode f&&f.getOpcode()==opcode&&f.owner.equals(owner)&&f.name.equals(name)&&f.desc.equals(descriptor);
    }

    /** The original accessory serializer accidentally indexes its device array.
     * Accept only the one corrected array load, identified by publisher locals
     * and the original Boolean/attribute/AccessoryFilter.write sequence. */
    private static void usbSnapshot(String owner,MethodNode original,MethodNode adapted){
        if(!owner.equals("com/android/server/usb/UsbUserPermissionManager")||!original.name.startsWith("lambda$scheduleWritePermissionsLocked$")||original.localVariables==null)return;
        Integer device=null,accessory=null,filters=null;
        for(var local:original.localVariables)if(local.desc.equals("[[Z")){
            if(local.name.equals("grantedValuesForDevices"))device=local.index;
            if(local.name.equals("grantedValuesForAccessories"))accessory=local.index;
        }else if(local.name.equals("accessories")&&local.desc.equals("[Landroid/hardware/usb/AccessoryFilter;"))filters=local.index;
        if(device==null||accessory==null||filters==null)return;
        var before=code(original);var after=code(adapted);if(before.size()!=after.size())return;
        for(int i=0;i+12<before.size();i++){
            if(!variable(before.get(i),ALOAD,device)||!variable(after.get(i),ALOAD,accessory)
                ||!(before.get(i+1) instanceof VarInsnNode row)||row.getOpcode()!=ILOAD||!opcode(before.get(i+2),AALOAD)
                ||!(before.get(i+3) instanceof VarInsnNode column)||column.getOpcode()!=ILOAD||!opcode(before.get(i+4),BALOAD)
                ||!isCall(before.get(i+5),INVOKESTATIC,"java/lang/Boolean","toString","(Z)Ljava/lang/String;")
                ||!isCall(before.get(i+6),INVOKEINTERFACE,"com/android/modules/utils/TypedXmlSerializer","attribute","(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Lorg/xmlpull/v1/XmlSerializer;")
                ||!opcode(before.get(i+7),POP)||!variable(before.get(i+8),ALOAD,filters)||!variable(before.get(i+9),ILOAD,row.var)
                ||!opcode(before.get(i+10),AALOAD)||!(before.get(i+11) instanceof VarInsnNode serializer)||serializer.getOpcode()!=ALOAD
                ||!isCall(before.get(i+12),INVOKEVIRTUAL,"android/hardware/usb/AccessoryFilter","write","(Lorg/xmlpull/v1/XmlSerializer;)V"))continue;
            ((VarInsnNode)after.get(i)).var=device;
        }
    }

    private static void loopCatch(String owner,MethodNode method){
        if(!(owner.equals("android/os/Looper")&&method.name.equals("loop")||owner.equals("android/os/HandlerThread")&&method.name.equals("run"))||!method.desc.equals("()V")||method.tryCatchBlocks.isEmpty())return;
        var block=method.tryCatchBlocks.getLast();var entry=next(block.handler);
        if(!Objects.equals(block.type,"java/lang/Throwable")||!isCall(entry,INVOKESTATIC,HOST+"HostLooper","loopFailed","(Ljava/lang/Throwable;)Ljava/lang/Throwable;")||!opcode(next(entry),ATHROW)||next(next(entry))!=null||next(block.start)!=code(method).getFirst()||next(block.end)!=entry)return;
        method.tryCatchBlocks.removeLast();remove(method,next(entry),entry);
    }
    private static void callback(String owner,MethodNode method){
        String adapter=owner.equals("android/view/Choreographer")&&method.name.equals("doFrame")?"HostDisplayEvents":owner.equals("android/hardware/display/DisplayManagerGlobal$DisplayListenerDelegate")&&method.name.equals("handleDisplayEventInner")?"HostDisplay":null;
        if(adapter==null||method.tryCatchBlocks.isEmpty())return;
        List<AbstractInsnNode> ins=code(method);var block=method.tryCatchBlocks.getLast();
        if(ins.size()<10||!isCall(ins.get(0),INVOKESTATIC,HOST+adapter,"enterCallback","()Z")||!(ins.get(1) instanceof JumpInsnNode admit)||admit.getOpcode()!=IFNE||!opcode(ins.get(2),RETURN)||next(admit.label)!=ins.get(3)||next(block.start)!=ins.get(3)||block.type!=null)return;
        var leave=next(block.end);var handler=next(block.handler);
        if(!isCall(leave,INVOKESTATIC,HOST+adapter,"leaveCallback","()V")||!opcode(next(leave),RETURN)||!(handler instanceof VarInsnNode store)||store.getOpcode()!=ASTORE||!isCall(next(handler),INVOKESTATIC,HOST+adapter,"leaveCallback","()V")||!variable(next(next(handler)),ALOAD,store.var)||!opcode(next(next(next(handler))),ATHROW)||next(next(next(next(handler))))!=null)return;
        for(var node:ins)if(node instanceof JumpInsnNode jump&&jump.getOpcode()==GOTO&&next(jump.label)==leave)method.instructions.set(jump,new InsnNode(RETURN));
        method.tryCatchBlocks.removeLast();remove(method,ins.get(0),ins.get(1),ins.get(2),next(leave),leave,next(next(next(handler))),next(next(handler)),next(handler),handler);
    }

    private static void abi(String owner,MethodNode method){
        boolean fastData=owner.equals("com/android/internal/util/ArtFastDataInput")||owner.equals("com/android/internal/util/ArtFastDataOutput");
        for(var node:method.instructions.toArray()){
            if(node.getPrevious()==null&&node!=method.instructions.getFirst())continue;
            if(fastData&&!method.name.equals("<init>")&&node instanceof FieldInsnNode field&&field.getOpcode()==GETFIELD&&field.owner.equals(owner)&&field.name.equals("mBuffer")&&field.desc.equals("[B")){
                field.name="mBufferPtr";field.desc="J";
            }else if(fastData&&((method.name.equals("<init>")&&opcode(node,POP2)&&opcode(next(node),LCONST_0))||(!method.name.equals("<init>")&&opcode(node,SWAP)&&opcode(next(node),POP)))){
                remove(method,next(node));method.instructions.set(node,new MethodInsnNode(INVOKEVIRTUAL,"dalvik/system/VMRuntime","addressOf","(Ljava/lang/Object;)J",false));
            }else if(owner.equals(ARRAY)&&node instanceof FieldInsnNode field&&field.getOpcode()==GETFIELD&&field.owner.equals(ARRAY)&&field.name.equals("mData")&&field.desc.equals("[I")&&isCall(next(node),INVOKESTATIC,"java/util/Objects","nonNull","(Ljava/lang/Object;)Z")&&opcode(next(next(node)),I2L)){
                remove(method,next(next(node)),next(node));field.name="mDataAddress";field.desc="J";
            }else if(owner.equals(ARRAY)&&opcode(node,POP2)&&opcode(next(node),LCONST_0)){
                remove(method,next(node));method.instructions.set(node,new MethodInsnNode(INVOKEVIRTUAL,"dalvik/system/VMRuntime","addressOf","(Ljava/lang/Object;)J",false));
            }else if(owner.equals("android/content/res/ResourcesImpl$ThemeImpl")&&node instanceof FieldInsnNode field&&field.getOpcode()==GETFIELD&&field.owner.equals(ARRAY)&&field.desc.equals("[I")&&(field.name.equals("mData")||field.name.equals("mIndices"))){field.name+="Address";field.desc="J";}
            else if(owner.startsWith("dalvik/system/")||owner.startsWith("libcore/io/ClassPathURLStreamHandler")){
                if(isCall(node,INVOKESPECIAL,"java/util/jar/JarFile","<init>","(Ljava/lang/String;Z)V")&&opcode(previous(node),POP)&&opcode(previous(previous(node)),SWAP)){
                    remove(method,previous(previous(node)),previous(node));((MethodInsnNode)node).desc="(Ljava/lang/String;ZZ)V";
                }
            }
        }
        // Linux constants are data produced by an original native initializer,
        // not an alternative implementation of a Java algorithm.
        if(owner.equals("android/system/OsConstants")&&method.name.equals("<clinit>")){
            var ins=code(method);int end=ins.size()-1,start=end;
            while(start>=2&&ins.get(start-1) instanceof FieldInsnNode f&&f.getOpcode()==PUTSTATIC&&f.owner.equals(owner)&&f.desc.equals("I")&&ins.get(start-2) instanceof LdcInsnNode constant&&constant.cst instanceof Integer)start-=2;
            if(start<end&&opcode(ins.get(end),RETURN)){var at=ins.get(start);method.instructions.insertBefore(at,new MethodInsnNode(INVOKESTATIC,owner,"initConstants","()V",false));for(int i=start;i<end;i++)method.instructions.remove(ins.get(i));}
        }
    }

    /** Canonicalize only allocation plus the exact ART mapped-buffer constructor. */
    private static void mappedBuffers(MethodNode method){
        var allocations=new ArrayDeque<TypeInsnNode>();
        for(var node:method.instructions.toArray()){
            if(node instanceof TypeInsnNode test&&test.getOpcode()==INSTANCEOF&&test.desc.equals("java/nio/DirectByteBuffer"))
                method.instructions.set(node,new MethodInsnNode(INVOKESTATIC,HOST+"HostNio","isDirectByteBuffer","(Ljava/lang/Object;)Z",false));
            if(node instanceof TypeInsnNode allocation&&allocation.getOpcode()==NEW&&allocation.desc.equals("java/nio/DirectByteBuffer"))allocations.push(allocation);
            if(isCall(node,INVOKESPECIAL,"java/nio/DirectByteBuffer","<init>","(IJLjava/io/FileDescriptor;Ljava/lang/Runnable;Z)V")&&!allocations.isEmpty()){
                var allocation=allocations.pop();var duplicate=next(allocation);if(!opcode(duplicate,DUP))continue;
                remove(method,allocation,duplicate);
                method.instructions.set(node,new MethodInsnNode(INVOKESTATIC,HOST+"HostMappedBuffer","create","(IJLjava/io/FileDescriptor;Ljava/lang/Runnable;Z)Ljava/nio/MappedByteBuffer;",false));
            }
        }
    }
    private static List<String> tokens(String owner,MethodNode method){return tokens(owner,method,true);}
    private static List<String> tokens(String owner,MethodNode method,boolean portable){
        var labels=new IdentityHashMap<LabelNode,Integer>();int position=0;
        for(var node:method.instructions){if(node instanceof LabelNode label)labels.put(label,position);else if(node.getOpcode()>=0)position++;}
        var result=new ArrayList<String>();
        for(var node:method.instructions){
            int op=node.getOpcode();if(op<0)continue;
            String value=Integer.toString(op);
            if(node instanceof MethodInsnNode m){var c=portable?equivalent(owner,method,call(m)):call(m);value="call "+c;}
            else if(node instanceof FieldInsnNode f)value+=" "+unmap(f.owner)+"."+f.name+" "+unmap(f.desc);
            else if(node instanceof TypeInsnNode t)value+=" "+unmap(t.desc);
            else if(node instanceof VarInsnNode v)value+=" "+v.var;
            else if(node instanceof IntInsnNode i)value+=" "+i.operand;
            else if(node instanceof IincInsnNode i)value+=" "+i.var+" "+i.incr;
            else if(node instanceof LdcInsnNode l)value+=" "+constant(l.cst);
            else if(node instanceof JumpInsnNode j)value+=" ->"+labels.get(j.label);
            else if(node instanceof TableSwitchInsnNode s)value+=" "+s.min+":"+s.max+" "+labels.get(s.dflt)+" "+s.labels.stream().map(labels::get).toList();
            else if(node instanceof LookupSwitchInsnNode s)value+=" "+s.keys+" "+labels.get(s.dflt)+" "+s.labels.stream().map(labels::get).toList();
            else if(node instanceof MultiANewArrayInsnNode a)value+=" "+unmap(a.desc)+" "+a.dims;
            else if(node instanceof InvokeDynamicInsnNode d)value+=" "+d.name+" "+unmap(d.desc)+" "+constant(d.bsm)+" "+Arrays.stream(d.bsmArgs).map(FrameworkImplementationAudit::constant).toList();
            result.add(value);
        }
        for(var block:method.tryCatchBlocks)result.add("catch "+labels.get(block.start)+" "+labels.get(block.end)+" "+labels.get(block.handler)+" "+unmap(block.type));
        return result;
    }
    private static String constant(Object value){return unmap(value.getClass().getName()+":"+value);}
    private static ClassNode read(ZipFile file,ZipEntry entry)throws Exception{try(var stream=file.getInputStream(entry)){var node=new ClassNode();new ClassReader(stream).accept(node,ClassReader.SKIP_FRAMES);return node;}}
    private static String difference(List<String> original,List<String> actual){int at=0;while(at<original.size()&&at<actual.size()&&original.get(at).equals(actual.get(at)))at++;if(at==original.size()&&at==actual.size())return null;return "instruction "+at+", original="+(at<original.size()?original.get(at):"<end>")+", adapted="+(at<actual.size()?actual.get(at):"<end>")+" ("+original.size()+" -> "+actual.size()+" instructions)";}
    static String compare(String owner,MethodNode original,MethodNode adapted){
        int execution=ACC_STATIC|ACC_SYNCHRONIZED|ACC_NATIVE|ACC_ABSTRACT;
        if((original.access&execution)!=(adapted.access&execution))return "method execution flags changed";
        if(owner.equals("com/android/org/conscrypt/Platform")&&original.name.equals("getFileDescriptorFromSSLSocket")&&original.desc.equals("(Lcom/android/org/conscrypt/AbstractConscryptSocket;)Ljava/io/FileDescriptor;")){
            var expected=new MethodNode(ACC_STATIC,original.name,original.desc,null,null);
            expected.instructions.add(new VarInsnNode(ALOAD,0));
            expected.instructions.add(new MethodInsnNode(INVOKESTATIC,owner,"getFileDescriptor","(Ljava/net/Socket;)Ljava/io/FileDescriptor;",false));expected.instructions.add(new InsnNode(ARETURN));
            return difference(tokens(owner,expected),tokens(owner,adapted));
        }
        if(owner.equals("android/webkit/WebViewFactory")&&original.name.equals("getProviderClass")&&original.desc.equals("()Ljava/lang/Class;")){
            // Acquire the installed native browser. The original provider cache,
            // security checks, public WebView and View lifecycle remain unchanged.
            var expected=new MethodNode(ACC_PRIVATE|ACC_STATIC,original.name,original.desc,null,null);
            expected.instructions.add(new MethodInsnNode(INVOKESTATIC,"maclauncher/android/web/WebKitFactory","providerClass",original.desc,false));expected.instructions.add(new InsnNode(ARETURN));
            return difference(tokens(owner,expected),tokens(owner,adapted));
        }
        if(owner.equals("android/util/StatsLog")&&original.name.equals("loadNativeLibrary")&&original.desc.equals("()V")){
            // AOSP supplies this exact collector-free host boundary. Public event
            // construction, encoding and buffer release still compare unchanged.
            var expected=new MethodNode(ACC_PRIVATE|ACC_STATIC,original.name,original.desc,null,null);
            expected.instructions.add(new MethodInsnNode(INVOKESTATIC,owner,"loadNativeLibrary$ravenwood","()V",false));expected.instructions.add(new InsnNode(RETURN));
            return difference(tokens(owner,expected),tokens(owner,adapted));
        }
        if(owner.equals("android/os/ServiceManager")&&original.name.equals("getIServiceManager")&&original.desc.equals("()Landroid/os/IServiceManager;")){
            // The process service directory is the native/binder endpoint. Its
            // exact delegation is inspected, rather than exempting its body.
            var expected=new MethodNode(ACC_PRIVATE|ACC_STATIC,original.name,original.desc,null,null);expected.instructions.add(new MethodInsnNode(INVOKESTATIC,HOST+"HostServices","client",original.desc,false));expected.instructions.add(new InsnNode(ARETURN));
            return difference(tokens(owner,expected),tokens(owner,adapted));
        }
        serviceCalls(owner,original,adapted);platformLifecycle(owner,adapted);usbSnapshot(owner,original,adapted);
        lifecycle(owner,adapted);abi(owner,adapted);mappedBuffers(original);
        return difference(tokens(owner,original),tokens(owner,adapted));
    }
    public static void main(String[] args)throws Exception{
        if(args.length<2)throw new IllegalArgumentException("Expected publisher.jar adapted-framework.jar [report.txt]");
        var failures=new ArrayList<String>();var changed=new ArrayList<String>();int classes=0,methods=0,unchanged=0;
        try(var publisher=new ZipFile(args[0]);var artifact=new ZipFile(args[1])){
            var parents=new HashMap<String,String>();
            for(var entry:Collections.list(publisher.entries()))if(entry.getName().startsWith("dalvik/system/")&&entry.getName().endsWith(".class")){
                var type=read(publisher,entry);parents.put(type.name,type.superName);
            }
            loaderHierarchy(parents);
            for(var entry:Collections.list(publisher.entries())){
                if(!entry.getName().endsWith(".class")||entry.getName().startsWith("java/"))continue;
                classes++;var target=artifact.getEntry(entry.getName());
                if(target==null&&Set.of("com/github/luben/zstd/ZstdInputStream.class","com/github/luben/zstd/ZstdOutputStream.class","org/tukaani/xz/LZMAOutputStream.class").contains(entry.getName())){
                    var metadata=artifact.getEntry("META-INF/maclauncher/compile-only/"+entry.getName());
                    if(metadata!=null&&Arrays.equals(publisher.getInputStream(entry).readAllBytes(),artifact.getInputStream(metadata).readAllBytes()))target=metadata;
                }
                if(target==null){failures.add("MISSING CLASS "+entry.getName());continue;}
                ClassNode original=read(publisher,entry),adapted=read(artifact,target);var members=new HashMap<String,MethodNode>();for(var m:adapted.methods)members.put(m.name+unmap(m.desc),m);
                if((original.access&ACC_INTERFACE)!=0){
                    var fields=new HashMap<String,FieldNode>();for(var field:adapted.fields)fields.put(field.name+unmap(field.desc),field);
                    for(var field:original.fields){var actual=fields.get(field.name+field.desc);
                        if(actual==null||actual.access!=field.access||!Objects.equals(actual.value,field.value))failures.add(original.name+"."+field.name+": original interface field modifiers/value changed");
                    }
                }
                for(var m:original.methods){
                    if((m.access&(ACC_NATIVE|ACC_ABSTRACT))!=0)continue;methods++;
                    String name=original.name+"."+m.name+m.desc;var current=members.get(m.name+m.desc);
                    if((original.access&ACC_INTERFACE)!=0&&m.name.equals("<clinit>")&&current!=null){
                        var first=code(current).getFirst();
                        if(isCall(first,INVOKESTATIC,HOST+"JvmNativeMemory","initialize","()V"))current.instructions.remove(first);
                    }
                    if(m.name.equals("<clinit>")&&members.containsKey("hostInitializeNatives()V")){
                        var wrapper=new MethodNode(ACC_STATIC,"<clinit>","()V",null,null);
                        wrapper.instructions.add(new LdcInsnNode(Type.getObjectType(original.name)));
                        wrapper.instructions.add(new MethodInsnNode(INVOKESTATIC,HOST+"JvmNativeMemory","initializeClass","(Ljava/lang/Class;)V",false));
                        wrapper.instructions.add(new InsnNode(RETURN));
                        if(current==null||difference(tokens(original.name,wrapper,false),tokens(original.name,current,false))!=null){failures.add("Invalid native initializer wrapper "+name);continue;}
                        current=members.get("hostInitializeNatives()V");
                        current.name="<clinit>";
                    }
                    if(current==null){failures.add("MISSING BODY "+name);continue;}
                    int execution=ACC_STATIC|ACC_SYNCHRONIZED|ACC_NATIVE|ACC_ABSTRACT;
                    if((m.access&execution)==(current.access&execution)&&difference(tokens(original.name,m,false),tokens(original.name,current,false))==null){unchanged++;continue;}
                    changed.add(name);String problem=compare(original.name,m,current);if(problem!=null)failures.add(name+": "+problem);
                }
            }
        }
        String report="Publisher Java implementation comparison: "+classes+" classes; "+methods+" nonnative concrete methods; "+unchanged+" unchanged; "+changed.size()+" adapted; "+failures.size()+" rejected.\n"+
            "Scope: every publisher class except java.* supplied by the JVM; constructors and static initializers included. Native/abstract bodies are absent upstream and are checked separately.\n"+
            "Changed Java methods:\n"+String.join("\n",changed)+"\nRejected bodies:\n"+String.join("\n",failures)+"\n";
        if(args.length>2)Files.writeString(Path.of(args[2]),report);
        if(!failures.isEmpty())throw new AssertionError("Publisher Java implementation changed outside documented boundaries ("+failures.size()+"):\n"+String.join("\n",failures));
        System.out.println("PASS publisher Java implementations preserved: "+classes+" classes, "+methods+" bodies, "+changed.size()+" boundary adaptations");
    }
}
