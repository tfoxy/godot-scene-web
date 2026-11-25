// Linux/glibc-only diagnostic preload. Trace large allocations without changing allocator policy.
// Deep-bound DSOs can bypass this preload; absence from the trace is not proof of no allocation.
// Build as a shared library (-shared -fPIC -g -pthread); pass it to the memory probe's --alloc-tracer.
#define _GNU_SOURCE
#include <execinfo.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

extern void *__libc_malloc(size_t);
extern void *__libc_calloc(size_t, size_t);
extern void *__libc_realloc(void *, size_t);
extern void __libc_free(void *);

static int trace_fd = -1;
// A preload must not allocate dynamic TLS while intercepting the loader's own free().
static __thread int inside __attribute__((tls_model("initial-exec")));
static void *tracked[8192];
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;

__attribute__((constructor)) static void init(void) {
  const char *path = getenv("RS_ALLOC_TRACE");
  if (path) trace_fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
}

static const char *phase(void) {
  const char *value = getenv("GRC_TEST_MEMORY_PHASE");
  return value ? value : "initial";
}

static void allocated(void *ptr, size_t size) {
  if (trace_fd < 0 || !ptr || size < (8u << 20) || inside) return;
  inside = 1;
  pthread_mutex_lock(&mutex);
  size_t index;
  for (index = 0; index < 8192; ++index) {
    if (!tracked[index]) { tracked[index] = ptr; break; }
  }
  if (index == 8192) dprintf(trace_fd, "ERROR allocation trace capacity exceeded\n");
  char name[16] = {0};
  pthread_getname_np(pthread_self(), name, sizeof(name));
  dprintf(trace_fd, "ALLOC pid=%d ptr=%p bytes=%zu phase=%s tid=%ld thread=%s\n",
          getpid(), ptr, size, phase(), syscall(SYS_gettid), name);
  void *stack[32];
  int count = backtrace(stack, 32);
  backtrace_symbols_fd(stack, count, trace_fd);
  pthread_mutex_unlock(&mutex);
  inside = 0;
}

static void freed(void *ptr) {
  if (trace_fd < 0 || !ptr || inside) return;
  inside = 1;
  pthread_mutex_lock(&mutex);
  for (size_t index = 0; index < 8192; ++index) {
    if (tracked[index] == ptr) {
      tracked[index] = NULL;
      dprintf(trace_fd, "FREE pid=%d ptr=%p phase=%s\n", getpid(), ptr, phase());
      break;
    }
  }
  pthread_mutex_unlock(&mutex);
  inside = 0;
}

void *malloc(size_t size) {
  void *ptr = __libc_malloc(size);
  allocated(ptr, size);
  return ptr;
}
void *calloc(size_t count, size_t size) {
  void *ptr = __libc_calloc(count, size);
  if (!size || count <= SIZE_MAX / size) allocated(ptr, count * size);
  return ptr;
}
void *realloc(void *ptr, size_t size) {
  uintptr_t old = (uintptr_t)ptr;
  void *next = __libc_realloc(ptr, size);
  if (next || !size) {
    freed((void *)old);
    allocated(next, size);
  }
  return next;
}
void free(void *ptr) {
  freed(ptr);
  __libc_free(ptr);
}
