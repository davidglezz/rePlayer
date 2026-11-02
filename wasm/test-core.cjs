// Node smoke test for the wasm core: generates a stereo WAV in memory,
// decodes it, seeks and drains it. No browser or audio device needed.
//
//   node wasm/test-core.cjs

const fs = require('fs');
const path = require('path');

function makeWav(seconds = 1, rate = 44100) {
    const frames = seconds * rate;
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

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

(async () => {
    const wasmPath = path.join(__dirname, 'web', 'core.wasm');
    const bytes = fs.readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const e = instance.exports;

    const wav = makeWav(1, 44100);
    const ctx = e.rp_create();
    const ptr = e.malloc(wav.length);
    check(ptr !== 0, 'malloc failed');
    new Uint8Array(e.memory.buffer, ptr, wav.length).set(wav);
    check(e.rp_load(ctx, ptr, wav.length) === 1, 'load failed');
    e.free(ptr);

    check(e.rp_format(ctx) === 1, 'expected WAV');
    check(e.rp_sample_rate(ctx) === 44100, 'bad sample rate');
    check(e.rp_channels(ctx) === 2, 'bad channel count');
    check(Number(e.rp_frames(ctx)) === 44100, 'bad frame count');

    const block = 4096;
    const outPtr = e.malloc(block * 2 * 4);
    const read = e.rp_render(ctx, outPtr, block);
    const samples = new Float32Array(e.memory.buffer, outPtr, block * 2);
    check(read === block, 'render length');
    check(Math.abs(samples[2] - 0.0313) < 0.01, 'unexpected sample value');
    check(Number(e.rp_position(ctx)) === block, 'position after render');

    check(e.rp_seek(ctx, 22050n) === 1, 'seek failed');
    check(Number(e.rp_position(ctx)) === 22050, 'position after seek');

    let total = 0;
    for (;;) {
        const got = e.rp_render(ctx, outPtr, block);
        if (got === 0)
            break;
        total += got;
    }
    check(total === 44100 - 22050, 'remaining frames');
    check(Number(e.rp_position(ctx)) === 44100, 'final position');

    e.free(outPtr);
    e.rp_destroy(ctx);

    console.log('ok: WAV load/render/seek/end/destroy');
})().catch((error) => {
    console.error('FAIL:', error.message);
    process.exit(1);
});
