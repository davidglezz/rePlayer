import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeInto, instantiateWasm, makeMod, makeVgm, makeWav, sampleFromEnv, type WasmExports } from './helpers';

const v2Path = sampleFromEnv('REPLAYER_V2');

function load(exports: WasmExports, bytes: Uint8Array): number {
    const context = exports.rp_create();
    const pointer = exports.malloc(bytes.length);
    expect(pointer).not.toBe(0);
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    expect(exports.rp_load(context, pointer, bytes.length)).toBe(1);
    exports.free(pointer);
    return context;
}

function renderPeak(exports: WasmExports, context: number, frames = 4096): number {
    const output = exports.malloc(frames * 2 * 4);
    const read = exports.rp_render(context, output, frames);
    expect(read).toBeGreaterThan(0);
    const samples = new Float32Array(exports.memory.buffer, output, read * 2);
    let peak = 0;
    for (let i = 0; i < read * 2; i++)
        peak = Math.max(peak, Math.abs(samples[i]));
    exports.free(output);
    return peak;
}

describe('XMP tracker engine', () => {
    it('loads and renders a generated MOD', async () => {
        const xmp = await instantiateWasm('engines/xmp.wasm');
        const mod = makeMod();
        const context = load(xmp, mod);

        expect(xmp.rp_format(context)).toBe(6);
        expect(xmp.rp_sample_rate(context)).toBe(48000);
        expect(xmp.rp_channels(context)).toBe(2);
        const frames = Number(xmp.rp_frames(context));
        expect(frames).toBeGreaterThan(0);
        expect(renderPeak(xmp, context)).toBeGreaterThan(1e-4);

        expect(xmp.rp_seek(context, BigInt(Math.floor(frames / 2)))).toBe(1);
        expect(xmp.rp_position(context)).toBe(BigInt(Math.floor(frames / 2)));
        xmp.rp_destroy(context);
    });

    it('is included by the all-in-one core', async () => {
        const core = await instantiateWasm('core.wasm');
        expect(decodeInto(core, makeMod())?.format).toBe(6);
    });

    it('only accepts tracker modules', async () => {
        const xmp = await instantiateWasm('engines/xmp.wasm');
        expect(decodeInto(xmp, makeWav())).toBeNull();
    });
});

describe('GME engine', () => {
    it('loads a minimal VGM', async () => {
        const gme = await instantiateWasm('engines/gme.wasm');
        const context = load(gme, makeVgm());

        expect(gme.rp_format(context)).toBe(8);
        expect(gme.rp_sample_rate(context)).toBe(48000);
        expect(Number(gme.rp_frames(context))).toBeGreaterThan(0);

        const output = gme.malloc(4096 * 2 * 4);
        expect(gme.rp_render(context, output, 4096)).toBe(4096);
        gme.free(output);
        expect(gme.rp_seek(context, 0n)).toBe(1);
        gme.rp_destroy(context);
    });

    it('only accepts supported chiptune formats', async () => {
        const gme = await instantiateWasm('engines/gme.wasm');
        expect(decodeInto(gme, makeWav())).toBeNull();
    });
});

describe.skipIf(!v2Path)('V2 engine', () => {
    it('loads and renders a .v2m module', async () => {
        const v2 = await instantiateWasm('engines/v2.wasm');
        const bytes = fs.readFileSync(v2Path!);
        const context = load(v2, bytes);

        expect(v2.rp_format(context)).toBe(7);
        expect(v2.rp_sample_rate(context)).toBe(44100);
        expect(v2.rp_channels(context)).toBe(2);
        const frames = Number(v2.rp_frames(context));
        expect(frames).toBeGreaterThan(0);
        expect(renderPeak(v2, context)).toBeGreaterThan(1e-4);

        expect(v2.rp_seek(context, BigInt(Math.floor(frames / 2)))).toBe(1);
        v2.rp_destroy(context);
    });

    it('is included by the all-in-one core', async () => {
        const core = await instantiateWasm('core.wasm');
        expect(decodeInto(core, fs.readFileSync(v2Path!))?.format).toBe(7);
    });
});
