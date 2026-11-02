// Minimal libc stand-ins for the wasm build. libxmp and v2redux reference
// file/environment/clock APIs that never run in the player, but wasi-libc
// would turn them into WASI imports (and getenv even tries to initialize the
// environment and aborts). The build passes -Dprintf=wasm_printf etc. so the
// calls resolve here instead.
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

char* wasm_getenv(const char* name)
{
    (void)name;
    return NULL;
}

time_t wasm_time(time_t* result)
{
    if (result)
        *result = 0;
    return 0;
}

int wasm_fprintf(FILE* stream, const char* format, ...)
{
    (void)stream;
    (void)format;
    return 0;
}

int wasm_puts(const char* text)
{
    (void)text;
    return 0;
}

int wasm_fputs(const char* text, FILE* stream)
{
    (void)text;
    (void)stream;
    return 0;
}

size_t wasm_fwrite(const void* data, size_t size, size_t count, FILE* stream)
{
    (void)data;
    (void)size;
    (void)stream;
    return count;
}
