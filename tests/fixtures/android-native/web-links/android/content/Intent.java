package android.content;

/** Test-only input carrier for the pure URI parser; no Android lifecycle or JNI. */
public final class Intent {
    private final String action,data;
    public Intent(String action,String data){this.action=action;this.data=data;}
    public String getAction(){return action;}
    public String getDataString(){return data;}
}
