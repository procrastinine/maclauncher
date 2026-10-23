#include <utils/Timers.h>
#include <utils/Condition.h>
#include <cassert>
#include <cstdio>
#include <thread>
#include <chrono>

static int64_t now(clockid_t clock) {
    timespec value{};
    assert(clock_gettime(clock, &value) == 0);
    return int64_t(value.tv_sec) * 1000000000LL + value.tv_nsec;
}

int main() {
    const clockid_t clocks[] = {CLOCK_REALTIME, CLOCK_UPTIME_RAW,
        CLOCK_PROCESS_CPUTIME_ID, CLOCK_THREAD_CPUTIME_ID, CLOCK_MONOTONIC_RAW};
    for (int domain = 0; domain < 5; ++domain) {
        const auto before = now(clocks[domain]);
        const auto actual = systemTime(domain);
        const auto after = now(clocks[domain]);
        assert(actual >= before && actual <= after);
    }
    assert(toMillisecondTimeoutDelay(1, 1) == 0);
    assert(toMillisecondTimeoutDelay(1, 2) == 1);
    assert(toMillisecondTimeoutDelay(1, INT64_MAX) == -1);
    android::Mutex mutex;
    android::Condition condition;
    mutex.lock();
    assert(condition.waitRelative(mutex, -1) == -ETIMEDOUT);
    const auto before = now(CLOCK_UPTIME_RAW);
    assert(condition.waitRelative(mutex, 10000000) == -ETIMEDOUT);
    const auto elapsed = now(CLOCK_UPTIME_RAW) - before;
    assert(elapsed >= 9000000 && elapsed < 2000000000);
    bool signaled = false;
    std::thread notifier([&] {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        android::Mutex::Autolock lock(mutex);
        signaled = true;
        condition.signal();
    });
    while (!signaled) assert(condition.waitRelative(mutex, 2000000000) == 0);
    mutex.unlock();
    notifier.join();
    puts("PASS original libutils clocks and relative condition wait");
}
