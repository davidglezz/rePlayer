# rePlayer wasm core (opción B)

Prototipo de la ruta **B**: un núcleo de reproducción *headless* compilado a
WebAssembly con una ABI C, más una interfaz web que lo controla. No incluye la
app Win32, DirectX, ImGui, las DLLs de los 62 motores ni la base de datos.

## Qué hay

```
wasm/
  core/core.cpp     # WAV/FLAC/MP3/PreTracker/Hively + ABI C
  build.ps1         # compila los módulos wasm con zig (clang + wasm-ld)
  web/index.html    # UI
  web/app.js        # carga de archivos, AudioContext, controles
  web/processor.js  # AudioWorklet: renderiza PCM desde el wasm
  web/engines/*.wasm# módulos por motor (wav, flac, mp3, pretracker, hively)
  web/core.wasm     # módulo "all" de fallback (203 KB, sin imports)
  server.mjs        # servidor estático local
  test-core.cjs     # test de humo del core en Node
  test-engines.cjs  # test de los módulos por motor
  test-processor.cjs# test del AudioWorklet (directo + resampling)
```

## Formatos y ABI

- **WAV** (`dr_wav`), **FLAC** (`dr_flac`), **MP3** (`dr_mp3`),
  **PreTracker** (`source/Replays/PreTracker/pretracker`, MIT) y **Hively**
  (`source/Replays/Hively/hvl`). Todos desde memoria, sin sistema de ficheros.
- PreTracker es el primer **motor real de rePlayer** integrado en el core:
  usa su API C (`pre_song_create(data, size)`, `pre_song_decode`), se configura
  a 48 kHz y se renderiza a estéreo. `pre_song_get_length()` avanza el player,
  así que el core lo reinicia después de consultar la duración. También expone
  el título y el autor del módulo (`PreSongMetadata`).
- Hively/AHX es el segundo motor real: `hvl_ParseTune(buf, len, ...)` desde
  memoria, `hvl_Decode` a PCM int16, `hvl_GetDuration`, `hvl_Seek` nativo y
  `hvl_InitSubsong` para los subsongs. Se añadió un pequeño shim
  (`core/hively_compat.h`) para `fopen_s`/`strncpy_s` de MSVC y se marcaron las
  tablas de `hvl_tables.h` como `extern` para compilar `hvl_replay.c` y
  `hvl_tables.c` por separado (también sigue compilando en MSVC).
- ABI C mínima: `rp_create`, `rp_load`, `rp_sample_rate`, `rp_channels`,
  `rp_frames`, `rp_position`, `rp_format`, `rp_title`, `rp_artist`,
  `rp_subsong_count`, `rp_subsong`, `rp_set_subsong`, `rp_seek`, `rp_render`,
  `rp_destroy`, y `malloc`/`free` para pasar los bytes del archivo.
  `rp_format` devuelve `1` WAV, `2` FLAC, `3` MP3, `4` PreTracker, `5` Hively.
- Los módulos PreTracker con varios subsongs muestran un selector en la UI; el
  cambio reinicia el motor y recalcula la duración. Los demás formatos declaran
  un único subsong.
- El módulo **no tiene imports** (`wasm32-wasi` en modo reactor): no usa WASI,
  hilos ni el filesystem. `WebAssembly.Module` se envía al `AudioWorklet`, que
  instancia el core en el hilo de audio y va pidiendo bloques con `rp_render`.

## Carga bajo demanda

La UI elige el motor por la extensión del archivo y carga **solo** ese `.wasm`:

| Módulo | Tamaño | Extensiones |
|---|---:|---|
| `engines/wav.wasm` | ~41 KB | `.wav` |
| `engines/flac.wasm` | ~66 KB | `.flac` |
| `engines/mp3.wasm` | ~40 KB | `.mp2`, `.mp3`, `.aix` |
| `engines/pretracker.wasm` | ~29 KB | `.prt`, `.pt` |
| `engines/hively.wasm` | ~38 KB | `.hvl`, `.ahx`, `.thx` |
| `core.wasm` (all) | ~203 KB | fallback |

Si la extensión no se reconoce, o el módulo específico rechaza el archivo, se
carga `core.wasm` (que incluye los 5 decoders) y se reintenta. Los módulos se
cachean en memoria (`engineCache`), así que cambiar entre dos `.wav` no vuelve a
descargar nada.

## Compilar

Necesitas [Zig](https://ziglang.org/download/) (probado con 0.17.0; incluye
clang y wasm-ld, no hace falta Emscripten ni Python):

```powershell
.\wasm\build.ps1 -Zig C:\ruta\a\zig.exe
```

Si `zig` está en el `PATH`, basta con `.\wasm\build.ps1`. Para compilar solo
algunos módulos: `.\wasm\build.ps1 -Only wav,hively,all`.

Test rápido del core (genera un WAV en memoria, sin navegador):

```powershell
node .\wasm\test-core.cjs
# y, opcionalmente, un .prt/.pt y un .hvl/.ahx/.thx:
node .\wasm\test-core.cjs C:\ruta\a\modulo.prt C:\ruta\a\modulo.hvl

# AudioWorklet: render directo y resampling 44.1k -> 48k
node .\wasm\test-processor.cjs

# módulos por motor (y aislamiento de formatos)
node .\wasm\test-engines.cjs C:\ruta\a\modulo.prt C:\ruta\a\modulo.hvl
```

## Ejecutar

```powershell
node .\wasm\server.mjs
```

Abre **http://127.0.0.1:8787/**, arrastra uno o varios archivos y dale a play.
`127.0.0.1` es contexto seguro, así que `AudioWorklet` funciona sin HTTPS.

## Reproductor

- Playlist con **varios archivos** (selección múltiple o arrastrando varios).
- **Anterior/siguiente**, auto-avance al terminar, **repetir** (off/todas/una) y
  **aleatorio**.
- Quitar canciones de la lista, vaciarla, seek, volumen/mute y selector de
  subsong cuando el motor lo soporta.
- Atajos: `Espacio` play/pausa, `←`/`→` ±5 s, `N` siguiente, `P` anterior.
- Los ficheros que no se pueden cargar muestran el error y se pueden quitar de
  la lista; no bloquean el resto.

## Limitaciones de este prototipo

- 5 motores (WAV/FLAC/MP3/PreTracker/Hively). El resto de los 62 necesitaría
  una ABI C por motor o un proxy que envuelva el `ReplayPlugin` actual.
- `core.wasm` incluye los 5 decoders y se usa como fallback; para producción se
  podría eliminar y dejar solo los módulos por motor.
- La playlist vive en memoria: al recargar la página se pierde (los `File` del
  navegador no se pueden persistir sin volver a pedir permiso).
- PreTracker no tiene seek nativo: el core reinicia el player y descarta frames
  hasta la posición pedida. Funciona, pero un seek lejano tarda.
- El cambio de subsong está implementado y probado con módulos de un solo
  subsong; falta un `.prt` multi-subsong para validar el salto real.
- El `AudioContext` se intenta crear con la frecuencia del archivo. Si el
  navegador impone otra, el `AudioWorklet` hace **resampling lineal** en tiempo
  real (se muestra `resampling X → Y Hz`).
- Sin metadatos (título/artista) ni carátulas; se usa el nombre del archivo.
- Sin playlist, biblioteca, búsqueda, base de datos ni ajustes persistentes.
- Sin hilos ni `SharedArrayBuffer`; toda la decodificación ocurre en el
  `AudioWorklet`.

## Siguiente paso lógico

1. Envolver el `ReplayPlugin` existente en una ABI C estable (opaque handle) y
   compilar otro motor piloto (p. ej. OpenMPT o VGMStream) a wasm.
2. Añadir resampling lineal en el `AudioWorklet` para aceptar cualquier
   frecuencia de contexto.
3. Añadir metadatos (ID3/FLAC tags) y playlist en la UI.
4. Cargar motores bajo demanda (módulos separados) para no meter los 62 en un
   único `.wasm`.
