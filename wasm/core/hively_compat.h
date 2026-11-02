#pragma once

// Minimal shims for the MSVC-specific functions used by the Hively replayer.
// The wasm build never calls hvl_LoadTune(), so fopen() is only referenced by
// a function that gets removed with --gc-sections.

#include <stddef.h>
#include <stdio.h>
#include <string.h>

// MSVC defines errno_t; wasi-libc does not. A repeated typedef to the same
// type is valid C11.
typedef int errno_t;

static inline int wasm_fopen_s(FILE** file, const char* name, const char* mode)
{
    *file = fopen(name, mode);
    return *file ? 0 : 1;
}
#define fopen_s wasm_fopen_s

static inline int wasm_strncpy_s(char* destination, size_t destinationSize, const char* source, size_t count)
{
    if (!destination || destinationSize == 0)
        return 1;
    size_t length = 0;
    while (length < count && length + 1 < destinationSize && source[length] != '\0')
        length++;
    memcpy(destination, source, length);
    destination[length] = '\0';
    return 0;
}
#define strncpy_s wasm_strncpy_s
