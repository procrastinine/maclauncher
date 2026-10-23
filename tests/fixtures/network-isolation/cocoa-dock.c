#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>

int main(void) {
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t result = bootstrap_look_up(bootstrap_port, "com.apple.dock.server", &port);
    if (result != KERN_SUCCESS) {
        fprintf(stderr, "Dock menu endpoint unavailable: %d\n", result);
        return 1;
    }
    mach_port_deallocate(mach_task_self(), port);
    puts("Dock menu endpoint available");
    return 0;
}
