package com.maclauncher.android.macapk;

import java.lang.reflect.Array;
import java.util.*;

/** Authentication delegates to one selected, authenticated Android account owner. */
public final class AuthBridge {
    public static boolean enabled(){return System.getenv("MACLAUNCHER_GOOGLE_SOCKET")!=null&&System.getenv("MACLAUNCHER_GOOGLE_CAPABILITY")!=null;}
    private static Map<String,Object> request(String operation,Map<String,Object> values)throws Exception{
        if(!enabled())throw failure(6);
        Map<String,Object> request=new LinkedHashMap<>(values);request.put("operation",operation);
        request.put("capability",System.getenv("MACLAUNCHER_GOOGLE_CAPABILITY"));
        Map<String,Object> result=JsonRpc.exchange(System.getenv("MACLAUNCHER_GOOGLE_SOCKET"),request,operation.equals("token")?60_000:2_000);
        if(!Boolean.TRUE.equals(result.get("ok"))){
            Object error=result.get("error");int code=6;
            if(error instanceof Map<?,?> map&&map.get("code") instanceof Number number)code=number.intValue();
            throw failure(code);
        }
        return result;
    }
    private static Exception failure(int code)throws Exception{
        if(code==3)return new java.io.IOException("Google authentication requires network access.");
        String type=code==4?"android.accounts.OperationCanceledException":"android.accounts.AuthenticatorException";
        return (Exception)Class.forName(type).getConstructor(String.class).newInstance("Google authentication is unavailable for this request.");
    }
    private static Map<String,Object> account(String name){return Map.of("name",name,"type","com.google");}
    private static String name(Object account)throws Exception{
        if(account==null||!"com.google".equals(account.getClass().getField("type").get(account)))throw failure(6);
        return (String)account.getClass().getField("name").get(account);
    }
    public static List<String> accountNames(){
        List<String> names=new ArrayList<>();
        try{Object raw=request("accounts",Map.of()).get("accounts");
            if(raw instanceof List<?> list)for(Object value:list)if(value instanceof Map<?,?> record&&"com.google".equals(record.get("type"))&&record.get("name") instanceof String name&&!name.isEmpty())names.add(name);
        }catch(Exception ignored){}
        return names;
    }
    public static Object accounts()throws Exception{
        List<String> names=accountNames();Class<?> type=Class.forName("android.accounts.Account");
        Object values=Array.newInstance(type,names.size());
        for(int i=0;i<names.size();i++)Array.set(values,i,type.getConstructor(String.class,String.class).newInstance(names.get(i),"com.google"));
        return values;
    }
    private static Map<String,Object> tokenReply(String operation,String account,String service,Map<String,Object> options)throws Exception{
        if(account==null||account.isEmpty()||service==null||service.isEmpty())throw failure(7);
        return request(operation,Map.of("account",account(account),"service",service,"options",options));
    }
    private static String value(Map<String,Object> result){Object token=result.get("token");return token instanceof String text&&!text.isEmpty()?text:null;}
    public static Object tokenBundle(Object account,String service)throws Exception{
        String name=name(account),token=value(tokenReply("token",name,service,Map.of()));
        if(token==null)throw failure(5);
        Class<?> type=Class.forName("android.os.Bundle");Object bundle=type.getConstructor().newInstance();
        var put=type.getMethod("putString",String.class,String.class);
        put.invoke(bundle,"authAccount",name);put.invoke(bundle,"accountType","com.google");put.invoke(bundle,"authtoken",token);
        return bundle;
    }
    public static String peekAccount(Object account,String service){try{return peek(name(account),service);}catch(Exception ignored){return null;}}
    public static String peek(String account,String service){try{return value(tokenReply("peekToken",account,service,Map.of()));}catch(Exception ignored){return null;}}
    public static String token(String account,String service){try{return value(tokenReply("token",account,service,Map.of()));}catch(Exception ignored){return null;}}
    public static Map<String,String> appToken(String account,String service,boolean email,boolean profile,boolean consented,String requestOptions,Map<String,String> extra){
        try{
            Map<String,Object> options=new LinkedHashMap<>();options.put("oauth2_include_email",email?"1":"0");options.put("oauth2_include_profile",profile?"1":"0");
            if(requestOptions!=null)options.put("token_request_options",requestOptions);
            if(consented)options.put("has_permission","1");
            if(extra!=null)for(var entry:extra.entrySet())if(Set.of("oauth2_prompt","it_caveat_types","include_granted_scopes").contains(entry.getKey())&&entry.getValue()!=null)options.put(entry.getKey(),entry.getValue());
            Map<String,Object> reply=tokenReply("token",account,service,options);String token=value(reply);if(token==null)return null;
            Map<String,String> result=new HashMap<>();result.put("Auth",token);result.put("Email",account);
            if(reply.get("expirySeconds") instanceof Number expiry)result.put("Expiry",String.valueOf(expiry.longValue()));
            return result;
        }catch(Exception ignored){return null;}
    }
    public static void invalidate(String type,String token){
        if(!"com.google".equals(type)||token==null)return;
        try{List<String> accounts=accountNames();if(accounts.size()==1)request("invalidateToken",Map.of("account",account(accounts.get(0)),"token",token));}catch(Exception ignored){}
    }
}
