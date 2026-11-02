// AudioWorklet processor: owns a wasm instance and pulls interleaved stereo
// PCM from it on the audio thread. The module and file bytes are sent from the
// main thread (WebAssembly.Module is structured-cloneable).
//
// If the AudioContext rate differs from the file rate, a small linear
// resampler interpolates the decoded frames instead of letting the browser
// play them at the wrong speed.

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
        this.position = 0; // consumed file frames, for the UI
        this.totalFrames = 0;
        this.lastPost = -1;

        // Resampler state
        this.fileRate = 0;
        this.ratio = 1; // file frames per output frame
        this.input = null; // Float32Array, interleaved stereo
        this.inputFrames = 0;
        this.inputPos = 0; // fractional frame position inside input
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
                this.resetPlayback(0);
                break;
            case 'seek':
                if (this.ctx) {
                    const ok = this.exports.rp_seek(this.ctx, BigInt(message.frame));
                    if (ok)
                        this.resetPlayback(message.frame);
                }
                break;
            case 'volume':
                this.volume = message.value;
                break;
            default:
                break;
        }
    }

    resetPlayback(position) {
        this.position = position;
        this.inputFrames = 0;
        this.inputPos = 0;
        this.lastPost = -1;
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
            this.fileRate = this.exports.rp_sample_rate(this.ctx);
            this.ratio = this.fileRate > 0 && sampleRate > 0 ? this.fileRate / sampleRate : 1;
            this.playing = false;
            this.resetPlayback(0);

            this.bufferFrames = 4096;
            this.bufferPtr = this.exports.malloc(this.bufferFrames * 2 * 4);
            if (!this.bufferPtr)
                throw new Error('malloc failed');

            this.port.postMessage({
                type: 'loaded',
                format: this.exports.rp_format(this.ctx),
                sampleRate: this.fileRate,
                contextSampleRate: sampleRate,
                ratio: this.ratio,
                channels: this.exports.rp_channels(this.ctx),
                frames: this.totalFrames,
            });
        } catch (error) {
            this.port.postMessage({ type: 'error', message: String(error && error.message ? error.message : error) });
        }
    }

    ensureRenderBuffer(frames) {
        if (frames <= this.bufferFrames)
            return true;
        this.exports.free(this.bufferPtr);
        this.bufferFrames = frames;
        this.bufferPtr = this.exports.malloc(this.bufferFrames * 2 * 4);
        return this.bufferPtr !== 0;
    }

    ensureInput(frames) {
        const needed = frames * 2;
        if (!this.input || this.input.length < needed) {
            const next = new Float32Array(Math.max(needed, this.input ? this.input.length * 2 : 8192));
            if (this.input && this.inputFrames > 0)
                next.set(this.input.subarray(0, this.inputFrames * 2));
            this.input = next;
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

        if (Math.abs(this.ratio - 1) < 1e-6)
            this.renderDirect(frames, left, right);
        else
            this.renderResampled(frames, left, right);
        return true;
    }

    renderDirect(frames, left, right) {
        if (!this.ensureRenderBuffer(frames)) {
            this.playing = false;
            return;
        }
        const read = this.exports.rp_render(this.ctx, this.bufferPtr, frames);
        const view = new Float32Array(this.memory.buffer, this.bufferPtr, frames * 2);
        for (let i = 0; i < frames; i++) {
            left[i] = view[i * 2] * this.volume;
            if (right !== left)
                right[i] = view[i * 2 + 1] * this.volume;
        }
        this.position += read;
        this.afterRender(read);
    }

    renderResampled(frames, left, right) {
        const needed = Math.ceil((frames + 1) * this.ratio) + 2;
        if (!this.ensureRenderBuffer(needed)) {
            this.playing = false;
            return;
        }

        const read = this.exports.rp_render(this.ctx, this.bufferPtr, needed);
        const view = new Float32Array(this.memory.buffer, this.bufferPtr, needed * 2);

        this.ensureInput(this.inputFrames + read);
        if (read > 0)
            this.input.set(view.subarray(0, read * 2), this.inputFrames * 2);
        this.inputFrames += read;

        const input = this.input;
        const count = this.inputFrames;
        const ratio = this.ratio;
        let pos = this.inputPos;

        for (let i = 0; i < frames; i++) {
            const index = Math.floor(pos);
            const frac = pos - index;
            const leftA = index < count ? input[index * 2] : 0;
            const leftB = index + 1 < count ? input[(index + 1) * 2] : 0;
            left[i] = (leftA + (leftB - leftA) * frac) * this.volume;
            if (right !== left) {
                const rightA = index < count ? input[index * 2 + 1] : 0;
                const rightB = index + 1 < count ? input[(index + 1) * 2 + 1] : 0;
                right[i] = (rightA + (rightB - rightA) * frac) * this.volume;
            }
            pos += ratio;
        }

        this.inputPos = pos;
        const consumed = Math.floor(this.inputPos);
        if (consumed > 0) {
            this.input.copyWithin(0, consumed * 2, count * 2);
            this.inputFrames = count - consumed;
            this.inputPos -= consumed;
        }
        this.position += consumed;

        this.afterRender(read);
    }

    afterRender(read) {
        if (this.position - this.lastPost > 2400) {
            this.lastPost = this.position;
            this.port.postMessage({ type: 'position', frame: this.position });
        }
        if (read === 0 && this.inputFrames <= 0) {
            this.playing = false;
            this.position = this.totalFrames;
            this.port.postMessage({ type: 'ended' });
        }
    }
}

registerProcessor('rp-player', RpProcessor);
