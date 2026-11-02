import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    decodeInto,
    instantiateWasm,
    makeWav,
    readWasm,
    sampleFromEnv,
    type WasmExports,
} from './helpers';

const prtPath = sampleFromEnv('REPLAYER_PRT');
const hivelyPath = sampleFromEnv('REPLAYER_HVL');

interface LoadedModule {
    exports: WasmExports;
    size: number;
}

async function loadModule(relativePath: string): Promise<LoadedModule> {
    const bytes = readWasm(relativePath);
    const module = new WebAssembly.Module(new Uint8Array(bytes));
    expect(WebAssembly.Module.imports(module), relativePath).toHaveLength(0);
    const instance = new WebAssembly.Instance(module, {});
    return { exports: instance.exports as unknown as WasmExports, size: bytes.length };
}

describe('per-engine modules', () => {
    it('decode only their own formats', async () => {
        const wav = makeWav();
        const wavModule = await loadModule('engines/wav.wasm');
        const flacModule = await loadModule('engines/flac.wasm');
        const mp3Module = await loadModule('engines/mp3.wasm');
        const preTrackerModule = await loadModule('engines/pretracker.wasm');
        const hivelyModule = await loadModule('engines/hively.wasm');
        const allModule = await loadModule('core.wasm');

        expect(decodeInto(wavModule.exports, wav)?.format).toBe(1);
        expect(decodeInto(allModule.exports, wav)?.format).toBe(1);

        for (const other of [flacModule, mp3Module, preTrackerModule, hivelyModule])
            expect(decodeInto(other.exports, wav)).toBeNull();

        expect(decodeInto(wavModule.exports, Buffer.from('PRT\x19'))).toBeNull();
    });

    it('reports a readable size for every module', async () => {
        for (const name of ['engines/wav.wasm', 'engines/flac.wasm', 'engines/mp3.wasm', 'engines/pretracker.wasm', 'engines/hively.wasm', 'core.wasm']) {
            const { size } = await loadModule(name);
            expect(size).toBeGreaterThan(1024);
        }
    });
});

describe.skipIf(!prtPath)('PreTracker module', () => {
    it('decodes a .prt sample', async () => {
        const module = await loadModule('engines/pretracker.wasm');
        const all = await loadModule('core.wasm');
        const sample = fs.readFileSync(prtPath!);
        const hively = await loadModule('engines/hively.wasm');

        expect(decodeInto(module.exports, sample)?.format).toBe(4);
        expect(decodeInto(all.exports, sample)?.format).toBe(4);
        expect(decodeInto(hively.exports, sample)).toBeNull();
    });
});

describe.skipIf(!hivelyPath)('Hively module', () => {
    it('decodes a .hvl sample', async () => {
        const module = await loadModule('engines/hively.wasm');
        const all = await loadModule('core.wasm');
        const sample = fs.readFileSync(hivelyPath!);
        const preTracker = await loadModule('engines/pretracker.wasm');

        expect(decodeInto(module.exports, sample)?.format).toBe(5);
        expect(decodeInto(all.exports, sample)?.format).toBe(5);
        expect(decodeInto(preTracker.exports, sample)).toBeNull();
    });
});
