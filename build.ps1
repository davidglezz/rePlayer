<#
.SYNOPSIS
    Compila rePlayer en local con MSBuild.

.DESCRIPTION
    La solución tiene dos particularidades:
      * Los proyectos "Bridge" (MVX y SkaleTracker) son solo Win32 y enlazan
        contra .output\Win32_Release\Core.lib. Por eso, al compilar x64 hay que
        compilar antes Core para Win32.
      * El toolset v143 por defecto puede no tener ATL instalado (atlcore.h).
        v145 si lo trae en Visual Studio 2026. Cambia -Toolset si tu instalación
        tiene ATL para v143.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Configuration Debug -Platform x64
    .\build.ps1 -Clean
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [ValidateSet('x64', 'Win32')]
    [string]$Platform = 'x64',

    [string]$Toolset = 'v145',

    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$solution = Join-Path $root 'source\rePlayer.sln'

function Find-MSBuild {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $path = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\amd64\MSBuild.exe' | Select-Object -First 1
        if ($path) { return $path }
    }
    $candidate = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio\*\*\MSBuild\Current\Bin\amd64\MSBuild.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    throw 'No se ha encontrado MSBuild. Instala Visual Studio con las herramientas de C++.'
}

$msbuild = Find-MSBuild
Write-Host "MSBuild : $msbuild"
Write-Host "Config  : $Configuration|$Platform (toolset $Toolset)"

$common = @(
    $solution,
    '/m',
    '/nologo',
    '/v:minimal',
    "/p:Configuration=$Configuration",
    "/p:Platform=$Platform",
    "/p:PlatformToolset=$Toolset"
)

if ($Clean) {
    Write-Host 'Limpiando...'
    & $msbuild @common /t:Clean
    if ($LASTEXITCODE -ne 0) { throw "Clean falló con código $LASTEXITCODE" }
}

# Los bridges Win32 enlazan contra .output\Win32_Release\Core.lib.
if ($Platform -eq 'x64') {
    Write-Host 'Compilando Core para Win32 (dependencia de los bridges)...'
    & $msbuild (Join-Path $root 'source\Core\Core.vcxproj') /t:Build /m /nologo /v:minimal `
        "/p:Configuration=$Configuration" '/p:Platform=Win32' "/p:PlatformToolset=$Toolset" `
        "/p:SolutionDir=$root\source\"
    if ($LASTEXITCODE -ne 0) { throw "Core Win32 falló con código $LASTEXITCODE" }
}

Write-Host 'Compilando la solución...'
& $msbuild @common /t:Build
if ($LASTEXITCODE -ne 0) { throw "La compilación falló con código $LASTEXITCODE" }

$exe = Join-Path $root ".output\${Platform}_${Configuration}\rePlayer.exe"
if (Test-Path $exe) {
    Write-Host ''
    Write-Host "OK -> $exe" -ForegroundColor Green
} else {
    throw "La compilación terminó pero no se encontró $exe"
}
