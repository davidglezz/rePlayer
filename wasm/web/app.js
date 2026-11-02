const $ = (id) => document.getElementById(id);

const FORMATS = { 1: 'WAV', 2: 'FLAC', 3: 'MP3', 4: 'PreTracker' };

const state = {
    module: null,
    wasmBytes: null,
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
};

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
    const atEnd = state.frames > 0 && state.position >= state.frames;
    $('dot').className = 'dot ' + (state.playing ? 'playing' : (state.position > 0 && !atEnd ? 'paused' : ''));
}

function updatePosition() {
    if (!state.seeking && state.frames > 0)
        $('seek').value = String(Math.round((state.position / state.frames) * 1000));
    $('time').textContent = fmtTime(state.position / state.rate);
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
    $('tech').textContent = `${state.frames.toLocaleString()} frames · ${state.rate} Hz`;
    updateSubsongUI();
}

function onProcessorMessage(message) {
    switch (message.type) {
        case 'loaded':
            state.playing = false;
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
            setStatus('fin');
            break;
        case 'error':
            state.playing = false;
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

async function startAudio() {
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
    node.port.onmessage = (event) => onProcessorMessage(event.data);
    node.connect(context.destination);
    state.node = node;

    const buffer = state.bytes;
    state.bytes = null;
    // WebAssembly.Module is structured-cloneable; send the bytes too as a
    // fallback for engines/contexts that reject the module clone.
    const wasmCopy = state.wasmBytes ? state.wasmBytes.slice(0) : undefined;
    const transfer = wasmCopy ? [buffer, wasmCopy] : [buffer];
    node.port.postMessage({ type: 'load', module: state.module, wasm: wasmCopy, data: buffer }, transfer);

    if (context.state === 'suspended')
        await context.resume();
}

async function loadFile(file) {
    if (!state.module) {
        setStatus('el core wasm aún no está listo', true);
        return;
    }

    setStatus('cargando…');

    try {
        const buffer = await file.arrayBuffer();

        // Metadata pass: a short-lived instance on the main thread.
        const { instance } = await WebAssembly.instantiate(state.module, {});
        const exports = instance.exports;
        const context = exports.rp_create();
        if (!context)
            throw new Error('no se pudo crear el contexto del decodificador');

        const pointer = exports.malloc(buffer.byteLength);
        if (!pointer) {
            exports.rp_destroy(context);
            throw new Error('sin memoria para cargar el archivo');
        }
        new Uint8Array(exports.memory.buffer, pointer, buffer.byteLength).set(new Uint8Array(buffer));
        const loaded = exports.rp_load(context, pointer, buffer.byteLength);
        exports.free(pointer);

        if (!loaded) {
            exports.rp_destroy(context);
            throw new Error('formato no soportado o archivo corrupto');
        }

        state.format = exports.rp_format(context);
        state.rate = exports.rp_sample_rate(context);
        state.channels = exports.rp_channels(context);
        state.frames = Number(exports.rp_frames(context));
        state.engineTitle = readCString(exports, exports.rp_title(context));
        state.engineArtist = readCString(exports, exports.rp_artist(context));
        state.subsongCount = exports.rp_subsong_count(context);
        state.subsong = exports.rp_subsong(context);
        exports.rp_destroy(context);

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

        await startAudio();
    } catch (error) {
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
}

$('pick').onclick = () => $('file').click();
$('change').onclick = () => $('file').click();
$('file').onchange = () => {
    const file = $('file').files && $('file').files[0];
    if (file)
        loadFile(file);
    $('file').value = '';
};

$('play').onclick = () => togglePlay();
$('stop').onclick = () => stopPlayback();

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
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file)
        loadFile(file);
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
    }
});

(async function init() {
    try {
        const response = await fetch('core.wasm');
        if (!response.ok)
            throw new Error(`no se pudo cargar core.wasm (${response.status})`);
        state.wasmBytes = await response.arrayBuffer();
        state.module = await WebAssembly.compile(state.wasmBytes);
        $('tech').textContent = 'core wasm listo';
        setStatus('listo');
    } catch (error) {
        $('tech').textContent = 'error';
        setStatus(String(error && error.message ? error.message : error), true);
        $('drop').classList.add('error');
    }
})();
