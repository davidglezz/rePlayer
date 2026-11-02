// The Hively replayer prints "Invalid file." for unknown data. We never feed
// it anything that is not THX/HVL, but the call is still in the object; provide
// a local printf (renamed with -Dprintf=wasm_printf) so the module does not
// import WASI fd_write.
#include <stdarg.h>

int wasm_printf(const char* format, ...)
{
    (void)format;
    return 0;
}
