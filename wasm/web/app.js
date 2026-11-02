const $ = (id) => document.getElementById(id);

const FORMATS = { 1: 'WAV', 2: 'FLAC', 3: 'MP3', 4: 'PreTracker', 5: 'Hively' };

const ENGINES = [
    { name: 'wav', exts: ['wav'], path: 'engines/wav.wasm' },
    { name: 'flac', exts: ['flac'], path: 'engines/flac.wasm' },
    { name: 'mp3', exts: ['mp2', 'mp3', 'aix'], path: 'engines/mp3.wasm' },
    { name: 'pretracker', exts: ['prt', 'pt'], path: 'engines/pretracker.wasm' },
    { name: 'hively', exts: ['hvl', 'ahx', 'thx'], path: 'engines/hively.wasm' },
];
const ALL_ENGINE = { name: 'all', path: 'core.wasm' };
const engineCache = new Map();
const SETTINGS_KEY = 'replayer-wasm-settings';
let lastPositionState = 0;

function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            volume: state.volume,
            repeat: state.repeatMode,
            shuffle: state.shuffle,
        }));
    } catch (e) { /* storage disabled */ }
}

function updateMediaSession() {
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

function updatePositionState() {
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

function setupMediaSession() {
    if (!('mediaSession' in navigator))
        return;
    const handlers = {
        play: () => { if (!state.playing) togglePlay(); },
        pause: () => { if (state.playing) togglePlay(); },
        stop: () => stopPlayback(),
        previoustrack: () => previous(),
        nexttrack: () => next(),
        seekbackward: (details) => seekBy(-(details.seekOffset || 10)),
        seekforward: (details) => seekBy(details.seekOffset || 10),
        seekto: (details) => { if (typeof details.seekTime === 'number') seekTo(details.seekTime * state.rate); },
    };
    for (const [action, handler] of Object.entries(handlers)) {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) { /* unsupported action */ }
    }
}

const state = {
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
};

function engineForFile(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    return ENGINES.find((engine) => engine.exts.includes(extension)) || ALL_ENGINE;
}

async function loadEngine(engine) {
    if (engineCache.has(engine.path))
        return engineCache.get(engine.path);
    const response = await fetch(engine.path, { cache: 'no-store' });
    if (!response.ok)
        throw new Error(`no se pudo cargar ${engine.path} (${response.status})`);
    const bytes = await response.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const record = { module, bytes };
    engineCache.set(engine.path, record);
    return record;
}

async function readMetadata(module, buffer) {
    const { instance } = await WebAssembly.instantiate(module, {});
    const exports = instance.exports;
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

    const info = {
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

function readCString(exports, pointer) {
    if (!pointer)
        return '';
    const memory = new Uint8Array(exports.memory.buffer);
    let end = pointer;
    while (end < memory.length && memory[end] !== 0)
        end++;
    return new TextDecoder().decode(memory.subarray(pointer, end));
}

function fmtTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        seconds = 0;
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function setStatus(text, isError = false) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
}

function updateTransport() {
    $('play').textContent = state.playing ? '\u23F8' : '\u25B6';
    $('play').disabled = !state.node;
    $('prev').disabled = state.queue.length === 0;
    $('next').disabled = state.queue.length === 0;
    const atEnd = state.frames > 0 && state.position >= state.frames;
    $('dot').className = 'dot ' + (state.playing ? 'playing' : (state.position > 0 && !atEnd ? 'paused' : ''));
    if ('mediaSession' in navigator)
        navigator.mediaSession.playbackState = state.playing ? 'playing' : (state.node ? 'paused' : 'none');
}

function updatePosition() {
    if (!state.seeking && state.frames > 0)
        $('seek').value = String(Math.round((state.position / state.frames) * 1000));
    $('time').textContent = fmtTime(state.position / state.rate);
    updatePositionState();
}

function updateSubsongUI() {
    const row = $('subsongRow');
    const select = $('subsong');
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

function updateTrackInfo() {
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

function renderPlaylist() {
    const list = $('playlist');
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
        play.onclick = () => playIndex(index);
        row.appendChild(play);

        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '\u00D7';
        remove.title = 'Quitar de la playlist';
        remove.onclick = (event) => {
            event.stopPropagation();
            removeFromQueue(index);
        };
        row.appendChild(remove);

        list.appendChild(row);
    });
}

function updateModeButtons() {
    $('shuffle').classList.toggle('active', state.shuffle);
    $('repeat').classList.toggle('active', state.repeatMode !== 'off');
    $('repeat').textContent = state.repeatMode === 'one' ? '\uD83D\uDD02' : '\uD83D\uDD01';
    $('repeat').title = state.repeatMode === 'off' ? 'Repetir: off' : (state.repeatMode === 'one' ? 'Repetir: una' : 'Repetir: todas');
    $('shuffle').title = state.shuffle ? 'Aleatorio: on' : 'Aleatorio: off';
}

function addFiles(fileList) {
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
        playIndex(0, true);
    else
        setStatus(`${files.length} archivo(s) añadido(s)`);
}

async function playIndex(index, autoplay = true) {
    if (index < 0 || index >= state.queue.length || state.loading)
        return;
    state.queueIndex = index;
    renderPlaylist();
    await loadFile(state.queue[index].file, autoplay);
}

async function removeFromQueue(index) {
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
            playIndex(nextIndex, true);
        } else {
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

async function clearQueue() {
    if (!state.queue.length)
        return;
    if (!confirm('¿Vaciar la playlist?'))
        return;

    state.queue = [];
    state.queueIndex = -1;
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

function next(autoplay = true) {
    if (!state.queue.length)
        return;

    let index;
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
    playIndex(index, autoplay);
}

function previous(autoplay = true) {
    if (!state.queue.length)
        return;

    let index;
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
    playIndex(index, autoplay);
}

function onProcessorMessage(message) {
    switch (message.type) {
        case 'loaded':
            state.playing = state.pendingAutoplay;
            state.pendingAutoplay = false;
            state.position = 0;
            $('seek').disabled = false;
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
            state.subsong = message.index;
            state.frames = message.frames;
            state.duration = state.rate ? state.frames / state.rate : 0;
            state.position = 0;
            state.playing = false;
            updateTrackInfo();
            updatePosition();
            updateTransport();
            setStatus(`subsong ${message.index + 1}`);
            break;
        case 'position':
            if (!state.seeking) {
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
            setStatus(message.message, true);
            break;
        default:
            break;
    }
}

async function stopAudio() {
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

async function startAudio(autoplay) {
    await stopAudio();

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass)
        throw new Error('Este navegador no soporta Web Audio');

    let context;
    try {
        context = new AudioContextClass({ sampleRate: state.rate });
    } catch (e) {
        context = new AudioContextClass();
    }
    state.audioContext = context;

    if (Math.abs(context.sampleRate - state.rate) > 1)
        setStatus(`resampling ${state.rate} → ${context.sampleRate} Hz`);

    await context.audioWorklet.addModule('processor.js');

    const node = new AudioWorkletNode(context, 'rp-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
    });
    node.port.onmessage = (event) => {
        if (state.node === node)
            onProcessorMessage(event.data);
    };
    node.connect(context.destination);
    state.node = node;

    const buffer = state.bytes;
    state.bytes = null;
    // WebAssembly.Module is structured-cloneable; send the bytes too as a
    // fallback for engines/contexts that reject the module clone.
    const wasmCopy = state.wasmBytes ? state.wasmBytes.slice(0) : undefined;
    const transfer = wasmCopy ? [buffer, wasmCopy] : [buffer];
    node.port.postMessage({
        type: 'load',
        module: state.module,
        wasm: wasmCopy,
        data: buffer,
        autoplay: !!autoplay,
    }, transfer);

    if (context.state === 'suspended')
        await context.resume();
}

async function loadFile(file, autoplay = false) {
    const token = ++state.loadToken;
    state.loading = true;
    state.pendingAutoplay = !!autoplay;
    setStatus('cargando…');

    try {
        const buffer = await file.arrayBuffer();
        let engine = engineForFile(file);
        let record = null;
        let info = null;

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

        if (!info)
            throw new Error('formato no soportado o archivo corrupto');
        if (token !== state.loadToken)
            return;

        state.module = record.module;
        state.wasmBytes = record.bytes;
        state.engineName = engine.name;
        state.format = info.format;
        state.rate = info.rate;
        state.channels = info.channels;
        state.frames = info.frames;
        state.engineTitle = info.title;
        state.engineArtist = info.artist;
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
        const message = String(error && error.message ? error.message : error);
        setStatus(message, true);
        if ($('player').hidden)
            $('drop').classList.add('error');
    }
}

async function togglePlay() {
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

function stopPlayback() {
    if (!state.node)
        return;
    state.node.port.postMessage({ type: 'stop' });
    state.playing = false;
    state.position = 0;
    updateTransport();
    updatePosition();
    setStatus('detenido');
}

function seekTo(frame) {
    if (!state.node || !state.frames)
        return;
    frame = Math.max(0, Math.min(state.frames, Math.round(frame)));
    state.node.port.postMessage({ type: 'seek', frame });
    state.position = frame;
    updatePosition();
}

function seekBy(seconds) {
    seekTo(state.position + seconds * state.rate);
}

function setVolume(value) {
    state.volume = Math.max(0, Math.min(1, value));
    if (state.volume > 0)
        state.lastVolume = state.volume;
    if (state.node)
        state.node.port.postMessage({ type: 'volume', value: state.volume });
    $('vol').value = String(Math.round(state.volume * 100));
    $('mute').textContent = state.volume === 0 ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    saveSettings();
}

$('pick').onclick = () => $('file').click();
$('change').onclick = () => $('file').click();
$('file').onchange = () => {
    addFiles($('file').files);
    $('file').value = '';
};

$('play').onclick = () => togglePlay();
$('stop').onclick = () => stopPlayback();
$('prev').onclick = () => previous();
$('next').onclick = () => next();
$('shuffle').onclick = () => {
    state.shuffle = !state.shuffle;
    updateModeButtons();
    saveSettings();
    setStatus(state.shuffle ? 'aleatorio' : 'orden normal');
};
$('repeat').onclick = () => {
    state.repeatMode = state.repeatMode === 'off' ? 'all' : (state.repeatMode === 'all' ? 'one' : 'off');
    updateModeButtons();
    saveSettings();
    setStatus(`repeat: ${state.repeatMode}`);
};
$('clear').onclick = () => clearQueue();

$('seek').oninput = () => {
    state.seeking = true;
    if (state.frames > 0)
        $('time').textContent = fmtTime((Number($('seek').value) / 1000) * state.duration);
};
$('seek').onchange = () => {
    seekTo((Number($('seek').value) / 1000) * state.frames);
    state.seeking = false;
    updatePosition();
};

$('vol').oninput = () => setVolume(Number($('vol').value) / 100);
$('mute').onclick = () => setVolume(state.volume > 0 ? 0 : (state.lastVolume || 0.8));

$('subsong').onchange = () => {
    if (!state.node)
        return;
    const index = Number($('subsong').value);
    state.subsong = index;
    state.node.port.postMessage({ type: 'subsong', index });
    setStatus(`subsong ${index + 1}`);
};

['dragenter', 'dragover'].forEach((type) => {
    document.addEventListener(type, (event) => {
        event.preventDefault();
        $('drop').classList.add('drag');
    });
});
['dragleave', 'drop'].forEach((type) => {
    document.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === 'drop' || event.relatedTarget === null)
            $('drop').classList.remove('drag');
    });
});
document.addEventListener('drop', (event) => {
    event.preventDefault();
    addFiles(event.dataTransfer && event.dataTransfer.files);
});

document.addEventListener('keydown', (event) => {
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
        return;
    if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
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

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
}

(function init() {
    const saved = loadSettings();
    if (typeof saved.volume === 'number')
        setVolume(saved.volume);
    else
        setVolume(state.volume);
    if (saved.repeat === 'off' || saved.repeat === 'all' || saved.repeat === 'one')
        state.repeatMode = saved.repeat;
    if (typeof saved.shuffle === 'boolean')
        state.shuffle = saved.shuffle;

    $('tech').textContent = 'motores bajo demanda';
    setStatus('listo');
    renderPlaylist();
    updateModeButtons();
    setupMediaSession();
})();
