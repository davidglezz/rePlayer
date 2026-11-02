# rePlayer wasm core (opción B)

Prototipo de la ruta **B**: un núcleo de reproducción *headless* compilado a
WebAssembly con una ABI C, más una interfaz web que lo controla. No incluye la
app Win32, DirectX, ImGui, las DLLs de los 62 motores ni la base de datos.

## Qué hay

```
wasm/
  core/core.cpp     # decodificadores WAV/FLAC/MP3 + ABI C
  build.ps1         # compila core.wasm con zig (clang + wasm-ld)
  web/index.html    # UI
  web/app.js        # carga de archivos, AudioContext, controles
  web/processor.js  # AudioWorklet: renderiza PCM desde el wasm
  web/core.wasm     # artefacto compilado (141 KB, sin imports)
  server.mjs        # servidor estático local
```

## Formatos y ABI

- **WAV** (`dr_wav`), **FLAC** (`dr_flac`), **MP3** (`dr_mp3`), todos desde
  memoria, sin sistema de ficheros.
- ABI C mínima: `rp_create`, `rp_load`, `rp_sample_rate`, `rp_channels`,
  `rp_frames`, `rp_position`, `rp_format`, `rp_seek`, `rp_render`,
  `rp_destroy`, y `malloc`/`free` para pasar los bytes del archivo.
- El módulo **no tiene imports** (`wasm32-wasi` en modo reactor): no usa WASI,
  hilos ni el filesystem. `WebAssembly.Module` se envía al `AudioWorklet`, que
  instancia el core en el hilo de audio y va pidiendo bloques con `rp_render`.

## Compilar

Necesitas [Zig](https://ziglang.org/download/) (probado con 0.17.0; incluye
clang y wasm-ld, no hace falta Emscripten ni Python):

```powershell
.\wasm\build.ps1 -Zig C:\ruta\a\zig.exe
```

Si `zig` está en el `PATH`, basta con `.\wasm\build.ps1`.

Test rápido del core (genera un WAV en memoria, sin navegador):

```powershell
node .\wasm\test-core.cjs
```

## Ejecutar

```powershell
node .\wasm\server.mjs
```

Abre **http://127.0.0.1:8787/**, arrastra un WAV/FLAC/MP3 y dale a play.
`127.0.0.1` es contexto seguro, así que `AudioWorklet` funciona sin HTTPS.

## Limitaciones de este prototipo

- Solo 3 motores (WAV/FLAC/MP3). El resto de los 62 necesitaría una ABI C por
  motor o un proxy que envuelva el `ReplayPlugin` actual.
- Sin resampling: el `AudioContext` se crea con la frecuencia del archivo. Si el
  navegador la rechaza, se avisa y el tono/velocidad puede cambiar.
- Sin metadatos (título/artista) ni carátulas; se usa el nombre del archivo.
- Sin playlist, biblioteca, búsqueda, base de datos ni ajustes persistentes.
- Sin hilos ni `SharedArrayBuffer`; toda la decodificación ocurre en el
  `AudioWorklet`.

## Siguiente paso lógico

1. Envolver el `ReplayPlugin` existente en una ABI C estable (opaque handle) y
   compilar un motor piloto más complejo (p. ej. OpenMPT o VGMStream) a wasm.
2. Añadir resampling lineal en el `AudioWorklet` para aceptar cualquier
   frecuencia de contexto.
3. Añadir metadatos (ID3/FLAC tags) y playlist en la UI.
4. Cargar motores bajo demanda (módulos separados) para no meter los 62 en un
   único `.wasm`.
