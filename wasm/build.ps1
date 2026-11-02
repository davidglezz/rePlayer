param(
    [string]$Zig = $env:ZIG,
    [string]$Out = (Join-Path $PSScriptRoot 'web\core.wasm')
)

$ErrorActionPreference = 'Stop'

if (-not $Zig) {
    $cmd = Get-Command zig -ErrorAction SilentlyContinue
    if ($cmd) { $Zig = $cmd.Source } else { $Zig = 'zig' }
}

if (-not (Get-Command $Zig -ErrorAction SilentlyContinue) -and -not (Test-Path $Zig)) {
    throw "No se encontró zig. Descarga https://ziglang.org/download/ y pasa -Zig <ruta a zig.exe> (o define ZIG)."
}

$src = Join-Path $PSScriptRoot 'core\core.cpp'
$inc = Join-Path $PSScriptRoot '..\source\3rdParty\dr_libs'
$preTracker = Join-Path $PSScriptRoot '..\source\Replays\PreTracker\pretracker'
$outDir = Split-Path -Parent $Out
New-Item -ItemType Directory -Force $outDir | Out-Null

$sources = @(
    $src,
    (Join-Path $preTracker 'pretracker.c'),
    (Join-Path $preTracker 'pretracker_parse.c'),
    (Join-Path $preTracker 'pretracker_sequencer.c'),
    (Join-Path $preTracker 'pretracker_mixer.c'),
    (Join-Path $preTracker 'pretracker_tables.c'),
    (Join-Path $preTracker 'pretracker_wavegen.c')
)

$exports = @(
    'rp_create', 'rp_destroy', 'rp_load',
    'rp_sample_rate', 'rp_channels', 'rp_frames', 'rp_position', 'rp_is_loaded', 'rp_format',
    'rp_seek', 'rp_render',
    'malloc', 'free'
)

$arguments = @(
    'c++',
    '-target', 'wasm32-wasi',
    '-O3',
    '-DNDEBUG',
    '-fno-exceptions',
    '-fno-rtti',
    '-mexec-model=reactor',
    "-I$inc",
    '-Wl,--strip-all',
    '-Wl,-z,stack-size=1048576',
    '-Wl,--initial-memory=4194304',
    '-Wl,--max-memory=1073741824'
)
foreach ($e in $exports) { $arguments += "-Wl,--export=$e" }
$arguments += @('-o', $Out) + $sources + @('-lm')

Write-Host "zig  : $Zig"
Write-Host "src  : $src"
Write-Host "out  : $Out"
& $Zig @arguments
if ($LASTEXITCODE -ne 0) { throw "La compilación falló con código $LASTEXITCODE" }

$size = (Get-Item $Out).Length
Write-Host ("OK -> {0} ({1:N1} KB)" -f $Out, ($size / 1KB)) -ForegroundColor Green

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $js = "const fs=require('fs');const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));console.log('imports:',JSON.stringify(WebAssembly.Module.imports(m)));console.log('exports:',WebAssembly.Module.exports(m).map(e=>e.name).join(', '));"
    & $node.Source -e $js $Out
}
