import com.codedisaster.steamworks.*;
import java.lang.reflect.*;
import java.util.*;

public final class SteamABIProbe {
  private static final List<String> callbacks = new ArrayList<String>();
  private static <T> T callback(final Class<T> type) {
    return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, new InvocationHandler() {
      public Object invoke(Object proxy, Method method, Object[] args) {
        if (method.getDeclaringClass() == Object.class) {
          if (method.getName().equals("toString")) return "ProbeCallback";
          if (method.getName().equals("hashCode")) return System.identityHashCode(proxy);
          if (method.getName().equals("equals")) return proxy == args[0];
        }
        callbacks.add(method.getName() + ":" + Arrays.toString(args));
        return null;
      }
    }));
  }
  private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
  public static void main(String[] args) throws Exception {
    final String version = Version.getVersion();
    check(version.equals(args[0]), "Exact Java wrapper version mismatch");
    System.out.println("wrapper=" + version);
    System.out.println("jvm=" + System.getProperty("java.runtime.version"));
    System.out.println("cpu=" + System.getProperty("os.arch"));
    System.out.println("nativeInitType=" + SteamAPI.class.getDeclaredMethod("nativeInit").getReturnType().getName());
    final String helper = args[1], jni = args[2];
    if (version.equals("1.9.0")) {
      SteamAPI.class.getMethod("loadLibraries").invoke(null);
      check(SteamAPI.init(), "1.9 boolean Init failed");
      System.out.println("initResult=true");
    } else if (version.equals("1.10.0")) {
      final Class<?> loaderType = Class.forName("com.codedisaster.steamworks.SteamLibraryLoader");
      Object loader = Proxy.newProxyInstance(loaderType.getClassLoader(), new Class<?>[]{loaderType}, new InvocationHandler() {
        public Object invoke(Object proxy, Method method, Object[] values) {
          if (method.getName().equals("loadLibrary")) {
            String name = (String) values[0];
            if (!name.equals("steam_api") && !name.equals("steamworks4j")) throw new IllegalArgumentException("Unknown library");
            throw new AssertionError("The original resource loader should not be invoked after qualified agent preload");
          }
          return null;
        }
      });
      check(Boolean.TRUE.equals(SteamAPI.class.getMethod("loadLibraries", loaderType).invoke(null, loader)), "Native loader failed");
      Object result = SteamAPI.class.getMethod("initEx").invoke(null);
      check(result.toString().equals("OK"), "1.10 InitEx failed: " + result);
      System.out.println("initResult=" + result);
    } else throw new IllegalArgumentException("Unqualified wrapper version");
    SteamApps apps = new SteamApps();
    SteamFriends friends = new SteamFriends(callback(SteamFriendsCallback.class));
    SteamUtils utils = new SteamUtils(callback(SteamUtilsCallback.class));
    SteamUser user = new SteamUser(callback(SteamUserCallback.class));
    SteamUserStats stats = new SteamUserStats(callback(SteamUserStatsCallback.class));
    check(utils.getAppID() == 480, "Wrong isolated AppId");
    check(apps.getCurrentGameLanguage().equals("english"), "Wrong isolated language");
    check(apps.isSubscribed(), "Owned app not subscribed");
    check(!utils.isOverlayEnabled(), "Overlay must remain disabled");
    check(user.getSteamID() != null, "Missing user interface");
    check(friends.getPersonaName() != null && !friends.getPersonaName().isEmpty(), "Missing friend interface");
    System.out.println("friends=personaName");
    System.out.println("ordinary=AppId480,english,subscribed,overlayDisabled,userId");
    SteamAPICall call = stats.getNumberOfCurrentPlayers();
    check(call != null, "Async call missing");
    int pumps = 0;
    for (; pumps < 200; pumps++) {
      SteamAPI.runCallbacks();
      boolean found = false;
      for (String event : callbacks) if (event.startsWith("onNumberOfCurrentPlayersReceived:")) found = true;
      if (found) break;
      Thread.sleep(10);
    }
    check(pumps < 200, "Real JNI callback was not delivered");
    System.out.println("callback=" + callbacks);
    stats.dispose(); friends.dispose(); user.dispose(); utils.dispose(); apps.dispose();
    SteamAPI.shutdown();
    check(!SteamAPI.isSteamRunning(), "Java shutdown state stayed live");
    System.out.println("shutdown=clean");
  }
}
