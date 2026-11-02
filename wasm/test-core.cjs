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

function readCString(exports, pointer) {
    const memory = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (end < memory.length && memory[end] !== 0)
        end++;
    return Buffer.from(memory.subarray(pointer, end)).toString('utf8');
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
    check(e.rp_subsong_count(ctx) === 1, 'bad WAV subsong count');
    check(e.rp_set_subsong(ctx, 0) === 0, 'WAV should not change subsong');

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

    const prtPath = process.argv[2];
    if (prtPath) {
        const prt = fs.readFileSync(prtPath);
        const prtCtx = e.rp_create();
        const prtPtr = e.malloc(prt.length);
        check(prtPtr !== 0, 'malloc failed (prt)');
        new Uint8Array(e.memory.buffer, prtPtr, prt.length).set(prt);
        check(e.rp_load(prtCtx, prtPtr, prt.length) === 1, 'PRT load failed');
        e.free(prtPtr);

        check(e.rp_format(prtCtx) === 4, 'expected PreTracker');
        check(e.rp_sample_rate(prtCtx) === 48000, 'bad PRT sample rate');
        check(e.rp_channels(prtCtx) === 2, 'bad PRT channels');
        const prtFrames = Number(e.rp_frames(prtCtx));
        check(prtFrames > 0, 'bad PRT length');

        const prtOut = e.malloc(block * 2 * 4);
        const prtRead = e.rp_render(prtCtx, prtOut, block);
        const prtSamples = new Float32Array(e.memory.buffer, prtOut, block * 2);
        check(prtRead > 0, 'PRT render returned 0');
        let nonZero = false;
        for (let i = 0; i < prtRead * 2; i++) {
            if (Math.abs(prtSamples[i]) > 0.0001) {
                nonZero = true;
                break;
            }
        }
        check(nonZero, 'PRT rendered silence');

        const title = readCString(e, e.rp_title(prtCtx));
        const artist = readCString(e, e.rp_artist(prtCtx));
        check(title.length > 0, 'PRT title empty');
        console.log(`   PreTracker: "${title}" by "${artist}"`);

        const subsongs = e.rp_subsong_count(prtCtx);
        check(subsongs >= 1, 'bad subsong count');
        check(e.rp_subsong(prtCtx) === 0, 'bad current subsong');
        check(e.rp_set_subsong(prtCtx, 0) === 1, 'set subsong 0 failed');
        check(e.rp_subsong(prtCtx) === 0, 'subsong 0 not applied');
        if (subsongs > 1) {
            check(e.rp_set_subsong(prtCtx, 1) === 1, 'set subsong failed');
            check(e.rp_subsong(prtCtx) === 1, 'subsong not applied');
            const subFrames = Number(e.rp_frames(prtCtx));
            check(subFrames > 0, 'bad subsong length');
            const subRead = e.rp_render(prtCtx, prtOut, block);
            check(subRead > 0, 'subsong render failed');
            check(e.rp_set_subsong(prtCtx, 0) === 1, 'restore subsong failed');
        }
        console.log(`   subsongs: ${subsongs}`);

        const half = BigInt(Math.floor(prtFrames / 2));
        check(e.rp_seek(prtCtx, half) === 1, 'PRT seek failed');
        e.free(prtOut);
        e.rp_destroy(prtCtx);
        console.log(`ok: PreTracker load/render/seek/destroy (${prtFrames} frames @ 48 kHz)`);
    } else {
        console.log('(pasa un .prt/.pt como argumento para probar PreTracker)');
    }
})().catch((error) => {
    console.error('FAIL:', error.message);
    process.exit(1);
});
