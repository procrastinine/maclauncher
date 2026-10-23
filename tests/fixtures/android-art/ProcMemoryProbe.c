// Invoke the new endpoint's original upstream Bionic check, without running
// unrelated process/syscall checks or copying its accounting expectations.
#define main original_aim_proc_main
#include AIM_PROC_TEST
#undef main
int main(void) {
    RUN(smaps);
    DONE();
}
