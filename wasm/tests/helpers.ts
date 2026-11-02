import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB = path.join(ROOT, 'web');

export interface WasmExports {
    memory: WebAssembly.Memory;
    rp_create(): number;
    rp_destroy(ctx: number): void;
    rp_load(ctx: number, pointer: number, size: number): number;
    rp_sample_rate(ctx: number): number;
    rp_channels(ctx: number): number;
    rp_frames(ctx: number): bigint;
    rp_position(ctx: number): bigint;
    rp_format(ctx: number): number;
    rp_title(ctx: number): number;
    rp_artist(ctx: number): number;
    rp_subsong_count(ctx: number): number;
    rp_subsong(ctx: number): number;
    rp_set_subsong(ctx: number, index: number): number;
    rp_seek(ctx: number, frame: bigint): number;
    rp_render(ctx: number, out: number, frames: number): number;
    malloc(size: number): number;
    free(pointer: number): void;
}

/** Generates a stereo 16-bit WAV with a 440 Hz sine, in memory. */
export function makeWav(rate = 44100, seconds = 1): Buffer {
    const frames = rate * seconds;
    const dataSize = frames * 2 * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(2, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * 4, 28);
    buffer.writeUInt16LE(4, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < frames; i++) {
        const value = Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.5 * 32767);
        buffer.writeInt16LE(value, 44 + i * 4);
        buffer.writeInt16LE(value, 46 + i * 4);
    }
    return buffer;
}

export function readWasm(relativePath: string): Buffer {
    return fs.readFileSync(path.join(WEB, relativePath));
}

export async function instantiateWasm(relativePath: string): Promise<WasmExports> {
    const bytes = new Uint8Array(readWasm(relativePath));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports as unknown as WasmExports;
}

export function decodeInto(exports: WasmExports, buffer: Uint8Array): { format: number; frames: number } | null {
    const context = exports.rp_create();
    const pointer = exports.malloc(buffer.length);
    if (!pointer) {
        exports.rp_destroy(context);
        return null;
    }
    new Uint8Array(exports.memory.buffer, pointer, buffer.length).set(buffer);
    const loaded = exports.rp_load(context, pointer, buffer.length);
    exports.free(pointer);
    if (!loaded) {
        exports.rp_destroy(context);
        return null;
    }
    const info = {
        format: exports.rp_format(context),
        frames: Number(exports.rp_frames(context)),
    };
    exports.rp_destroy(context);
    return info;
}

export function readCString(exports: WasmExports, pointer: number): string {
    if (!pointer)
        return '';
    const memory = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (end < memory.length && memory[end] !== 0)
        end++;
    return new TextDecoder().decode(memory.subarray(pointer, end));
}

/**
 * Optional sample modules (.prt/.hvl) are not committed. Point these env vars
 * at local files to enable the matching tests:
 *
 *   REPLAYER_PRT=path/to/file.prt REPLAYER_HVL=path/to/file.hvl npm test
 */
export function sampleFromEnv(name: string): string | null {
    const value = process.env[name];
    if (!value)
        return null;
    const resolved = path.resolve(value);
    return fs.existsSync(resolved) ? resolved : null;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
