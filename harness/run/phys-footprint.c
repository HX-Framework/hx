// phys_footprint of a process on macOS, for harness/run/measure.ts.
//
// `ps` reports the resident set size, which on macOS still counts pages a
// process handed back to the allocator as reusable (malloc_zone_pressure_relief
// marks them, the kernel keeps them resident until it needs them). The number
// Activity Monitor shows as "Memory" is the physical footprint, which the
// kernel keeps per process and hands out through proc_pid_rusage(2). This
// helper prints both for one pid, in bytes: `<phys_footprint> <resident_size>`.
// measure.ts compiles it with the runner's cc when it runs on macOS.
#include <stdio.h>
#include <stdlib.h>
#include <libproc.h>
#include <sys/resource.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: phys-footprint <pid>\n");
    return 64;
  }
  int pid = atoi(argv[1]);
  struct rusage_info_v0 ri;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&ri) != 0) {
    return 1;
  }
  printf("%llu %llu\n", (unsigned long long)ri.ri_phys_footprint, (unsigned long long)ri.ri_resident_size);
  return 0;
}
