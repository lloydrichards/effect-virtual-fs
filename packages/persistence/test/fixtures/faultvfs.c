/* Test-only SQLite VFS shim. Loaded before the provider opens its database. */
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct FaultMethods {
  sqlite3_io_methods methods;
  const sqlite3_io_methods *original;
  int flags;
  void *delayed;
  int delayed_amount;
  sqlite3_int64 delayed_offset;
} FaultMethods;

static sqlite3_vfs shim;
static sqlite3_vfs *original_vfs;
static const char *fault_operation;
static const char *fault_target;
static const char *fault_log;
static int fault_after;
static int fault_persistent;
static int matching_calls;

static void log_call(const char *operation, int flags, int call) {
  if (!fault_log) return;
  FILE *log = fopen(fault_log, "a");
  if (!log) return;
  fprintf(log, "%s target=%s flags=%d call=%d\n", operation,
    fault_target ? fault_target : "all", flags, call);
  fclose(log);
}

static int matches_target(int flags) {
  if (!fault_target || strcmp(fault_target, "all") == 0) return 1;
  if (strcmp(fault_target, "main") == 0) return (flags & SQLITE_OPEN_MAIN_DB) != 0;
  if (strcmp(fault_target, "journal") == 0) return (flags & SQLITE_OPEN_MAIN_JOURNAL) != 0;
  return 0;
}

static int should_fail(const char *operation, int flags) {
  if (!fault_operation || strcmp(fault_operation, operation) != 0 || !matches_target(flags)) return 0;
  matching_calls++;
  if (matching_calls < fault_after || (!fault_persistent && matching_calls > fault_after)) return 0;
  log_call(operation, flags, matching_calls);
  return 1;
}

static FaultMethods *methods_for(sqlite3_file *file) {
  return (FaultMethods *)file->pMethods;
}

static int fault_close(sqlite3_file *file) {
  FaultMethods *fault = methods_for(file);
  const sqlite3_io_methods *original = fault->original;
  free(fault->delayed);
  file->pMethods = original;
  int result = original->xClose(file);
  free(fault);
  return result;
}

static int fault_write(sqlite3_file *file, const void *buffer, int amount, sqlite3_int64 offset) {
  FaultMethods *fault = methods_for(file);
  if (should_fail("write", fault->flags)) return SQLITE_IOERR_WRITE;
  if (should_fail("lost-write", fault->flags)) return SQLITE_OK;
  if (should_fail("reorder-write", fault->flags)) {
    fault->delayed = malloc((size_t)amount);
    if (!fault->delayed) return SQLITE_NOMEM;
    memcpy(fault->delayed, buffer, (size_t)amount);
    fault->delayed_amount = amount;
    fault->delayed_offset = offset;
    return SQLITE_OK;
  }
  if (fault->delayed) {
    int result = fault->original->xWrite(file, buffer, amount, offset);
    if (result == SQLITE_OK) result = fault->original->xWrite(
      file, fault->delayed, fault->delayed_amount, fault->delayed_offset);
    if (result == SQLITE_OK) log_call("reorder-applied", fault->flags, matching_calls);
    free(fault->delayed);
    fault->delayed = NULL;
    return result;
  }
  int result = fault->original->xWrite(file, buffer, amount, offset);
  if (result == SQLITE_OK && fault_operation && strcmp(fault_operation, "observe") == 0 &&
    matches_target(fault->flags) && fault_log) {
    FILE *log = fopen(fault_log, "a");
    if (log) {
      fprintf(log, "write-end bytes=%lld flags=%d\n", (long long)(offset + amount), fault->flags);
      fclose(log);
    }
  }
  return result;
}

static int fault_sync(sqlite3_file *file, int flags) {
  FaultMethods *fault = methods_for(file);
  if (should_fail("sync", fault->flags)) return SQLITE_IOERR_FSYNC;
  int result = fault->original->xSync(file, flags);
  if (fault_operation &&
    (strcmp(fault_operation, "lost-write") == 0 || strcmp(fault_operation, "reorder-write") == 0)) {
    log_call(result == SQLITE_OK ? "sync-ok" : "sync-error", fault->flags, flags);
  }
  return result;
}

static int fault_open(sqlite3_vfs *vfs, const char *name, sqlite3_file *file, int flags, int *out_flags) {
  (void)vfs;
  int result = original_vfs->xOpen(original_vfs, name, file, flags, out_flags);
  if (result != SQLITE_OK) return result;
  if (fault_log) {
    FILE *log = fopen(fault_log, "a");
    if (log) {
      fprintf(log, "sector-size value=%d flags=%d\n", file->pMethods->xSectorSize(file), flags);
      fclose(log);
    }
  }

  FaultMethods *fault = malloc(sizeof(*fault));
  if (!fault) {
    file->pMethods->xClose(file);
    return SQLITE_NOMEM;
  }
  fault->original = file->pMethods;
  fault->methods = *file->pMethods;
  fault->flags = flags;
  fault->delayed = NULL;
  fault->delayed_amount = 0;
  fault->delayed_offset = 0;
  fault->methods.xClose = fault_close;
  fault->methods.xWrite = fault_write;
  fault->methods.xSync = fault_sync;
  file->pMethods = &fault->methods;
  return SQLITE_OK;
}

int sqlite3_faultvfs_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)db;
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  original_vfs = sqlite3_vfs_find(0);
  if (!original_vfs) return SQLITE_ERROR;
  fault_operation = getenv("EFFECT_VFS_FAULT_OPERATION");
  fault_target = getenv("EFFECT_VFS_FAULT_TARGET");
  fault_log = getenv("EFFECT_VFS_FAULT_LOG");
  fault_after = atoi(getenv("EFFECT_VFS_FAULT_AFTER") ? getenv("EFFECT_VFS_FAULT_AFTER") : "1");
  fault_persistent = getenv("EFFECT_VFS_FAULT_PERSISTENT") &&
    atoi(getenv("EFFECT_VFS_FAULT_PERSISTENT")) != 0;
  if (fault_after < 1) return SQLITE_ERROR;
  shim = *original_vfs;
  shim.zName = "effect_vfs_fault";
  shim.xOpen = fault_open;
  return sqlite3_vfs_register(&shim, 1);
}
