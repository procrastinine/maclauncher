import java.lang.reflect.*;
import java.util.*;
import java.util.function.Predicate;

public final class DesugaredCollectionsProbe {
    public static void main(String[] args) throws Exception {
        Collection<Integer> values = Collections.synchronizedCollection(new ArrayList<>(List.of(1, 2, 3)));
        Class<?> type = values.getClass();
        Field mutex = type.getDeclaredField("mutex"), delegate = type.getDeclaredField("c");
        mutex.setAccessible(true);
        delegate.setAccessible(true);
        if (mutex.get(values) != values) throw new AssertionError("Collection monitor ownership changed");
        Object monitor = new Object();
        Constructor<?> constructor = type.getDeclaredConstructor(Collection.class, Object.class);
        constructor.setAccessible(true);
        Collection<?> second = (Collection<?>) constructor.newInstance(delegate.get(values), monitor);
        if (mutex.get(second) != monitor) throw new AssertionError("Explicit collection monitor was lost");
        values.add(4);
        if (second.size() != 4) throw new AssertionError("Collection delegate was copied");
        if (args.length != 0) {
            Class<?> desugared = Class.forName("j$.util.DesugarCollections");
            Method remove = desugared.getDeclaredMethod("removeIf", Collection.class, Predicate.class);
            remove.setAccessible(true);
            if (!Boolean.TRUE.equals(remove.invoke(null, values, (Predicate<Integer>) n -> n % 2 == 0)))
                throw new AssertionError("Original desugared removeIf did not mutate its delegate");
            if (!new ArrayList<>(second).equals(List.of(1, 3))) throw new AssertionError("Wrong collection result");
            Map<String, Integer> original = new HashMap<>();
            @SuppressWarnings("unchecked") Map<String, Integer> wrapped = (Map<String, Integer>)
                desugared.getMethod("synchronizedMap", Map.class).invoke(null, original);
            wrapped.put("retained", 7);
            if (!Integer.valueOf(7).equals(original.get("retained"))) throw new AssertionError("Map delegate was copied");
            System.out.println("PASS original Android desugared collection operations");
        }
        System.out.println("PASS shared JDK collection delegate and monitor ownership");
    }
}
