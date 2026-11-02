import { readTags } from './tags.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const NO_CACHE = window.REPLAYER_NO_CACHE === true
    || new URLSearchParams(location.search).has('nocache')
    || new URLSearchParams(location.search).get('cache') === '0';

const FORMATS: Record<number, string> = { 1: 'WAV', 2: 'FLAC', 3: 'MP3', 4: 'PreTracker', 5: 'Hively' };

interface Engine {
    name: string;
    exts: string[];
    path: string;
}

interface EngineRecord {
    module: WebAssembly.Module;
    bytes: ArrayBuffer;
}

interface QueueItem {
    id: number;
    file: File;
    name: string;
}

interface TrackInfo {
    format: number;
    rate: number;
    channels: number;
    frames: number;
    title: string;
    artist: string;
    subsongCount: number;
    subsong: number;
}

interface WasmExports {
    memory: WebAssembly.Memory;
    rp_create(): number;
    rp_destroy(ctx: number): void;
    rp_load(ctx: number, pointer: number, size: number): number;
    rp_sample_rate(ctx: number): number;
    rp_channels(ctx: number): number;
    rp_frames(ctx: number): bigint;
    rp_position(ctx: number): bigint;
    rp_format(ctx: number): number;
    rp_title(ctx: number): number;
    rp_artist(ctx: number): number;
    rp_subsong_count(ctx: number): number;
    rp_subsong(ctx: number): number;
    rp_set_subsong(ctx: number, index: number): number;
    rp_seek(ctx: number, frame: bigint): number;
    rp_render(ctx: number, out: number, frames: number): number;
    malloc(size: number): number;
    free(pointer: number): void;
}

interface ProcessorMessage {
    type: string;
    message?: string;
    frame?: number;
    frames?: number;
    index?: number;
    sampleRate?: number;
    contextSampleRate?: number;
    ratio?: number;
    subsongCount?: number;
    subsong?: number;
}

type RepeatMode = 'off' | 'all' | 'one';

interface Settings {
    volume?: number;
    repeat?: RepeatMode;
    shuffle?: boolean;
}

interface AppState {
    module: WebAssembly.Module | null;
    wasmBytes: ArrayBuffer | null;
    engineName: string;
    audioContext: AudioContext | null;
    node: AudioWorkletNode | null;
    file: File | null;
    bytes: ArrayBuffer | null;
    title: string;
    engineTitle: string;
    engineArtist: string;
    format: number;
    subsongCount: number;
    subsong: number;
    rate: number;
    channels: number;
    frames: number;
    duration: number;
    position: number;
    playing: boolean;
    volume: number;
    lastVolume: number;
    seeking: boolean;
    queue: QueueItem[];
    queueIndex: number;
    nextQueueId: number;
    repeatMode: RepeatMode;
    shuffle: boolean;
    pendingAutoplay: boolean;
    loading: boolean;
    loadToken: number;
    exporting: boolean;
}

const ENGINES: Engine[] = [
    { name: 'wav', exts: ['wav'], path: 'engines/wav.wasm' },
    { name: 'flac', exts: ['flac'], path: 'engines/flac.wasm' },
    { name: 'mp3', exts: ['mp2', 'mp3', 'aix'], path: 'engines/mp3.wasm' },
    { name: 'pretracker', exts: ['prt', 'pt'], path: 'engines/pretracker.wasm' },
    { name: 'hively', exts: ['hvl', 'ahx', 'thx'], path: 'engines/hively.wasm' },
];
const ALL_ENGINE: Engine = { name: 'all', exts: [], path: 'core.wasm' };
const engineCache = new Map<string, EngineRecord>();
const SETTINGS_KEY = 'replayer-wasm-settings';
let lastPositionState = 0;

const state: AppState = {
    module: null,
    wasmBytes: null,
    engineName: '',
    audioContext: null,
    node: null,
    file: null,
    bytes: null,
    title: '',
    engineTitle: '',
    engineArtist: '',
    format: 0,
    subsongCount: 1,
    subsong: 0,
    rate: 0,
    channels: 0,
    frames: 0,
    duration: 0,
    position: 0,
    playing: false,
    volume: 0.8,
    lastVolume: 0.8,
    seeking: false,
    queue: [],
    queueIndex: -1,
    nextQueueId: 1,
    repeatMode: 'off',
    shuffle: false,
    pendingAutoplay: false,
    loading: false,
    loadToken: 0,
    exporting: false,
};

function loadSettings(): Settings {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Settings; } catch (e) { return {}; }
}

function saveSettings(): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            volume: state.volume,
            repeat: state.repeatMode,
            shuffle: state.shuffle,
        }));
    } catch (e) { /* storage disabled */ }
}

function updateMediaSession(): void {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined')
        return;
    const title = state.engineTitle || state.title || 'rePlayer wasm';
    const artist = state.engineArtist || 'rePlayer wasm';
    navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album: FORMATS[state.format] || 'rePlayer wasm',
        artwork: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
}

function updatePositionState(): void {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function')
        return;
    if (!state.duration)
        return;
    const now = Date.now();
    if (now - lastPositionState < 500)
        return;
    lastPositionState = now;
    const position = Math.min(Math.max(state.position / state.rate, 0), state.duration);
    try {
        navigator.mediaSession.setPositionState({ duration: state.duration, playbackRate: 1, position });
    } catch (e) { /* stale duration */ }
}

function setupMediaSession(): void {
    if (!('mediaSession' in navigator))
        return;
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
        play: () => { if (!state.playing) void togglePlay(); },
        pause: () => { if (state.playing) void togglePlay(); },
        stop: () => stopPlayback(),
        previoustrack: () => previous(),
        nexttrack: () => next(),
        seekbackward: (details) => seekBy(-(details.seekOffset || 10)),
        seekforward: (details) => seekBy(details.seekOffset || 10),
        seekto: (details) => { if (typeof details.seekTime === 'number') seekTo(details.seekTime * state.rate); },
    };
    for (const action of Object.keys(handlers) as MediaSessionAction[]) {
        try { navigator.mediaSession.setActionHandler(action, handlers[action] ?? null); } catch (e) { /* unsupported action */ }
    }
}

function engineForFile(file: File): Engine {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    return ENGINES.find((engine) => engine.exts.includes(extension)) || ALL_ENGINE;
}

async function loadEngine(engine: Engine): Promise<EngineRecord> {
    const cached = engineCache.get(engine.path);
    if (cached)
        return cached;
    const url = NO_CACHE ? `${engine.path}?nocache=${Date.now()}` : engine.path;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok)
        throw new Error(`no se pudo cargar ${engine.path} (${response.status})`);
    const bytes = await response.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const record: EngineRecord = { module, bytes };
    engineCache.set(engine.path, record);
    return record;
}

async function readMetadata(module: WebAssembly.Module, buffer: ArrayBuffer): Promise<TrackInfo | null> {
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as unknown as WasmExports;
    const context = exports.rp_create();
    if (!context)
        return null;

    const pointer = exports.malloc(buffer.byteLength);
    if (!pointer) {
        exports.rp_destroy(context);
        return null;
    }
    new Uint8Array(exports.memory.buffer, pointer, buffer.byteLength).set(new Uint8Array(buffer));
    const loaded = exports.rp_load(context, pointer, buffer.byteLength);
    exports.free(pointer);
    if (!loaded) {
        exports.rp_destroy(context);
        return null;
    }

    const info: TrackInfo = {
        format: exports.rp_format(context),
        rate: exports.rp_sample_rate(context),
        channels: exports.rp_channels(context),
        frames: Number(exports.rp_frames(context)),
        title: readCString(exports, exports.rp_title(context)),
        artist: readCString(exports, exports.rp_artist(context)),
        subsongCount: exports.rp_subsong_count(context),
        subsong: exports.rp_subsong(context),
    };
    exports.rp_destroy(context);
    return info;
}

function readCString(exports: WasmExports, pointer: number): string {
    if (!pointer)
        return '';
    const memory = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (end < memory.length && memory[end] !== 0)
        end++;
    return new TextDecoder().decode(memory.subarray(pointer, end));
}

function fmtTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0)
        seconds = 0;
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function setStatus(text: string, isError = false): void {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
}

function updateTransport(): void {
    $<HTMLButtonElement>('play').textContent = state.playing ? '\u23F8' : '\u25B6';
    $<HTMLButtonElement>('play').disabled = !state.node;
    $<HTMLButtonElement>('prev').disabled = state.queue.length === 0;
    $<HTMLButtonElement>('next').disabled = state.queue.length === 0;
    $<HTMLButtonElement>('export').disabled = !state.file || state.exporting;
    const atEnd = state.frames > 0 && state.position >= state.frames;
    $('dot').className = 'dot ' + (state.playing ? 'playing' : (state.position > 0 && !atEnd ? 'paused' : ''));
    if ('mediaSession' in navigator)
        navigator.mediaSession.playbackState = state.playing ? 'playing' : (state.node ? 'paused' : 'none');
}

function updatePosition(): void {
    if (!state.seeking && state.frames > 0)
        $<HTMLInputElement>('seek').value = String(Math.round((state.position / state.frames) * 1000));
    $('time').textContent = fmtTime(state.position / state.rate);
    updatePositionState();
}

function updateSubsongUI(): void {
    const row = $('subsongRow');
    const select = $<HTMLSelectElement>('subsong');
    if (state.subsongCount > 1) {
        if (select.options.length !== state.subsongCount) {
            select.innerHTML = '';
            for (let i = 0; i < state.subsongCount; i++) {
                const option = document.createElement('option');
                option.value = String(i);
                option.textContent = `Subsong ${i + 1}`;
                select.appendChild(option);
            }
        }
        select.value = String(state.subsong);
        row.hidden = false;
    } else {
        row.hidden = true;
    }
}

function updateTrackInfo(): void {
    const format = FORMATS[state.format] || 'audio';
    const title = state.engineTitle || state.title || (state.file && state.file.name) || '—';
    const artist = state.engineArtist ? `${state.engineArtist} · ` : '';
    $('title').textContent = title;
    $('meta').textContent = `${artist}${format} · ${(state.rate / 1000).toFixed(1)} kHz · ${state.channels} ${state.channels === 1 ? 'canal' : 'canales'} · ${fmtTime(state.duration)}`;
    $('format').textContent = format;
    $('duration').textContent = fmtTime(state.duration);
    $('tech').textContent = `${state.engineName || 'wasm'} · ${state.frames.toLocaleString()} frames · ${state.rate} Hz`;
    updateSubsongUI();
    updateMediaSession();
}

function renderPlaylist(): void {
    const list = $<HTMLOListElement>('playlist');
    list.innerHTML = '';
    $('plcount').textContent = state.queue.length ? `(${state.queue.length})` : '';
    if (!state.queue.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'Arrastra uno o varios archivos…';
        list.appendChild(empty);
        return;
    }

    state.queue.forEach((item, index) => {
        const row = document.createElement('li');
        if (index === state.queueIndex)
            row.className = 'current';

        const play = document.createElement('button');
        play.className = 'track';
        play.textContent = item.name;
        play.title = item.name;
        play.onclick = () => { void playIndex(index); };
        row.appendChild(play);

        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '\u00D7';
        remove.title = 'Quitar de la playlist';
        remove.onclick = (event) => {
            event.stopPropagation();
            void removeFromQueue(index);
        };
        row.appendChild(remove);

        list.appendChild(row);
    });
}

function updateModeButtons(): void {
    $('shuffle').classList.toggle('active', state.shuffle);
    $('repeat').classList.toggle('active', state.repeatMode !== 'off');
    $('repeat').textContent = state.repeatMode === 'one' ? '\uD83D\uDD02' : '\uD83D\uDD01';
    $('repeat').title = state.repeatMode === 'off' ? 'Repetir: off' : (state.repeatMode === 'one' ? 'Repetir: una' : 'Repetir: todas');
    $('shuffle').title = state.shuffle ? 'Aleatorio: on' : 'Aleatorio: off';
}

function addFiles(fileList: FileList | null): void {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length)
        return;

    for (const file of files)
        state.queue.push({ id: state.nextQueueId++, file, name: file.name });

    $('drop').hidden = true;
    $('player').hidden = false;
    renderPlaylist();
    updateTransport();

    if (state.queueIndex < 0)
        void playIndex(0, true);
    else
        setStatus(`${files.length} archivo(s) añadido(s)`);
}

async function playIndex(index: number, autoplay = true): Promise<void> {
    if (index < 0 || index >= state.queue.length || state.loading)
        return;
    state.queueIndex = index;
    renderPlaylist();
    await loadFile(state.queue[index].file, autoplay);
}

async function removeFromQueue(index: number): Promise<void> {
    if (index < 0 || index >= state.queue.length)
        return;

    const wasCurrent = index === state.queueIndex;
    state.queue.splice(index, 1);

    if (wasCurrent) {
        state.loadToken++;
        state.loading = false;
        await stopAudio();
        state.node = null;
        state.queueIndex = -1;
        state.playing = false;
        if (state.queue.length) {
            const nextIndex = Math.min(index, state.queue.length - 1);
            void playIndex(nextIndex, true);
        } else {
            state.file = null;
            $('player').hidden = true;
            $('drop').hidden = false;
            setStatus('playlist vacía');
        }
    } else if (index < state.queueIndex) {
        state.queueIndex--;
    }

    renderPlaylist();
    updateTransport();
}

async function clearQueue(): Promise<void> {
    if (!state.queue.length)
        return;
    if (!confirm('¿Vaciar la playlist?'))
        return;

    state.queue = [];
    state.queueIndex = -1;
    state.file = null;
    state.loadToken++;
    state.loading = false;
    await stopAudio();
    state.node = null;
    $('player').hidden = true;
    $('drop').hidden = false;
    renderPlaylist();
    updateTransport();
    setStatus('playlist vacía');
}

function next(autoplay = true): void {
    if (!state.queue.length)
        return;

    let index: number;
    if (state.shuffle) {
        if (state.queue.length === 1)
            index = 0;
        else
            do { index = Math.floor(Math.random() * state.queue.length); } while (index === state.queueIndex);
    } else {
        index = state.queueIndex + 1;
        if (index >= state.queue.length) {
            if (state.repeatMode === 'all')
                index = 0;
            else {
                setStatus('fin de la lista');
                return;
            }
        }
    }
    void playIndex(index, autoplay);
}

function previous(autoplay = true): void {
    if (!state.queue.length)
        return;

    let index: number;
    if (state.shuffle) {
        if (state.queue.length === 1)
            index = 0;
        else
            do { index = Math.floor(Math.random() * state.queue.length); } while (index === state.queueIndex);
    } else {
        index = state.queueIndex - 1;
        if (index < 0) {
            if (state.repeatMode === 'all')
                index = state.queue.length - 1;
            else
                index = 0;
        }
    }
    void playIndex(index, autoplay);
}

function onProcessorMessage(message: ProcessorMessage): void {
    switch (message.type) {
        case 'loaded':
            state.playing = state.pendingAutoplay;
            state.pendingAutoplay = false;
            state.position = 0;
            $<HTMLInputElement>('seek').disabled = false;
            updatePosition();
            updateTransport();
            if (message.subsongCount)
                state.subsongCount = message.subsongCount;
            if (message.subsong !== undefined)
                state.subsong = message.subsong;
            updateSubsongUI();
            if (message.ratio && Math.abs(message.ratio - 1) > 1e-6)
                setStatus(`resampling ${message.sampleRate} → ${message.contextSampleRate} Hz`);
            else
                setStatus(`${FORMATS[state.format] || 'audio'} listo`);
            break;
        case 'subsongChanged':
            state.subsong = message.index ?? 0;
            state.frames = message.frames ?? state.frames;
            state.duration = state.rate ? state.frames / state.rate : 0;
            state.position = 0;
            state.playing = false;
            updateTrackInfo();
            updatePosition();
            updateTransport();
            setStatus(`subsong ${(message.index ?? 0) + 1}`);
            break;
        case 'position':
            if (!state.seeking && typeof message.frame === 'number') {
                state.position = message.frame;
                updatePosition();
            }
            break;
        case 'ended':
            state.playing = false;
            state.position = state.frames;
            updatePosition();
            updateTransport();
            if (state.repeatMode === 'one' && state.node) {
                state.node.port.postMessage({ type: 'seek', frame: 0 });
                state.node.port.postMessage({ type: 'play' });
                state.playing = true;
                state.position = 0;
                updateTransport();
                setStatus('repitiendo');
            } else {
                next(true);
            }
            break;
        case 'error':
            state.pendingAutoplay = false;
            state.playing = false;
            state.loading = false;
            updateTransport();
            setStatus(message.message || 'error', true);
            break;
        default:
            break;
    }
}

async function stopAudio(): Promise<void> {
    if (state.node) {
        try { state.node.port.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
        try { state.node.disconnect(); } catch (e) { /* ignore */ }
        state.node = null;
    }
    if (state.audioContext) {
        try { await state.audioContext.close(); } catch (e) { /* ignore */ }
        state.audioContext = null;
    }
    state.playing = false;
}

async function startAudio(autoplay: boolean): Promise<void> {
    await stopAudio();

    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass)
        throw new Error('Este navegador no soporta Web Audio');

    let context: AudioContext;
    try {
        context = new AudioContextClass({ sampleRate: state.rate });
    } catch (e) {
        context = new AudioContextClass();
    }
    state.audioContext = context;

    if (Math.abs(context.sampleRate - state.rate) > 1)
        setStatus(`resampling ${state.rate} → ${context.sampleRate} Hz`);

    await context.audioWorklet.addModule(NO_CACHE ? `processor.js?nocache=${Date.now()}` : 'processor.js');

    const node = new AudioWorkletNode(context, 'rp-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
    });
    node.port.onmessage = (event: MessageEvent) => {
        if (state.node === node)
            onProcessorMessage(event.data as ProcessorMessage);
    };
    node.connect(context.destination);
    state.node = node;

    const buffer = state.bytes;
    const module = state.module;
    if (!buffer || !module)
        throw new Error('no hay audio cargado');
    state.bytes = null;
    // WebAssembly.Module is structured-cloneable; send the bytes too as a
    // fallback for engines/contexts that reject the module clone.
    const wasmCopy = state.wasmBytes ? state.wasmBytes.slice(0) : undefined;
    const transfer: Transferable[] = wasmCopy ? [buffer, wasmCopy] : [buffer];
    node.port.postMessage({
        type: 'load',
        module,
        wasm: wasmCopy,
        data: buffer,
        autoplay: !!autoplay,
    }, transfer);

    if (context.state === 'suspended')
        await context.resume();
}

function writeAscii(view: DataView, offset: number, text: string): void {
    for (let i = 0; i < text.length; i++)
        view.setUint8(offset + i, text.charCodeAt(i));
}

async function exportCurrent(): Promise<void> {
    if (!state.file || !state.module || state.exporting)
        return;

    const file = state.file;
    const module = state.module;
    state.exporting = true;
    updateTransport();
    setStatus('exportando…');

    let context = 0;
    let exports: WasmExports | null = null;
    let outputPointer = 0;
    try {
        const buffer = await file.arrayBuffer();
        const instance = await WebAssembly.instantiate(module, {});
        exports = instance.exports as unknown as WasmExports;
        context = exports.rp_create();
        if (!context)
            throw new Error('no se pudo crear el contexto del decodificador');

        const pointer = exports.malloc(buffer.byteLength);
        if (!pointer)
            throw new Error('sin memoria para cargar el archivo');
        new Uint8Array(exports.memory.buffer, pointer, buffer.byteLength).set(new Uint8Array(buffer));
        const loaded = exports.rp_load(context, pointer, buffer.byteLength);
        exports.free(pointer);
        if (!loaded)
            throw new Error('formato no soportado o archivo corrupto');

        const frames = Number(exports.rp_frames(context));
        const rate = exports.rp_sample_rate(context);
        const block = 4096;
        outputPointer = exports.malloc(block * 2 * 4);
        if (!outputPointer)
            throw new Error('sin memoria para renderizar');

        const pcmChunks: BlobPart[] = [];
        let done = 0;
        while (done < frames) {
            const want = Math.min(block, frames - done);
            const got = exports.rp_render(context, outputPointer, want);
            if (got <= 0)
                break;
            const floats = new Float32Array(exports.memory.buffer, outputPointer, got * 2);
            const pcm = new Int16Array(got * 2);
            for (let i = 0; i < got * 2; i++) {
                const sample = Math.max(-1, Math.min(1, floats[i]));
                pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
            }
            pcmChunks.push(new Uint8Array(pcm.buffer) as BlobPart);
            done += got;
            if (frames > block * 32 && done % (block * 16) === 0)
                setStatus(`exportando… ${Math.round((done / frames) * 100)}%`);
        }

        const dataSize = done * 4;
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
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

        const blob = new Blob([header, ...pcmChunks], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name.replace(/\.[^.]+$/, '') + '.wav';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(`WAV exportado (${(blob.size / 1048576).toFixed(1)} MB)`);
    } catch (error) {
        setStatus(`export: ${error instanceof Error ? error.message : error}`, true);
    } finally {
        if (context && exports)
            exports.rp_destroy(context);
        if (outputPointer && exports)
            exports.free(outputPointer);
        state.exporting = false;
        updateTransport();
    }
}

async function loadFile(file: File, autoplay = false): Promise<void> {
    const token = ++state.loadToken;
    state.loading = true;
    state.pendingAutoplay = !!autoplay;
    setStatus('cargando…');

    try {
        const buffer = await file.arrayBuffer();
        let engine = engineForFile(file);
        let record: EngineRecord | null = null;
        let info: TrackInfo | null = null;

        try {
            setStatus(`cargando motor ${engine.name}…`);
            record = await loadEngine(engine);
            info = await readMetadata(record.module, buffer);
        } catch (error) {
            if (engine === ALL_ENGINE)
                throw error;
        }

        // Unknown extension or a wrong/partial per-engine module: fall back to
        // the all-in-one module, which probes every decoder.
        if (!info && engine !== ALL_ENGINE) {
            setStatus('probando con el motor completo…');
            engine = ALL_ENGINE;
            record = await loadEngine(engine);
            info = await readMetadata(record.module, buffer);
        }

        if (!info || !record)
            throw new Error('formato no soportado o archivo corrupto');
        if (token !== state.loadToken)
            return;

        const tags = readTags(new Uint8Array(buffer), info.format);
        state.module = record.module;
        state.wasmBytes = record.bytes;
        state.engineName = engine.name;
        state.format = info.format;
        state.rate = info.rate;
        state.channels = info.channels;
        state.frames = info.frames;
        state.engineTitle = info.title || tags.title;
        state.engineArtist = info.artist || tags.artist;
        state.subsongCount = info.subsongCount;
        state.subsong = info.subsong;
        state.duration = state.rate ? state.frames / state.rate : 0;
        state.position = 0;
        state.playing = false;
        state.file = file;
        state.title = file.name.replace(/\.[^.]+$/, '');
        state.bytes = buffer;

        $('drop').hidden = true;
        $('player').hidden = false;
        updateTrackInfo();
        updatePosition();
        updateTransport();
        renderPlaylist();

        await startAudio(autoplay);
        if (token !== state.loadToken)
            return;
        state.loading = false;
    } catch (error) {
        if (token !== state.loadToken)
            return;
        state.loading = false;
        state.pendingAutoplay = false;
        setStatus(error instanceof Error ? error.message : String(error), true);
        if ($('player').hidden)
            $('drop').classList.add('error');
    }
}

async function togglePlay(): Promise<void> {
    if (!state.node || !state.audioContext)
        return;

    if (state.audioContext.state === 'suspended')
        await state.audioContext.resume();

    if (state.playing) {
        state.node.port.postMessage({ type: 'pause' });
        state.playing = false;
    } else {
        if (state.frames > 0 && state.position >= state.frames) {
            state.node.port.postMessage({ type: 'seek', frame: 0 });
            state.position = 0;
        }
        state.node.port.postMessage({ type: 'play' });
        state.playing = true;
    }
    updateTransport();
}

function stopPlayback(): void {
    if (!state.node)
        return;
    state.node.port.postMessage({ type: 'stop' });
    state.playing = false;
    state.position = 0;
    updateTransport();
    updatePosition();
    setStatus('detenido');
}

function seekTo(frame: number): void {
    if (!state.node || !state.frames)
        return;
    frame = Math.max(0, Math.min(state.frames, Math.round(frame)));
    state.node.port.postMessage({ type: 'seek', frame });
    state.position = frame;
    updatePosition();
}

function seekBy(seconds: number): void {
    seekTo(state.position + seconds * state.rate);
}

function setVolume(value: number): void {
    state.volume = Math.max(0, Math.min(1, value));
    if (state.volume > 0)
        state.lastVolume = state.volume;
    if (state.node)
        state.node.port.postMessage({ type: 'volume', value: state.volume });
    $<HTMLInputElement>('vol').value = String(Math.round(state.volume * 100));
    $('mute').textContent = state.volume === 0 ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    saveSettings();
}

$<HTMLButtonElement>('pick').onclick = () => $<HTMLInputElement>('file').click();
$<HTMLButtonElement>('change').onclick = () => $<HTMLInputElement>('file').click();
$<HTMLInputElement>('file').onchange = () => {
    addFiles($<HTMLInputElement>('file').files);
    $<HTMLInputElement>('file').value = '';
};

$<HTMLButtonElement>('play').onclick = () => { void togglePlay(); };
$<HTMLButtonElement>('stop').onclick = () => stopPlayback();
$<HTMLButtonElement>('export').onclick = () => { void exportCurrent(); };
$<HTMLButtonElement>('prev').onclick = () => previous();
$<HTMLButtonElement>('next').onclick = () => next();
$<HTMLButtonElement>('shuffle').onclick = () => {
    state.shuffle = !state.shuffle;
    updateModeButtons();
    saveSettings();
    setStatus(state.shuffle ? 'aleatorio' : 'orden normal');
};
$<HTMLButtonElement>('repeat').onclick = () => {
    state.repeatMode = state.repeatMode === 'off' ? 'all' : (state.repeatMode === 'all' ? 'one' : 'off');
    updateModeButtons();
    saveSettings();
    setStatus(`repeat: ${state.repeatMode}`);
};
$<HTMLButtonElement>('clear').onclick = () => { void clearQueue(); };

$<HTMLInputElement>('seek').oninput = () => {
    state.seeking = true;
    if (state.frames > 0)
        $('time').textContent = fmtTime((Number($<HTMLInputElement>('seek').value) / 1000) * state.duration);
};
$<HTMLInputElement>('seek').onchange = () => {
    seekTo((Number($<HTMLInputElement>('seek').value) / 1000) * state.frames);
    state.seeking = false;
    updatePosition();
};

$<HTMLInputElement>('vol').oninput = () => setVolume(Number($<HTMLInputElement>('vol').value) / 100);
$<HTMLButtonElement>('mute').onclick = () => setVolume(state.volume > 0 ? 0 : (state.lastVolume || 0.8));

$<HTMLSelectElement>('subsong').onchange = () => {
    if (!state.node)
        return;
    const index = Number($<HTMLSelectElement>('subsong').value);
    state.subsong = index;
    state.node.port.postMessage({ type: 'subsong', index });
    setStatus(`subsong ${index + 1}`);
};

(['dragenter', 'dragover'] as const).forEach((type) => {
    document.addEventListener(type, (event) => {
        event.preventDefault();
        $('drop').classList.add('drag');
    });
});
(['dragleave', 'drop'] as const).forEach((type) => {
    document.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === 'drop' || event.relatedTarget === null)
            $('drop').classList.remove('drag');
    });
});
document.addEventListener('drop', (event: DragEvent) => {
    event.preventDefault();
    addFiles(event.dataTransfer?.files ?? null);
});

document.addEventListener('keydown', (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
        return;
    if (event.code === 'Space') {
        event.preventDefault();
        void togglePlay();
    } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        seekBy(5);
    } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        seekBy(-5);
    } else if (event.code === 'KeyN') {
        event.preventDefault();
        next();
    } else if (event.code === 'KeyP') {
        event.preventDefault();
        previous();
    }
});

if (NO_CACHE) {
    // Development mode: drop any installed worker and cached assets, then
    // reload once so the current page stops being controlled by it.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations()
            .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
            .then(() => 'caches' in window ? caches.keys() : [])
            .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
            .then(() => {
                if (navigator.serviceWorker.controller && !sessionStorage.getItem('rp-nocache-reload')) {
                    sessionStorage.setItem('rp-nocache-reload', '1');
                    location.reload();
                }
            })
            .catch(() => { /* cache is optional */ });
    }
} else {
    try { sessionStorage.removeItem('rp-nocache-reload'); } catch (e) { /* ignore */ }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
    }
}

(function init(): void {
    const saved = loadSettings();
    if (typeof saved.volume === 'number')
        setVolume(saved.volume);
    else
        setVolume(state.volume);
    if (saved.repeat === 'off' || saved.repeat === 'all' || saved.repeat === 'one')
        state.repeatMode = saved.repeat;
    if (typeof saved.shuffle === 'boolean')
        state.shuffle = saved.shuffle;

    $('tech').textContent = NO_CACHE ? 'cache off · motores bajo demanda' : 'motores bajo demanda';
    setStatus(NO_CACHE ? 'cache desactivada' : 'listo');
    renderPlaylist();
    updateModeButtons();
    setupMediaSession();
})();
