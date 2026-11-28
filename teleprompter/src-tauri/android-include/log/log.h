#pragma once
#include <android/log.h>

// fdk-aac-sys also builds its decoder, which logs two malformed-frame
// diagnostics through this Android platform-only header. App NDKs expose
// liblog's text interface instead of the system security event writer.
static inline int android_errorWriteLog(int tag, const char *issue) {
  return __android_log_print(ANDROID_LOG_ERROR, "FDK-AAC", "%x: %s", tag, issue);
}
