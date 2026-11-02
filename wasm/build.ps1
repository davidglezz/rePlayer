param(
    [string]$Zig = $env:ZIG,
    [string]$OutDir = (Join-Path $PSScriptRoot 'web'),
    [string[]]$Only = @()
)

$ErrorActionPreference = 'Stop'

if (-not $Zig) {
    $cmd = Get-Command zig -ErrorAction SilentlyContinue
    if ($cmd) { $Zig = $cmd.Source } else { $Zig = 'zig' }
}

if (-not (Get-Command $Zig -ErrorAction SilentlyContinue) -and -not (Test-Path $Zig)) {
    throw "No se encontró zig. Descarga https://ziglang.org/download/ y pasa -Zig <ruta a zig.exe> (o define ZIG)."
}

$core = Join-Path $PSScriptRoot 'core\core.cpp'
$inc = Join-Path $PSScriptRoot '..\source\3rdParty\dr_libs'
$preTracker = Join-Path $PSScriptRoot '..\source\Replays\PreTracker\pretracker'
$hively = Join-Path $PSScriptRoot '..\source\Replays\Hively\hvl'
$xmp = Join-Path $PSScriptRoot '..\source\Replays\XMP\libxmp'
$v2 = Join-Path $PSScriptRoot '..\source\Replays\V2\v2redux'
$gme = Join-Path $PSScriptRoot '..\source\Replays\GME\gme'
$compat = Join-Path $PSScriptRoot 'core\hively_compat.h'
$stub = Join-Path $PSScriptRoot 'core\hively_stub.c'
$wasmStubs = Join-Path $PSScriptRoot 'core\wasm_stubs.c'
New-Item -ItemType Directory -Force $OutDir | Out-Null

$exports = @(
    'rp_create', 'rp_destroy', 'rp_load',
    'rp_sample_rate', 'rp_channels', 'rp_frames', 'rp_position', 'rp_is_loaded', 'rp_format',
    'rp_title', 'rp_artist',
    'rp_subsong_count', 'rp_subsong', 'rp_set_subsong',
    'rp_seek', 'rp_render',
    'malloc', 'free'
)
$exportArgs = $exports | ForEach-Object { "-Wl,--export=$_" }

$preTrackerSources = @(
    (Join-Path $preTracker 'pretracker.c'),
    (Join-Path $preTracker 'pretracker_parse.c'),
    (Join-Path $preTracker 'pretracker_sequencer.c'),
    (Join-Path $preTracker 'pretracker_mixer.c'),
    (Join-Path $preTracker 'pretracker_tables.c'),
    (Join-Path $preTracker 'pretracker_wavegen.c')
)

$hivelySources = @(
    (Join-Path $hively 'hvl_replay.c'),
    (Join-Path $hively 'hvl_tables.c'),
    $stub
)

$xmpSources = @(
    (Get-ChildItem (Join-Path $xmp 'src') -Filter '*.c' | ForEach-Object FullName)
    (Get-ChildItem (Join-Path $xmp 'src\loaders') -Filter '*.c' | ForEach-Object FullName)
)

$v2Sources = @(
    (Join-Path $v2 'v2core.cpp'),
    (Join-Path $v2 'v2load.cpp'),
    (Join-Path $v2 'v2seq.cpp'),
    (Join-Path $v2 'v2player.cpp'),
    (Join-Path $v2 'ronan.cpp')
)

$gmeSources = @(
    (Get-ChildItem (Join-Path $gme 'gme') -Filter '*.cpp' | ForEach-Object FullName)
    (Join-Path $gme 'gme\ext\emu2413.c')
)

$libcMacros = @(
    '-Dgetenv=wasm_getenv',
    '-Dprintf=wasm_printf',
    '-Dfprintf=wasm_fprintf',
    '-Dputs=wasm_puts',
    '-Dfputs=wasm_fputs',
    '-Dfwrite=wasm_fwrite'
)
$xmpMacros = $libcMacros + @('-Dtime=wasm_time')

$common = @(
    'c++',
    '-target', 'wasm32-wasi',
    '-O3',
    '-DNDEBUG',
    '-fno-exceptions',
    '-fno-rtti',
    '-mexec-model=reactor',
    '-ffunction-sections',
    "-I$inc",
    "-I$xmp\include",
    "-I$xmp\src",
    "-I$v2",
    "-I$gme",
    "-I$gme\gme",
    '-Wno-incompatible-pointer-types',
    '-Wl,--gc-sections',
    '-Wl,--strip-all',
    '-Wl,-z,stack-size=1048576',
    '-Wl,--initial-memory=4194304',
    '-Wl,--max-memory=1073741824'
)

$engines = @(
    @{ Name = 'wav'; Defines = @('-DRP_ENGINE_WAV=1'); Sources = @(); Hively = $false },
    @{ Name = 'flac'; Defines = @('-DRP_ENGINE_FLAC=1'); Sources = @(); Hively = $false },
    @{ Name = 'mp3'; Defines = @('-DRP_ENGINE_MP3=1'); Sources = @(); Hively = $false },
    @{ Name = 'pretracker'; Defines = @('-DRP_ENGINE_PRETRACKER=1'); Sources = $preTrackerSources; Hively = $false },
    @{ Name = 'hively'; Defines = @('-DRP_ENGINE_HIVELY=1'); Sources = $hivelySources; Hively = $true },
    @{ Name = 'xmp'; Defines = @('-DRP_ENGINE_XMP=1', '-DLIBXMP_NO_DEPACKERS', '-DLIBXMP_NO_PROWIZARD') + $xmpMacros; Sources = $xmpSources + @($wasmStubs, $stub); Hively = $false },
    @{ Name = 'v2'; Defines = @('-DRP_ENGINE_V2=1', '-DV2_RONAN=1') + $libcMacros; Sources = $v2Sources + @($wasmStubs, $stub); Hively = $false },
    @{ Name = 'gme'; Defines = @('-DRP_ENGINE_GME=1', '-DBLARGG_LITTLE_ENDIAN=1', '-DVGM_YM2612_NUKED') + $libcMacros; Sources = $gmeSources + @($wasmStubs, $stub); Hively = $false },
    @{ Name = 'all'; Defines = @('-DRP_ENGINE_ALL=1', '-DLIBXMP_NO_DEPACKERS', '-DLIBXMP_NO_PROWIZARD', '-DV2_RONAN=1', '-DBLARGG_LITTLE_ENDIAN=1', '-DVGM_YM2612_NUKED') + $xmpMacros; Sources = $preTrackerSources + $hivelySources + $xmpSources + $v2Sources + $gmeSources + @($wasmStubs); Hively = $true }
)

Write-Host "zig  : $Zig"
Write-Host "core : $core"

foreach ($engine in $engines) {
    if ($Only.Count -gt 0 -and $Only -notcontains $engine.Name)
    {
        continue
    }

    $out = if ($engine.Name -eq 'all') { Join-Path $OutDir 'core.wasm' } else { Join-Path $OutDir "engines\$($engine.Name).wasm" }
    New-Item -ItemType Directory -Force (Split-Path -Parent $out) | Out-Null

    $arguments = $common + $exportArgs + $engine.Defines
    if ($engine.Hively)
    {
        $arguments += @('-Dprintf=wasm_printf', '-include', $compat)
    }
    $arguments += @('-o', $out, $core) + $engine.Sources + @('-lm')

    Write-Host ("== {0} ==" -f $engine.Name)
    & $Zig @arguments
    if ($LASTEXITCODE -ne 0)
    {
        throw "La compilación de $($engine.Name) falló con código $LASTEXITCODE"
    }

    $size = (Get-Item $out).Length
    Write-Host ("OK -> {0} ({1:N1} KB)" -f $out, ($size / 1KB)) -ForegroundColor Green
}
