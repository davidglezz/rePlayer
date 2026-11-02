// Node smoke test for the export path: decode/render a generated WAV with the
// core, write a new 16-bit stereo WAV and decode it again with the WAV module.
//
//   node wasm/test-export.cjs

const fs = require('fs');
const path = require('path');

function makeWav(rate = 44100, seconds = 1) {
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

function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++)
        view.setUint8(offset + i, text.charCodeAt(i));
}

function makeWavFromPcm(pcm, rate) {
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

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function instantiate(relativePath) {
    const bytes = fs.readFileSync(path.join(__dirname, relativePath));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports;
}

(async () => {
    const core = await instantiate('web/core.wasm');
    const wav = await instantiate('web/engines/wav.wasm');
    const input = makeWav(44100, 1);

    const context = core.rp_create();
    const pointer = core.malloc(input.length);
    new Uint8Array(core.memory.buffer, pointer, input.length).set(input);
    check(core.rp_load(context, pointer, input.length) === 1, 'load input');
    core.free(pointer);

    const frames = Number(core.rp_frames(context));
    const rate = core.rp_sample_rate(context);
    const block = 4096;
    const outPtr = core.malloc(block * 2 * 4);
    const pcm = new Int16Array(frames * 2);
    let done = 0;
    while (done < frames) {
        const got = core.rp_render(context, outPtr, Math.min(block, frames - done));
        if (got <= 0)
            break;
        const floats = new Float32Array(core.memory.buffer, outPtr, got * 2);
        for (let i = 0; i < got * 2; i++) {
            const sample = Math.max(-1, Math.min(1, floats[i]));
            pcm[done * 2 + i] = sample < 0 ? sample * 32768 : sample * 32767;
        }
        done += got;
    }
    core.free(outPtr);
    core.rp_destroy(context);
    check(done === frames, `rendered ${done}/${frames}`);

    const exported = makeWavFromPcm(pcm, rate);

    const checkContext = wav.rp_create();
    const checkPtr = wav.malloc(exported.length);
    new Uint8Array(wav.memory.buffer, checkPtr, exported.length).set(exported);
    check(wav.rp_load(checkContext, checkPtr, exported.length) === 1, 'reload exported WAV');
    wav.free(checkPtr);
    check(wav.rp_format(checkContext) === 1, 'exported WAV format');
    check(Number(wav.rp_frames(checkContext)) === frames, 'exported WAV frames');
    wav.rp_destroy(checkContext);

    console.log(`ok: export WAV (${frames} frames @ ${rate} Hz, ${exported.length} bytes)`);
})().catch((error) => {
    console.error('FAIL:', error.message);
    process.exit(1);
});
