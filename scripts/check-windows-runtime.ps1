param([Parameter(Mandatory = $true)][string]$Binary)

$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $Binary -PathType Leaf)) {
    throw "Windows application binary is missing: $Binary"
}

# Check the actual executable, not the NSIS bootstrapper. Build machines already
# have VC++ installed, so simply launching here cannot detect this regression.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'MSVC installation was not found' }
$toolset = Get-ChildItem -LiteralPath (Join-Path $installation 'VC/Tools/MSVC') -Directory |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$dumpbin = Join-Path $toolset.FullName 'bin/Hostx64/x64/dumpbin.exe'
if (!(Test-Path -LiteralPath $dumpbin)) { throw 'dumpbin.exe was not found' }

$files = @((Get-Item -LiteralPath $Binary))
# Include app-local native DLLs if a future build introduces any.
$files += @(Get-ChildItem -LiteralPath (Split-Path -Parent $Binary) -Filter '*.dll' -File)
foreach ($file in $files) {
    $output = & $dumpbin /DEPENDENTS $file.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect imports: $($file.Name)`n$output" }
    $imports = @($output | ForEach-Object {
        if ($_ -match '^\s*([a-zA-Z0-9_.-]+\.dll)\s*$') { $Matches[1] }
    })
    if ($imports.Count -eq 0) { throw "No DLL imports parsed for $($file.Name)" }
    # msvcrt.dll is a Windows component; numbered MSVC runtimes are not.
    $externalRuntime = @($imports | Where-Object {
        $_ -match '^(msvcp\d|msvcr\d|vcruntime\d|concrt\d|vcomp\d)'
    })
    if ($externalRuntime.Count -gt 0) {
        throw "$($file.Name) requires separately installed VC++ runtime: $($externalRuntime -join ', ')"
    }
    Write-Output "$($file.Name): no external VC++ runtime imports"
}
