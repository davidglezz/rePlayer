// Node smoke test for the per-engine wasm modules.
//
//   node wasm/test-engines.cjs [modulo.prt] [modulo.hvl]
//
// Checks that each module is import-free, that the WAV module decodes WAV, and
// that per-engine modules reject formats they do not own. With a .prt/.hvl
// sample it also checks the PreTracker/Hively modules.

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

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

async function loadModule(relativePath) {
    const fullPath = path.join(__dirname, relativePath);
    const bytes = fs.readFileSync(fullPath);
    const module = new WebAssembly.Module(bytes);
    check(WebAssembly.Module.imports(module).length === 0, `${relativePath}: imports`);
    const instance = new WebAssembly.Instance(module, {});
    return { exports: instance.exports, size: bytes.length };
}

function decodeInto(exports, buffer) {
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

(async () => {
    const wav = makeWav();
    const wavModule = await loadModule('web/engines/wav.wasm');
    const flacModule = await loadModule('web/engines/flac.wasm');
    const mp3Module = await loadModule('web/engines/mp3.wasm');
    const preTrackerModule = await loadModule('web/engines/pretracker.wasm');
    const hivelyModule = await loadModule('web/engines/hively.wasm');
    const allModule = await loadModule('web/core.wasm');

    check(decodeInto(wavModule.exports, wav)?.format === 1, 'wav module did not decode WAV');
    check(decodeInto(allModule.exports, wav)?.format === 1, 'all module did not decode WAV');
    check(decodeInto(flacModule.exports, wav) === null, 'flac module accepted WAV');
    check(decodeInto(mp3Module.exports, wav) === null, 'mp3 module accepted WAV');
    check(decodeInto(preTrackerModule.exports, wav) === null, 'pretracker module accepted WAV');
    check(decodeInto(hivelyModule.exports, wav) === null, 'hively module accepted WAV');
    check(decodeInto(wavModule.exports, Buffer.from('PRT\x19')) === null, 'wav module accepted PRT');

    const prtPath = process.argv[2];
    if (prtPath) {
        const prt = fs.readFileSync(prtPath);
        check(decodeInto(preTrackerModule.exports, prt)?.format === 4, 'pretracker module did not decode PRT');
        check(decodeInto(allModule.exports, prt)?.format === 4, 'all module did not decode PRT');
        check(decodeInto(hivelyModule.exports, prt) === null, 'hively module accepted PRT');
        console.log('ok: PreTracker module');
    }

    const hivelyPath = process.argv[3];
    if (hivelyPath) {
        const hively = fs.readFileSync(hivelyPath);
        check(decodeInto(hivelyModule.exports, hively)?.format === 5, 'hively module did not decode HVL');
        check(decodeInto(allModule.exports, hively)?.format === 5, 'all module did not decode HVL');
        check(decodeInto(preTrackerModule.exports, hively) === null, 'pretracker module accepted HVL');
        console.log('ok: Hively module');
    }

    const sizes = [
        ['wav', wavModule],
        ['flac', flacModule],
        ['mp3', mp3Module],
        ['pretracker', preTrackerModule],
        ['hively', hivelyModule],
        ['all', allModule],
    ].map(([name, module]) => `${name} ${(module.size / 1024).toFixed(1)} KB`).join(', ');
    console.log(`ok: per-engine modules (${sizes})`);
})().catch((error) => {
    console.error('FAIL:', error.message);
    process.exit(1);
});
