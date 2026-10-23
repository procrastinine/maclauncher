package api;
public interface Callback {
    default int apply(Runnable completion){completion.run();return 42;}
}
