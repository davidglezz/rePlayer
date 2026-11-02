import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { WEB, makeWav, readWasm, sampleFromEnv, toArrayBuffer } from './helpers';

const hivelyPath = sampleFromEnv('REPLAYER_HVL');

interface PortMessage {
    type: string;
    message?: string;
    ratio?: number;
    format?: number;
}

interface ProcessorLike {
    load(message: {
        type: 'load';
        module?: WebAssembly.Module;
        wasm?: ArrayBuffer;
        data: ArrayBuffer;
        autoplay?: boolean;
    }): Promise<void>;
    onMessage(message: Record<string, unknown>): void;
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

interface ProcessorContext {
    load(): Promise<ProcessorLike>;
    messages: PortMessage[];
}

function buildProcessor(): ProcessorContext {
    const source = fs.readFileSync(path.join(WEB, 'processor.js'), 'utf8');
    const messages: PortMessage[] = [];
    let Processor: (new () => ProcessorLike) | null = null;

    class MockAudioWorkletProcessor {
        port: {
            postMessage: (message: PortMessage) => void;
            onmessage: ((event: { data: unknown }) => void) | null;
        };

        constructor() {
            this.port = {
                postMessage: (message) => { messages.push(message); },
                onmessage: null,
            };
        }
    }

    const sandbox = {
        AudioWorkletProcessor: MockAudioWorkletProcessor,
        registerProcessor: (_name: string, processor: new () => ProcessorLike) => { Processor = processor; },
        sampleRate: 48000,
        WebAssembly,
        Math,
        Float32Array,
        Uint8Array,
        Number,
        BigInt,
        console,
        Error,
        TextDecoder,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    return {
        messages,
        async load() {
            if (!Processor)
                throw new Error('registerProcessor was not called');
            return new Processor();
        },
    };
}

async function coreModule(): Promise<WebAssembly.Module> {
    return WebAssembly.compile(fs.readFileSync(path.join(WEB, 'core.wasm')));
}

async function render(processor: ProcessorLike, blocks = 20): Promise<number> {
    let peak = 0;
    for (let block = 0; block < blocks; block++) {
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        processor.process([], [[left, right]]);
        for (let i = 0; i < left.length; i++) {
            expect(Number.isFinite(left[i])).toBe(true);
            expect(Number.isFinite(right[i])).toBe(true);
            peak = Math.max(peak, Math.abs(left[i]));
        }
    }
    return peak;
}

describe('AudioWorklet processor', () => {
    it('renders directly when file and context rates match', async () => {
        const { load, messages } = buildProcessor();
        const processor = await load();
        const module = await coreModule();

        await processor.load({ type: 'load', module, data: toArrayBuffer(makeWav(48000, 1)) });
        const loaded = messages.find((message) => message.type === 'loaded');
        expect(loaded, JSON.stringify(messages)).toBeDefined();
        expect(loaded!.ratio).toBeCloseTo(1, 6);

        processor.onMessage({ type: 'play' });
        expect(await render(processor)).toBeGreaterThan(1e-4);
    });

    it('resamples when the file rate differs from the context', async () => {
        const { load, messages } = buildProcessor();
        const processor = await load();
        const module = await coreModule();

        await processor.load({ type: 'load', module, data: toArrayBuffer(makeWav(44100, 1)) });
        const loaded = messages.find((message) => message.type === 'loaded');
        expect(loaded, JSON.stringify(messages)).toBeDefined();
        expect(loaded!.ratio).toBeCloseTo(44100 / 48000, 4);

        processor.onMessage({ type: 'play' });
        expect(await render(processor)).toBeGreaterThan(1e-4);
    });

    it('starts playing from the load message when autoplay is set', async () => {
        const { load } = buildProcessor();
        const processor = await load();
        const module = await coreModule();

        await processor.load({ type: 'load', module, data: toArrayBuffer(makeWav(48000, 1)), autoplay: true });
        expect(await render(processor)).toBeGreaterThan(1e-4);
    });

    it('loads the module from bytes, the path the app uses', async () => {
        const { load, messages } = buildProcessor();
        const processor = await load();

        await processor.load({
            type: 'load',
            wasm: toArrayBuffer(readWasm('engines/wav.wasm')),
            data: toArrayBuffer(makeWav(48000, 1)),
        });
        const loaded = messages.find((message) => message.type === 'loaded');
        expect(loaded, JSON.stringify(messages)).toBeDefined();
        expect(loaded!.ratio).toBeCloseTo(1, 6);

        processor.onMessage({ type: 'play' });
        expect(await render(processor)).toBeGreaterThan(1e-4);
    });

    it('reports an error for unsupported data', async () => {
        const { load, messages } = buildProcessor();
        const processor = await load();
        const module = await coreModule();
        const data = toArrayBuffer(Buffer.from('definitely not audio'));

        await processor.load({ type: 'load', module, data });
        expect(messages.some((message) => message.type === 'error')).toBe(true);
    });
});

describe.skipIf(!hivelyPath)('AudioWorklet + Hively bytes', () => {
    it('loads and renders a .hvl with the module bytes', async () => {
        const { load, messages } = buildProcessor();
        const processor = await load();
        const data = toArrayBuffer(fs.readFileSync(hivelyPath!));

        await processor.load({
            type: 'load',
            wasm: toArrayBuffer(readWasm('engines/hively.wasm')),
            data,
            autoplay: true,
        });
        const loaded = messages.find((message) => message.type === 'loaded');
        expect(loaded, JSON.stringify(messages)).toBeDefined();
        expect(loaded!.format).toBe(5);

        expect(await render(processor)).toBeGreaterThan(1e-4);
    });
});
