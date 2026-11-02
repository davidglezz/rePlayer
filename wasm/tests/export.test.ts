import { describe, expect, it } from 'vitest';
import { instantiateWasm, makeWav } from './helpers';

function writeAscii(view: DataView, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++)
        view.setUint8(offset + i, text.charCodeAt(i));
}

function makeWavFromPcm(pcm: Int16Array, rate: number): Buffer {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const dataSize = pcm.length * 2;
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    return Buffer.concat([Buffer.from(header), Buffer.from(pcm.buffer)]);
}

describe('WAV export path', () => {
    it('renders a decoded file to 16-bit PCM and re-decodes it', async () => {
        const core = await instantiateWasm('core.wasm');
        const wav = await instantiateWasm('engines/wav.wasm');
        const input = makeWav(44100, 1);

        const context = core.rp_create();
        const pointer = core.malloc(input.length);
        new Uint8Array(core.memory.buffer, pointer, input.length).set(input);
        expect(core.rp_load(context, pointer, input.length)).toBe(1);
        core.free(pointer);

        const frames = Number(core.rp_frames(context));
        const rate = core.rp_sample_rate(context);
        const block = 4096;
        const out = core.malloc(block * 2 * 4);
        const pcm = new Int16Array(frames * 2);
        let done = 0;
        while (done < frames) {
            const got = core.rp_render(context, out, Math.min(block, frames - done));
            if (got <= 0)
                break;
            const floats = new Float32Array(core.memory.buffer, out, got * 2);
            for (let i = 0; i < got * 2; i++) {
                const sample = Math.max(-1, Math.min(1, floats[i]));
                pcm[done * 2 + i] = sample < 0 ? sample * 32768 : sample * 32767;
            }
            done += got;
        }
        core.free(out);
        core.rp_destroy(context);

        expect(done).toBe(frames);

        const exported = makeWavFromPcm(pcm, rate);
        const checkContext = wav.rp_create();
        const checkPointer = wav.malloc(exported.length);
        new Uint8Array(wav.memory.buffer, checkPointer, exported.length).set(exported);
        expect(wav.rp_load(checkContext, checkPointer, exported.length)).toBe(1);
        wav.free(checkPointer);

        expect(wav.rp_format(checkContext)).toBe(1);
        expect(Number(wav.rp_frames(checkContext))).toBe(frames);
        wav.rp_destroy(checkContext);
    });
});
