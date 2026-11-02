import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    decodeInto,
    instantiateWasm,
    makeWav,
    readCString,
    sampleFromEnv,
    type WasmExports,
} from './helpers';

const prtPath = sampleFromEnv('REPLAYER_PRT');
const hivelyPath = sampleFromEnv('REPLAYER_HVL');

describe('wasm core', () => {
    it('loads, renders, seeks and drains a WAV', async () => {
        const core = await instantiateWasm('core.wasm');
        const wav = makeWav(44100, 1);

        const context = core.rp_create();
        expect(context).toBeGreaterThan(0);

        const pointer = core.malloc(wav.length);
        expect(pointer).not.toBe(0);
        new Uint8Array(core.memory.buffer, pointer, wav.length).set(wav);
        expect(core.rp_load(context, pointer, wav.length)).toBe(1);
        core.free(pointer);

        expect(core.rp_format(context)).toBe(1);
        expect(core.rp_sample_rate(context)).toBe(44100);
        expect(core.rp_channels(context)).toBe(2);
        expect(Number(core.rp_frames(context))).toBe(44100);
        expect(core.rp_subsong_count(context)).toBe(1);
        expect(core.rp_set_subsong(context, 0)).toBe(0);

        const block = 4096;
        const out = core.malloc(block * 2 * 4);
        expect(core.rp_render(context, out, block)).toBe(block);
        const samples = new Float32Array(core.memory.buffer, out, block * 2);
        expect(Math.abs(samples[2] - 0.0313)).toBeLessThan(0.01);
        expect(Number(core.rp_position(context))).toBe(block);

        expect(core.rp_seek(context, 22050n)).toBe(1);
        expect(Number(core.rp_position(context))).toBe(22050);

        let total = 0;
        for (;;) {
            const got = core.rp_render(context, out, block);
            if (got === 0)
                break;
            total += got;
        }
        expect(total).toBe(44100 - 22050);
        expect(Number(core.rp_position(context))).toBe(44100);

        core.free(out);
        core.rp_destroy(context);
    });

    it('reports an unknown format as unsupported', async () => {
        const core = await instantiateWasm('core.wasm');
        expect(decodeInto(core, Buffer.from('not audio at all'))).toBeNull();
    });
});

describe.skipIf(!prtPath)('PreTracker engine', () => {
    it('decodes and renders a .prt module', async () => {
        const core = await instantiateWasm('core.wasm');
        const bytes = readWasmBytes(prtPath!);
        const context = load(core, bytes);

        expect(core.rp_format(context)).toBe(4);
        expect(core.rp_sample_rate(context)).toBe(48000);
        expect(core.rp_channels(context)).toBe(2);

        const frames = Number(core.rp_frames(context));
        expect(frames).toBeGreaterThan(0);
        expect(readCString(core, core.rp_title(context)).length).toBeGreaterThan(0);

        const output = core.malloc(4096 * 2 * 4);
        const read = core.rp_render(context, output, 4096);
        expect(read).toBeGreaterThan(0);
        const samples = new Float32Array(core.memory.buffer, output, read * 2);
        expect(samples.some((value) => Math.abs(value) > 0.0001)).toBe(true);

        const subsongs = core.rp_subsong_count(context);
        expect(subsongs).toBeGreaterThanOrEqual(1);
        expect(core.rp_subsong(context)).toBe(0);
        expect(core.rp_set_subsong(context, 0)).toBe(1);
        if (subsongs > 1) {
            expect(core.rp_set_subsong(context, 1)).toBe(1);
            expect(core.rp_subsong(context)).toBe(1);
            expect(core.rp_render(context, output, 4096)).toBeGreaterThan(0);
            expect(core.rp_set_subsong(context, 0)).toBe(1);
        }

        expect(core.rp_seek(context, BigInt(Math.floor(frames / 2)))).toBe(1);
        core.free(output);
        core.rp_destroy(context);
    });
});

describe.skipIf(!hivelyPath)('Hively engine', () => {
    it('decodes and renders a .hvl module', async () => {
        const core = await instantiateWasm('core.wasm');
        const bytes = readWasmBytes(hivelyPath!);
        const context = load(core, bytes);

        expect(core.rp_format(context)).toBe(5);
        expect(core.rp_sample_rate(context)).toBe(48000);
        expect(core.rp_channels(context)).toBe(2);

        const frames = Number(core.rp_frames(context));
        expect(frames).toBeGreaterThan(0);

        const output = core.malloc(4096 * 2 * 4);
        const read = core.rp_render(context, output, 4096);
        expect(read).toBeGreaterThan(0);
        const samples = new Float32Array(core.memory.buffer, output, read * 2);
        expect(samples.some((value) => Math.abs(value) > 0.0001)).toBe(true);

        expect(core.rp_set_subsong(context, 0)).toBe(1);
        expect(core.rp_seek(context, BigInt(Math.floor(frames / 2)))).toBe(1);
        core.free(output);
        core.rp_destroy(context);
    });

    it('renders identically regardless of the block size', async () => {
        const bytes = readWasmBytes(hivelyPath!);
        const total = 8192;

        async function renderWith(block: number): Promise<Float32Array> {
            const core = await instantiateWasm('core.wasm');
            const context = load(core, bytes);
            const output = core.malloc(block * 2 * 4);
            const result = new Float32Array(total * 2);
            let done = 0;
            while (done < total) {
                const want = Math.min(block, total - done);
                const got = core.rp_render(context, output, want);
                if (got <= 0)
                    break;
                const view = new Float32Array(core.memory.buffer, output, got * 2);
                result.set(view, done * 2);
                done += got;
            }
            core.free(output);
            core.rp_destroy(context);
            expect(done).toBe(total);
            return result;
        }

        // The old code advanced one 50 Hz tick per rp_render call, so the
        // tempo depended on the AudioWorklet block size (128 frames).
        const small = await renderWith(128);
        const large = await renderWith(4096);
        expect(small).toEqual(large);
    });
});

function readWasmBytes(file: string): Uint8Array {
    return fs.readFileSync(file);
}

function load(core: WasmExports, bytes: Uint8Array): number {
    const context = core.rp_create();
    const pointer = core.malloc(bytes.length);
    expect(pointer).not.toBe(0);
    new Uint8Array(core.memory.buffer, pointer, bytes.length).set(bytes);
    expect(core.rp_load(context, pointer, bytes.length)).toBe(1);
    core.free(pointer);
    return context;
}
