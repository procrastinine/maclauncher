package com.maclauncher.android.macapk;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import java.util.*;
import jdk.internal.org.objectweb.asm.*;

/** Exact host-boundary adaptations; every other upstream member is retained. */
public final class PrivacyAgent implements Opcodes {
    private static final String BRIDGE = "com/maclauncher/android/macapk/PrivacyBridge";
    private static final String AUTH = "com/maclauncher/android/macapk/AuthBridge";
    private static final String CAPABILITIES = "com/maclauncher/android/macapk/Capabilities";
    private static final Map<String,String> IDENTITY = Map.ofEntries(
        Map.entry("BOARD","tangorpro"), Map.entry("BRAND","google"), Map.entry("DEVICE","tangorpro"),
        Map.entry("DISPLAY","MacLauncher Pixel Tablet"), Map.entry("HARDWARE","tangorpro"),
        Map.entry("HOST","android-build"), Map.entry("ID","ML1"), Map.entry("MANUFACTURER","Google"),
        Map.entry("MODEL","Pixel Tablet"), Map.entry("PRODUCT","tangorpro"), Map.entry("USER","android-build"));
    private static final Map<String,Set<String>> REQUIRED = Map.ofEntries(
        Map.entry("android/content/ClipboardManager", Set.of("hostPath()Z", "macapkHostClipboard()Ljava/awt/datatransfer/Clipboard;")),
        Map.entry("android/os/BatteryManager", Set.of("snapshot()Landroid/os/BatteryManager$Snapshot;")),
        Map.entry("android/os/Build", Set.of("<clinit>()V")),
        Map.entry("android/os/SystemProperties", Set.of("<clinit>()V", "get(Ljava/lang/String;)Ljava/lang/String;", "get(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "macapkPushToNative()V")),
        Map.entry("android/app/ActivityManager", Set.of("hostTotalBytes()J", "hostFreeBytes()J", "getDeviceConfigurationInfo()Landroid/content/pm/ConfigurationInfo;")),
        Map.entry("com/macapk/loader/MacApkPackageManager", Set.of("hasSystemFeature(Ljava/lang/String;)Z", "hasSystemFeature(Ljava/lang/String;I)Z", "getSystemAvailableFeatures()[Landroid/content/pm/FeatureInfo;")),
        Map.entry("com/macapk/loader/AudioInputBridge", Set.of("available()Z")),
        Map.entry("com/macapk/loader/CameraBridge", Set.of("isAvailable()Z")),
        Map.entry("com/macapk/gms/GoogleAuthenticator", Set.of("available()Z", "accounts()[Landroid/accounts/Account;",
            "getAuthTokenBundle(Landroid/accounts/Account;Ljava/lang/String;)Landroid/os/Bundle;",
            "peekAuthToken(Landroid/accounts/Account;Ljava/lang/String;)Ljava/lang/String;",
            "setAuthToken(Landroid/accounts/Account;Ljava/lang/String;Ljava/lang/String;)V", "invalidateAuthToken(Ljava/lang/String;Ljava/lang/String;)V")),
        Map.entry("com/macapk/gms/GmsStore", Set.of("accountNames()Ljava/util/List;", "masterToken(Ljava/lang/String;)Ljava/lang/String;",
            "authToken(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "authTokenRaw(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            "putAccount(Ljava/lang/String;Ljava/lang/String;)V", "putAuthToken(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;J)V")),
        Map.entry("com/macapk/gms/GoogleAuthClient", Set.of("fetchScopedToken(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            "fetchAppToken(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ZZZLjava/lang/String;Ljava/util/Map;II)Ljava/util/Map;",
            "exchangeOAuthToken(Ljava/lang/String;)Ljava/lang/String;")),
        Map.entry("com/macapk/gms/NativeSignIn", Set.of("available()Z")));
    private static final Set<String> transformed = Collections.synchronizedSet(new HashSet<>());

    public static void premain(String options, Instrumentation instrumentation) throws Exception {
        // Upstream also runs pure Java package tools. They inherit JVM options
        // but have no Android runtime or application entry to adapt.
        if(ClassLoader.getSystemClassLoader().getResource("android/os/Build.class")==null)return;
        final boolean accountOwner="account-owner".equals(options);
        final Set<String> required=new HashSet<>(REQUIRED.keySet());
        if(accountOwner)required.removeIf(name->name.startsWith("com/macapk/gms/"));
        instrumentation.addTransformer(new ClassFileTransformer() {
            @Override public byte[] transform(ClassLoader loader,String name,Class<?> prior,ProtectionDomain domain,byte[] bytes) {
                if (!required.contains(name)) return null;
                try { return adapt(name,bytes); }
                catch (Throwable failure) {
                    System.err.println("Mac.apk cannot apply the selected privacy policy: " + name);
                    Runtime.getRuntime().halt(78);
                    return null;
                }
            }
        });
        // Validate before application entry. Incompatible providers cannot silently
        // retain their original host clipboard, battery or capture implementation.
        for (String name:required) Class.forName(name.replace('/','.'),false,ClassLoader.getSystemClassLoader());
        if (!transformed.containsAll(required)) throw new IllegalStateException("Mac.apk privacy policy is incomplete.");
    }

    private static byte[] adapt(String name,byte[] bytes) {
        ClassReader reader=new ClassReader(bytes);
        ClassWriter writer=new ClassWriter(reader,ClassWriter.COMPUTE_MAXS);
        Set<String> found=new HashSet<>();
        reader.accept(new ClassVisitor(ASM8,writer) {
            @Override public FieldVisitor visitField(int access,String field,String descriptor,String signature,Object value) {
                if (name.equals("android/os/Build") && IDENTITY.containsKey(field) && descriptor.equals("Ljava/lang/String;")) value=IDENTITY.get(field);
                return super.visitField(access,field,descriptor,signature,value);
            }
            @Override public MethodVisitor visitMethod(int access,String method,String descriptor,String signature,String[] exceptions) {
                String key=method+descriptor;
                MethodVisitor original=super.visitMethod(access,method,descriptor,signature,exceptions);
                if (!REQUIRED.get(name).contains(key)) return original;
                if ((access&ACC_NATIVE)!=0) throw new IllegalStateException("Unexpected native policy boundary");
                found.add(key);
                if (method.equals("getDeviceConfigurationInfo") || name.equals("android/os/SystemProperties") && !method.equals("<clinit>") || name.equals("com/macapk/loader/MacApkPackageManager")) return new MethodVisitor(ASM8,original) {
                    @Override public void visitCode() {
                        super.visitCode();
                        if(method.equals("macapkPushToNative")) {
                            super.visitFieldInsn(GETSTATIC,name,"KNOWN","Ljava/util/Map;");
                            super.visitMethodInsn(INVOKESTATIC,CAPABILITIES,"properties","(Ljava/util/Map;)V",false);
                        }
                    }
                    @Override public void visitInsn(int instruction) {
                        if(instruction==ARETURN) {
                            if(method.equals("getDeviceConfigurationInfo")) {
                                super.visitMethodInsn(INVOKESTATIC,CAPABILITIES,"configuration","(Ljava/lang/Object;)Ljava/lang/Object;",false);
                                super.visitTypeInsn(CHECKCAST,"android/content/pm/ConfigurationInfo");
                            } else if(method.equals("getSystemAvailableFeatures")) {
                                super.visitMethodInsn(INVOKESTATIC,CAPABILITIES,"features","(Ljava/lang/Object;)Ljava/lang/Object;",false);
                                super.visitTypeInsn(CHECKCAST,"[Landroid/content/pm/FeatureInfo;");
                            } else if(method.equals("get")) {
                                super.visitVarInsn(ALOAD,0);super.visitInsn(SWAP);
                                super.visitMethodInsn(INVOKESTATIC,CAPABILITIES,"property","(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",false);
                            }
                        } else if(instruction==IRETURN && method.equals("hasSystemFeature")) {
                            super.visitVarInsn(ALOAD,1);super.visitInsn(SWAP);
                            super.visitMethodInsn(INVOKESTATIC,CAPABILITIES,"feature","(Ljava/lang/String;Z)Z",false);
                        }
                        super.visitInsn(instruction);
                    }
                };
                if (method.equals("<clinit>")) return new MethodVisitor(ASM8,original) {
                    @Override public void visitInsn(int instruction) {
                        if (instruction==RETURN) {
                            if(name.equals("android/os/Build")) {
                                for(var entry:IDENTITY.entrySet()) {super.visitLdcInsn(entry.getValue());super.visitFieldInsn(PUTSTATIC,name,entry.getKey(),"Ljava/lang/String;");}
                                super.visitFieldInsn(GETSTATIC,"android/os/Build$VERSION","RELEASE","Ljava/lang/String;");
                                super.visitFieldInsn(GETSTATIC,"android/os/Build$VERSION","INCREMENTAL","Ljava/lang/String;");
                                super.visitMethodInsn(INVOKESTATIC,BRIDGE,"fingerprint","(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",false);
                                super.visitFieldInsn(PUTSTATIC,name,"FINGERPRINT","Ljava/lang/String;");
                            } else {
                                super.visitFieldInsn(GETSTATIC,name,"KNOWN","Ljava/util/Map;");
                                super.visitMethodInsn(INVOKESTATIC,BRIDGE,"properties","(Ljava/util/Map;)V",false);
                            }
                        }
                        super.visitInsn(instruction);
                    }
                };
                original.visitCode();
                if(name.equals("com/macapk/gms/GoogleAuthenticator")&&method.equals("available")) {
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"enabled","()Z",false);original.visitInsn(IRETURN);
                } else if(method.equals("accounts")) {
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"accounts","()Ljava/lang/Object;",false);
                    original.visitTypeInsn(CHECKCAST,"[Landroid/accounts/Account;");original.visitInsn(ARETURN);
                } else if(method.equals("getAuthTokenBundle")) {
                    original.visitVarInsn(ALOAD,0);original.visitVarInsn(ALOAD,1);
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"tokenBundle","(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;",false);
                    original.visitTypeInsn(CHECKCAST,"android/os/Bundle");original.visitInsn(ARETURN);
                } else if(method.equals("peekAuthToken")) {
                    original.visitVarInsn(ALOAD,0);original.visitVarInsn(ALOAD,1);
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"peekAccount","(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/String;",false);original.visitInsn(ARETURN);
                } else if(method.equals("accountNames")) {
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"accountNames","()Ljava/util/List;",false);original.visitInsn(ARETURN);
                } else if(method.equals("authToken")||method.equals("authTokenRaw")||method.equals("fetchScopedToken")) {
                    original.visitVarInsn(ALOAD,0);original.visitVarInsn(ALOAD,1);
                    original.visitMethodInsn(INVOKESTATIC,AUTH,method.equals("fetchScopedToken")?"token":"peek","(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",false);original.visitInsn(ARETURN);
                } else if(method.equals("fetchAppToken")) {
                    original.visitVarInsn(ALOAD,0);original.visitVarInsn(ALOAD,1);
                    original.visitVarInsn(ILOAD,4);original.visitVarInsn(ILOAD,5);original.visitVarInsn(ILOAD,6);
                    original.visitVarInsn(ALOAD,7);original.visitVarInsn(ALOAD,8);
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"appToken","(Ljava/lang/String;Ljava/lang/String;ZZZLjava/lang/String;Ljava/util/Map;)Ljava/util/Map;",false);original.visitInsn(ARETURN);
                } else if(method.equals("invalidateAuthToken")) {
                    original.visitVarInsn(ALOAD,0);original.visitVarInsn(ALOAD,1);
                    original.visitMethodInsn(INVOKESTATIC,AUTH,"invalidate","(Ljava/lang/String;Ljava/lang/String;)V",false);original.visitInsn(RETURN);
                } else if(method.equals("masterToken")||method.equals("exchangeOAuthToken")) {
                    original.visitInsn(ACONST_NULL);original.visitInsn(ARETURN);
                } else if(method.equals("setAuthToken")||method.equals("putAuthToken")||method.equals("putAccount")) {
                    original.visitTypeInsn(NEW,"java/lang/SecurityException");original.visitInsn(DUP);
                    original.visitLdcInsn("Account credentials are managed by the selected Android provider.");
                    original.visitMethodInsn(INVOKESPECIAL,"java/lang/SecurityException","<init>","(Ljava/lang/String;)V",false);original.visitInsn(ATHROW);
                } else if (method.equals("hostPath") || method.equals("available") || method.equals("isAvailable")) {
                    original.visitInsn(ICONST_0);original.visitInsn(IRETURN);
                } else if (method.equals("hostTotalBytes") || method.equals("hostFreeBytes")) {
                    original.visitLdcInsn(method.equals("hostTotalBytes") ? 8L*1024*1024*1024 : 6L*1024*1024*1024);
                    original.visitInsn(LRETURN);
                } else if (method.equals("macapkHostClipboard")) {
                    original.visitMethodInsn(INVOKESTATIC,BRIDGE,"clipboard","()Ljava/awt/datatransfer/Clipboard;",false);
                    original.visitInsn(ARETURN);
                } else if (method.equals("snapshot")) {
                    String type="android/os/BatteryManager$Snapshot";
                    original.visitTypeInsn(NEW,type);original.visitInsn(DUP);original.visitMethodInsn(INVOKESPECIAL,type,"<init>","()V",false);
                    original.visitInsn(DUP);original.visitIntInsn(BIPUSH,100);original.visitFieldInsn(PUTFIELD,type,"capacity","I");
                    original.visitInsn(DUP);original.visitInsn(ICONST_5);original.visitFieldInsn(PUTFIELD,type,"status","I");
                    original.visitInsn(ARETURN);
                } else throw new IllegalStateException("Unexpected policy boundary");
                original.visitMaxs(0,0);original.visitEnd();
                return null;
            }
        },0);
        if (!found.equals(REQUIRED.get(name))) throw new IllegalStateException("Changed policy method descriptors");
        transformed.add(name);
        return writer.toByteArray();
    }
}
