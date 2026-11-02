// AudioWorklet processor: owns a wasm instance and pulls interleaved stereo
// PCM from it on the audio thread. The module and file bytes are sent from the
// main thread (WebAssembly.Module is structured-cloneable).

class RpProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.port.onmessage = (event) => this.onMessage(event.data);
        this.instance = null;
        this.exports = null;
        this.memory = null;
        this.ctx = 0;
        this.bufferPtr = 0;
        this.bufferFrames = 0;
        this.playing = false;
        this.volume = 1;
        this.position = 0;
        this.totalFrames = 0;
        this.lastPost = -1;
    }

    onMessage(message) {
        switch (message.type) {
            case 'load':
                this.load(message);
                break;
            case 'play':
                if (this.ctx)
                    this.playing = true;
                break;
            case 'pause':
                this.playing = false;
                break;
            case 'stop':
                this.playing = false;
                if (this.ctx) {
                    this.exports.rp_seek(this.ctx, 0n);
                    this.position = 0;
                }
                break;
            case 'seek':
                if (this.ctx) {
                    this.exports.rp_seek(this.ctx, BigInt(message.frame));
                    this.position = message.frame;
                }
                break;
            case 'volume':
                this.volume = message.value;
                break;
            default:
                break;
        }
    }

    async load(message) {
        try {
            if (this.ctx) {
                this.exports.rp_destroy(this.ctx);
                this.ctx = 0;
            }
            if (this.bufferPtr) {
                this.exports.free(this.bufferPtr);
                this.bufferPtr = 0;
            }

            this.instance = message.module
                ? new WebAssembly.Instance(message.module, {})
                : (await WebAssembly.instantiate(message.wasm, {})).instance;
            this.exports = this.instance.exports;
            this.memory = this.exports.memory;
            this.ctx = this.exports.rp_create();
            if (!this.ctx)
                throw new Error('rp_create failed');

            const bytes = new Uint8Array(message.data);
            const ptr = this.exports.malloc(bytes.length);
            if (!ptr)
                throw new Error('malloc failed');
            new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
            const ok = this.exports.rp_load(this.ctx, ptr, bytes.length);
            this.exports.free(ptr);
            if (!ok) {
                this.port.postMessage({ type: 'error', message: 'Formato no soportado o archivo corrupto' });
                return;
            }

            this.totalFrames = Number(this.exports.rp_frames(this.ctx));
            this.position = 0;
            this.playing = false;
            this.lastPost = -1;
            this.bufferFrames = 4096;
            this.bufferPtr = this.exports.malloc(this.bufferFrames * 2 * 4);
            if (!this.bufferPtr)
                throw new Error('malloc failed');

            this.port.postMessage({
                type: 'loaded',
                format: this.exports.rp_format(this.ctx),
                sampleRate: this.exports.rp_sample_rate(this.ctx),
                channels: this.exports.rp_channels(this.ctx),
                frames: this.totalFrames,
            });
        } catch (error) {
            this.port.postMessage({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || out.length === 0)
            return true;

        const left = out[0];
        const right = out[1] || out[0];
        const frames = left.length;

        if (!this.playing || !this.ctx || !this.bufferPtr) {
            left.fill(0);
            if (right !== left)
                right.fill(0);
            return true;
        }

        if (frames > this.bufferFrames) {
            this.exports.free(this.bufferPtr);
            this.bufferFrames = frames;
            this.bufferPtr = this.exports.malloc(this.bufferFrames * 2 * 4);
            if (!this.bufferPtr) {
                this.playing = false;
                left.fill(0);
                if (right !== left)
                    right.fill(0);
                return true;
            }
        }

        const read = this.exports.rp_render(this.ctx, this.bufferPtr, frames);
        const view = new Float32Array(this.memory.buffer, this.bufferPtr, frames * 2);
        for (let i = 0; i < frames; i++) {
            left[i] = view[i * 2] * this.volume;
            if (right !== left)
                right[i] = view[i * 2 + 1] * this.volume;
        }

        this.position += read;
        if (read === 0) {
            this.playing = false;
            this.port.postMessage({ type: 'ended' });
        } else if (this.lastPost < 0 || this.position - this.lastPost > 2400) {
            this.lastPost = this.position;
            this.port.postMessage({ type: 'position', frame: this.position });
        }
        return true;
    }
}

registerProcessor('rp-player', RpProcessor);
