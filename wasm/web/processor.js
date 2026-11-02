"use strict";
// AudioWorklet processor: owns a wasm instance and pulls interleaved stereo
// PCM from it on the audio thread. The module and file bytes are sent from the
// main thread (WebAssembly.Module is structured-cloneable).
//
// If the AudioContext rate differs from the file rate, a small linear
// resampler interpolates the decoded frames instead of letting the browser
// play them at the wrong speed.
class RpProcessor extends AudioWorkletProcessor {
    instance = null;
    exports = null;
    memory = null;
    ctx = 0;
    bufferPtr = 0;
    bufferFrames = 0;
    playing = false;
    volume = 1;
    position = 0;
    totalFrames = 0;
    lastPost = -1;
    fileRate = 0;
    ratio = 1;
    input = null;
    inputFrames = 0;
    inputPos = 0;
    constructor() {
        super();
        this.port.onmessage = (event) => this.onMessage(event.data);
    }
    onMessage(message) {
        switch (message.type) {
            case 'load':
                void this.load(message);
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
                if (this.ctx && this.exports) {
                    const ok = this.exports.rp_seek(this.ctx, BigInt(message.frame));
                    if (ok)
                        this.resetPlayback(message.frame);
                }
                break;
            case 'volume':
                this.volume = message.value;
                break;
            case 'subsong':
                if (this.ctx && this.exports && this.exports.rp_set_subsong(this.ctx, message.index)) {
                    this.totalFrames = Number(this.exports.rp_frames(this.ctx));
                    this.playing = false;
                    this.resetPlayback(0);
                    this.port.postMessage({ type: 'subsongChanged', index: message.index, frames: this.totalFrames });
                }
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
            if (this.ctx && this.exports) {
                this.exports.rp_destroy(this.ctx);
                this.ctx = 0;
            }
            if (this.bufferPtr && this.exports) {
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
            const pointer = this.exports.malloc(bytes.length);
            if (!pointer)
                throw new Error('malloc failed');
            new Uint8Array(this.memory.buffer, pointer, bytes.length).set(bytes);
            const ok = this.exports.rp_load(this.ctx, pointer, bytes.length);
            this.exports.free(pointer);
            if (!ok) {
                this.port.postMessage({ type: 'error', message: 'Formato no soportado o archivo corrupto' });
                return;
            }
            this.totalFrames = Number(this.exports.rp_frames(this.ctx));
            this.fileRate = this.exports.rp_sample_rate(this.ctx);
            this.ratio = this.fileRate > 0 && sampleRate > 0 ? this.fileRate / sampleRate : 1;
            this.playing = Boolean(message.autoplay);
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
                subsongCount: this.exports.rp_subsong_count(this.ctx),
                subsong: this.exports.rp_subsong(this.ctx),
            });
        }
        catch (error) {
            this.port.postMessage({ type: 'error', message: String(error instanceof Error ? error.message : error) });
        }
    }
    ensureRenderBuffer(frames) {
        if (!this.exports)
            return false;
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
    process(_inputs, outputs) {
        const out = outputs[0];
        if (!out || out.length === 0)
            return true;
        const left = out[0];
        const right = out[1] || out[0];
        const frames = left.length;
        if (!this.playing || !this.ctx || !this.bufferPtr || !this.exports || !this.memory) {
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
        const exports = this.exports;
        const memory = this.memory;
        if (!exports || !memory || !this.ensureRenderBuffer(frames)) {
            this.playing = false;
            return;
        }
        const read = exports.rp_render(this.ctx, this.bufferPtr, frames);
        const view = new Float32Array(memory.buffer, this.bufferPtr, frames * 2);
        for (let i = 0; i < frames; i++) {
            left[i] = view[i * 2] * this.volume;
            if (right !== left)
                right[i] = view[i * 2 + 1] * this.volume;
        }
        this.position += read;
        this.afterRender(read);
    }
    renderResampled(frames, left, right) {
        const exports = this.exports;
        const memory = this.memory;
        if (!exports || !memory)
            return;
        const needed = Math.ceil((frames + 1) * this.ratio) + 2;
        if (!this.ensureRenderBuffer(needed)) {
            this.playing = false;
            return;
        }
        const read = exports.rp_render(this.ctx, this.bufferPtr, needed);
        const view = new Float32Array(memory.buffer, this.bufferPtr, needed * 2);
        this.ensureInput(this.inputFrames + read);
        const input = this.input;
        if (!input)
            return;
        if (read > 0)
            input.set(view.subarray(0, read * 2), this.inputFrames * 2);
        this.inputFrames += read;
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
            input.copyWithin(0, consumed * 2, count * 2);
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
