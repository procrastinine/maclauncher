package com.maclauncher.android.macapk;

import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.*;

/** Trusted account-owner commands. Game classes and master tokens never enter stdout. */
public final class AccountControl {
    private static Class<?> store()throws Exception{return Class.forName("com.macapk.gms.GmsStore");}
    private static Object call(String method,Class<?>[] types,Object...values)throws Exception{return store().getMethod(method,types).invoke(null,values);}
    private static List<String> names()throws Exception{
        Object raw=call("accountNames",new Class<?>[0]);List<String> out=new ArrayList<>();
        if(raw instanceof List<?> list)for(Object item:list)if(item instanceof String name&&!name.isBlank()&&name.length()<=1024&&!name.chars().anyMatch(c->c<32||c==127))out.add(name);
        if(out.size()>100)throw new IllegalStateException();return out;
    }
    private static Map<String,Object> error(int code){return Map.of("ok",false,"error",Map.of("code",code));}
    private static String hex(byte[] value){return HexFormat.of().formatHex(value);}
    private static String string(Object value){if(!(value instanceof String text)||text.isBlank()||text.length()>16384||text.indexOf('\0')>=0)throw new IllegalArgumentException();return text;}
    @SuppressWarnings("unchecked") private static Map<String,Object> verify(Map<String,Object> input)throws Exception{
        if(!(input.get("apks") instanceof List<?> apks)||apks.isEmpty()||apks.size()>64)throw new IllegalArgumentException();
        Class<?> builderType=Class.forName("com.android.apksig.ApkVerifier$Builder");
        List<Map<String,String>> signers=null;String packageName=null;
        for(Object raw:apks){
            String file=string(raw);Object builder=builderType.getConstructor(File.class).newInstance(new File(file));
            builderType.getMethod("setMinCheckedPlatformVersion",int.class).invoke(builder,29);
            builderType.getMethod("setMaxCheckedPlatformVersion",int.class).invoke(builder,29);
            Object verifier=builderType.getMethod("build").invoke(builder),result=verifier.getClass().getMethod("verify").invoke(verifier);
            if(!Boolean.TRUE.equals(result.getClass().getMethod("isVerified").invoke(result)))return error(9);
            List<Map<String,String>> current=new ArrayList<>();
            for(Object value:(List<?>)result.getClass().getMethod("getSignerCertificates").invoke(result)){
                byte[] encoded=((X509Certificate)value).getEncoded();current.add(Map.of("sha256",hex(MessageDigest.getInstance("SHA-256").digest(encoded)),"sha1",hex(MessageDigest.getInstance("SHA-1").digest(encoded))));
            }
            current.sort(Comparator.comparing(value->value.get("sha256")));
            if(current.isEmpty()||signers!=null&&!signers.equals(current))return error(9);
            signers=current;
            Class<?> manifestType=Class.forName("com.macapk.loader.Manifest");
            Object manifest=manifestType.getMethod("parse",File.class,String.class).invoke(null,new File(""),file);
            String pkg=(String)manifestType.getField("packageName").get(manifest);
            if(pkg==null||!pkg.matches("[A-Za-z][\\w]*(?:\\.[A-Za-z][\\w]*)+")||packageName!=null&&!packageName.equals(pkg))return error(9);
            packageName=pkg;
        }
        return Map.of("ok",true,"packageName",packageName,"signers",signers);
    }
    @SuppressWarnings("unchecked") private static Map<String,Object> execute(Map<String,Object> input)throws Exception{
        String operation=string(input.get("operation"));
        if(operation.equals("verify"))return verify(input);
        if(operation.equals("accounts"))return Map.of("ok",true,"accounts",names().stream().map(name->Map.of("name",name,"type","com.google")).toList());
        String account=string(input.get("account"));
        if(operation.equals("register")){
            String master=string(input.get("aasToken"));
            if(account.length()>1024||!account.contains("@")||account.chars().anyMatch(c->c<=32||c==127)||master.chars().anyMatch(c->c<=32||c==127))return error(9);
            call("putAccount",new Class<?>[]{String.class,String.class},account,master);
            call("invalidateAllTokens",new Class<?>[]{String.class},account);
            return Map.of("ok",true,"completed",names().contains(account));
        }
        if(!names().contains(account))return error(9);
        if(operation.equals("remove")){call("removeAccount",new Class<?>[]{String.class},account);return Map.of("ok",true,"completed",!names().contains(account));}
        // Per-app and per-nonce tokens are deliberately not put in the supplier's
        // global scope cache. A peek is empty; invalidation has no cached entry.
        if(operation.equals("peekToken"))return Map.of("ok",true);
        if(operation.equals("invalidateToken"))return Map.of("ok",true,"completed",true);
        if(!operation.equals("token"))throw new IllegalArgumentException();
        if(!Boolean.TRUE.equals(input.get("networkAllowed")))return error(3);
        String service=string(input.get("service")),pkg=string(input.get("packageName")),sha1=string(input.get("certificateSha1"));
        if(!pkg.matches("[A-Za-z][\\w]*(?:\\.[A-Za-z][\\w]*)+")||!sha1.matches("[a-f0-9]{40}"))return error(9);
        Map<String,Object> options=input.get("options") instanceof Map<?,?> map?(Map<String,Object>)map:Map.of();
        Map<String,String> extra=new LinkedHashMap<>();
        for(String key:List.of("oauth2_prompt","it_caveat_types","include_granted_scopes"))if(options.get(key) instanceof String value&&value.length()<=16384)extra.put(key,value);
        String requestOptions=options.get("token_request_options") instanceof String value&&value.length()<=16384?value:null;
        Class<?> auth=Class.forName("com.macapk.gms.GoogleAuthClient");
        Object raw=auth.getMethod("fetchAppToken",String.class,String.class,String.class,String.class,boolean.class,boolean.class,boolean.class,String.class,Map.class,int.class,int.class)
            .invoke(null,account,service,pkg,sha1,"1".equals(options.get("oauth2_include_email")),"1".equals(options.get("oauth2_include_profile")),false,requestOptions,extra,15000,30000);
        if(!(raw instanceof Map<?,?> reply)){
            Object reason=auth.getMethod("lastError").invoke(null);
            return error(reason instanceof String value&&(value.contains("NeedsBrowser")||value.contains("Permission")||value.contains("consent"))?4:5);
        }
        Object token=reply.get("Auth");
        if(!(token instanceof String value)||value.isBlank())return error(reply.containsKey("Permission")||reply.containsKey("ConsentDataBase64")||reply.containsKey("issueAdvice")?4:5);
        Map<String,Object> result=new LinkedHashMap<>();result.put("ok",true);result.put("token",token);
        if(reply.get("Expiry") instanceof String expiry)try{long seconds=Long.parseLong(expiry)-System.currentTimeMillis()/1000;if(seconds>0)result.put("expirySeconds",seconds);}catch(NumberFormatException ignored){}
        return result;
    }
    public static void main(String[] args)throws Exception{
        Map<String,Object> result;
        try{
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();
            for(int value;(value=System.in.read())>=0&&value!='\n';){if(bytes.size()>=1024*1024)throw new IllegalArgumentException();bytes.write(value);}
            Object decoded=JsonRpc.decode(bytes.toString(StandardCharsets.UTF_8));
            if(!(decoded instanceof Map<?,?> map))throw new IllegalArgumentException();
            @SuppressWarnings("unchecked") Map<String,Object> input=(Map<String,Object>)map;result=execute(input);
        }catch(Throwable failure){result=error(5);}
        System.out.println(JsonRpc.encode(result));
    }
}
