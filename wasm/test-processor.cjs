// Node smoke test for the AudioWorklet processor: runs processor.js with a
// mocked AudioWorkletProcessor, loads a generated WAV into the wasm core and
// checks the direct and resampled rendering paths.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeWav(rate, seconds = 1) {
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

(async () => {
    const wasmBytes = fs.readFileSync(path.join(__dirname, 'web', 'core.wasm'));
    const module = await WebAssembly.compile(wasmBytes);

    let Processor = null;
    const messages = [];

    class MockAudioWorkletProcessor {
        constructor() {
            this.port = {
                postMessage: (message) => messages.push(message),
                onmessage: null,
            };
        }
    }

    const context = {
        AudioWorkletProcessor: MockAudioWorkletProcessor,
        registerProcessor: (name, processor) => { Processor = processor; },
        sampleRate: 48000,
        WebAssembly,
        Math,
        Float32Array,
        Uint8Array,
        Number,
        BigInt,
        console,
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'web', 'processor.js'), 'utf8'), context);
    if (!Processor)
        throw new Error('registerProcessor was not called');

    async function run(label, fileRate) {
        messages.length = 0;
        const processor = new Processor();
        const wav = makeWav(fileRate);
        const data = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);

        await processor.load({ type: 'load', module, data });

        const loaded = messages.find((message) => message.type === 'loaded');
        if (!loaded)
            throw new Error(`${label}: no loaded message (${JSON.stringify(messages)})`);
        if (!Number.isFinite(loaded.ratio))
            throw new Error(`${label}: invalid ratio`);

        processor.onMessage({ type: 'play' });

        let peak = 0;
        for (let block = 0; block < 20; block++) {
            const left = new Float32Array(128);
            const right = new Float32Array(128);
            processor.process([], [[left, right]]);
            for (let i = 0; i < left.length; i++) {
                if (!Number.isFinite(left[i]) || !Number.isFinite(right[i]))
                    throw new Error(`${label}: non-finite sample`);
                peak = Math.max(peak, Math.abs(left[i]));
            }
        }

        if (peak < 1e-4)
            throw new Error(`${label}: rendered silence`);
        console.log(`ok: ${label} (ratio ${loaded.ratio.toFixed(4)}, peak ${peak.toFixed(3)})`);
    }

    await run('direct 48k -> 48k', 48000);
    await run('resample 44.1k -> 48k', 44100);

    // Playlist/autoplay: the load message can start playback by itself.
    messages.length = 0;
    const autoplay = new Processor();
    const wav = makeWav(48000);
    const data = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    await autoplay.load({ type: 'load', module, data, autoplay: true });
    let autoplayPeak = 0;
    for (let block = 0; block < 20; block++) {
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        autoplay.process([], [[left, right]]);
        for (let i = 0; i < left.length; i++)
            autoplayPeak = Math.max(autoplayPeak, Math.abs(left[i]));
    }
    if (autoplayPeak < 1e-4)
        throw new Error('autoplay rendered silence');
    console.log(`ok: autoplay (peak ${autoplayPeak.toFixed(3)})`);

    console.log('ok: processor direct + resampled rendering');
})().catch((error) => {
    console.error('FAIL:', error.message);
    process.exit(1);
});
