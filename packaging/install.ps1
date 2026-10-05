#Requires -Version 5.1
#
# Installs, upgrades or removes Urutau on Windows 10 or 11 for the current user
# (Windows PowerShell 5.1 and later). No administrator rights are needed to run it.
#
# Two ways to run it:
#   irm https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.ps1 | iex
#     Options are passed as URUTAU_* environment variables, because a param() block
#     cannot bind arguments when its text is fed to iex. For example:
#       $env:URUTAU_PUBLIC_URL = 'http://192.168.1.20:8787'; irm <url> | iex
#   Saved to a file and run with parameters:
#       .\install.ps1 -PublicUrl http://192.168.1.20:8787
#
# Every option has a parameter and a URUTAU_* variable (see -Help). A parameter wins over
# its variable. A private Node 24 and the app live under the install directory, and the
# server runs as the current user from a Scheduled Task that starts at logon (a hidden
# supervisor restarts it if it exits). Running the script again upgrades; -Uninstall
# removes the service and the app and keeps the configuration and the data.
#
# This file is ASCII only: Windows PowerShell 5.1 reads a file with no byte order mark in
# the ANSI code page. It never calls exit at the top level (under iex that would close the
# user's window); a failure throws the error text. It never prints urutau.env or
# TOKEN_ENCRYPTION_KEY.

param(
    [string] $Version = $env:URUTAU_VERSION,
    [string] $Bundle = $env:URUTAU_BUNDLE,
    [string] $InstallDir = $env:URUTAU_INSTALL_DIR,
    [string] $Port = $env:URUTAU_PORT,
    [string] $PublicUrl = $env:URUTAU_PUBLIC_URL,
    [switch] $Local = ($env:URUTAU_LOCAL -eq '1'),
    [string] $BindHost = $env:URUTAU_BIND_HOST,
    [string] $AllowedHosts = $env:URUTAU_ALLOWED_HOSTS,
    [switch] $NoService = ($env:URUTAU_NO_SERVICE -eq '1'),
    [switch] $Force = ($env:URUTAU_FORCE -eq '1'),
    [switch] $Uninstall = ($env:URUTAU_UNINSTALL -eq '1'),
    [switch] $Purge = ($env:URUTAU_PURGE -eq '1'),
    [switch] $Yes = ($env:URUTAU_YES -eq '1'),
    [switch] $NoElevate = ($env:URUTAU_NO_ELEVATE -eq '1'),
    [switch] $Help
)

# Which parameters were given on the command line (empty under iex). An explicitly empty
# -InstallDir must be refused, not replaced by the default root.
$UrutauBound = $PSBoundParameters

function Install-Urutau {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $ReleaseBaseUrl = if ($env:URUTAU_RELEASE_BASE_URL) { $env:URUTAU_RELEASE_BASE_URL } else { 'https://github.com/oshogun/urutau/releases/download' }
    $ApiUrl = if ($env:URUTAU_API_URL) { $env:URUTAU_API_URL } else { 'https://api.github.com/repos/oshogun/urutau/releases/latest' }
    $NodeDistUrl = if ($env:URUTAU_NODE_DIST_URL) { $env:URUTAU_NODE_DIST_URL } else { 'https://nodejs.org/dist' }
    $LatestReleasePage = 'https://github.com/oshogun/urutau/releases/latest'
    $UninstallUrl = 'https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.ps1'
    $DefaultPort = 8787
    # Releases published before the installers existed: they have no bundle.
    $NoBundleVersions = @('0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0')
    # The server's variables, from README "Environment variables", plus NODE_OPTIONS. They are
    # removed from every process this script starts (the file's values would lose to them).
    $ServerEnvKeys = @(
        'HOST', 'PORT', 'DATABASE_URL', 'PUBLIC_URL', 'ALLOWED_HOSTS', 'TRUST_PROXY', 'TOKEN_ENCRYPTION_KEY',
        'KEYCLOAK_ISSUER', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET', 'KEYCLOAK_GITHUB_IDP',
        'KEYCLOAK_BROKER_API', 'KEYCLOAK_ALLOW_HTTP', 'NODE_OPTIONS'
    )
    $VersionRe = '^[0-9]+\.[0-9]+\.[0-9]+(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
    $Utf8 = New-Object Text.UTF8Encoding($false)
    $FirewallRuleName = 'UrutauServer-In'

    # Mutable state shared by the functions below. A nested function that assigns to a plain
    # variable of the enclosing function makes a local copy, so shared values live here.
    $S = @{
        Root = ''; Staging = ''; Arch = 'x64'; LockHeld = $false; TrialProc = $null
        M = @{ Have = $false; Version = ''; Node = ''; Autostart = 'none'; Firewall = '0'; State = ''; InstalledAt = '' }
        Autostart = 'none'; NodeDir = ''; NodeReplaced = $false; NodeVersion = ''
        ConfigChanged = $false; ReplaceApp = $true; Version = ''; NewVersion = ''
        WantHost = ''; WantPublicUrl = ''; RemovePublicUrl = $false
        Probe = ''; DbBackupDir = ''; DbPath = ''
        AppSwapped = $false; NodeSwapped = $false; ConfigSwapped = $false
        BundlePath = ''; DlCode = 0
    }

    # ---- output ------------------------------------------------------------------------------------

    function Write-Info([string] $Message) { Write-Host "urutau-install: $Message" }
    function Write-Warn([string] $Message) { Write-Host "warning: $Message" }
    # Prints text exactly as given (the messages the installers print), without the prefix.
    function Say([string] $Text) { Write-Host $Text }
    function Fail([string] $Message) { throw "error: $Message" }

    function Show-Usage {
        Write-Host @'
Usage: install.ps1 [options]

  -Version X.Y.Z          install this release instead of the latest (a leading v is accepted)
  -Bundle PATH_OR_URL     install from this bundle; no release lookup
  -InstallDir DIR         install root (default: %LOCALAPPDATA%\Urutau)
  -Port N                 PORT, 1024-65535 (default 8787, or the existing value)
  -PublicUrl URL          open Urutau to other computers at this address: sets PUBLIC_URL
                          and HOST=0.0.0.0 (unless -BindHost is given); skips the question
  -Local                  this computer only: HOST=127.0.0.1, no PUBLIC_URL and no firewall rule;
                          skips the question
  -BindHost ADDR          HOST itself, for one interface or a proxy on this machine
  -AllowedHosts a,b       ALLOWED_HOSTS
  -NoService              register no service; check the install with a trial start
  -Force                  replace the app even when that version is installed
  -Uninstall              remove the service and the app; keep the configuration and the data
  -Purge                  with -Uninstall: delete the whole install directory
  -Yes                    ask nothing: the address defaults to this computer only,
                          and purge needs no typed confirmation
  -NoElevate              never show a UAC prompt (no firewall rule; the Startup folder may
                          be used instead of the Scheduled Task)
  -Help                   print this text and exit

Each option has an environment variable, the only way to pass one through irm | iex:
URUTAU_VERSION, URUTAU_BUNDLE, URUTAU_INSTALL_DIR, URUTAU_PORT, URUTAU_PUBLIC_URL,
URUTAU_LOCAL=1, URUTAU_BIND_HOST, URUTAU_ALLOWED_HOSTS, URUTAU_NO_SERVICE=1, URUTAU_FORCE=1,
URUTAU_UNINSTALL=1, URUTAU_PURGE=1, URUTAU_YES=1, URUTAU_NO_ELEVATE=1.
A parameter wins over its variable.
'@
    }

    # ---- small utilities ---------------------------------------------------------------------------

    function Get-NowUtc {
        return (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd\THH:mm:ss\Z', [Globalization.CultureInfo]::InvariantCulture)
    }

    function Write-Utf8File([string] $Path, [string] $Content) {
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $tmp = "$Path.$PID.tmp"
        [IO.File]::WriteAllText($tmp, $Content, $Utf8)
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    }

    function Read-Utf8File([string] $Path) {
        return [IO.File]::ReadAllText($Path, $Utf8)
    }

    # Removes a file or directory, trying again when Windows (or a virus scanner) still holds
    # a handle on something inside it.
    function Remove-Tree([string] $Path) {
        $attempt = 0
        while (Test-Path -LiteralPath $Path) {
            $attempt++
            try {
                Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            } catch {
                if ($attempt -ge 5) { throw }
                Start-Sleep -Seconds 1
            }
        }
    }

    function Move-Path([string] $From, [string] $To) {
        $attempt = 0
        while ($true) {
            $attempt++
            try {
                Move-Item -LiteralPath $From -Destination $To -Force -ErrorAction Stop
                return
            } catch {
                if ($attempt -ge 3) { throw }
                Start-Sleep -Seconds 1
            }
        }
    }

    # PowerShell single-quoted strings escape an embedded quote by doubling it; every path
    # put into a single-quoted segment of a command run by an elevated process goes through
    # this first, or a path like "O'Brien" breaks the command.
    function Format-PSSingleQuoted([string] $Value) {
        return $Value -replace "'", "''"
    }

    # Builds one process argument string the way the Win32 C runtime (and so node.exe) parses
    # it back apart: wrap in double quotes only when needed, double any run of backslashes
    # that is followed by a quote (or ends the argument once quoted), escape embedded quotes.
    function Format-ProcessArgument([string] $Value) {
        if ($null -eq $Value) { $Value = '' }
        if ($Value.Length -eq 0) { return '""' }
        if ($Value -notmatch '[\s"]') { return $Value }
        $sb = New-Object Text.StringBuilder
        [void] $sb.Append('"')
        $backslashes = 0
        foreach ($ch in $Value.ToCharArray()) {
            if ($ch -eq '\') {
                $backslashes++
                continue
            }
            if ($ch -eq '"') {
                [void] $sb.Append([char] '\', ($backslashes * 2 + 1))
                [void] $sb.Append('"')
                $backslashes = 0
                continue
            }
            if ($backslashes -gt 0) {
                [void] $sb.Append([char] '\', $backslashes)
                $backslashes = 0
            }
            [void] $sb.Append($ch)
        }
        if ($backslashes -gt 0) { [void] $sb.Append([char] '\', ($backslashes * 2)) }
        [void] $sb.Append('"')
        return $sb.ToString()
    }

    # Runs a program with the server's variables removed from its environment, its stdin
    # closed, and stdout and stderr captured as text. It does not go through & or 2>&1:
    # under Windows PowerShell 5.1 a native command's stderr becomes an ErrorRecord whose
    # formatted text, not the program's own, ends up in the captured output.
    function Invoke-Native([string] $File, [string[]] $ArgList, [string] $WorkDir, [hashtable] $ExtraEnv) {
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $File
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $Utf8
        $psi.StandardErrorEncoding = $Utf8
        if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
        $psi.Arguments = (@($ArgList | ForEach-Object { Format-ProcessArgument $_ }) -join ' ')
        foreach ($key in $ServerEnvKeys) { $psi.EnvironmentVariables.Remove($key) }
        if ($ExtraEnv) {
            foreach ($key in $ExtraEnv.Keys) { $psi.EnvironmentVariables[$key] = [string] $ExtraEnv[$key] }
        }
        $proc = New-Object Diagnostics.Process
        $proc.StartInfo = $psi
        try {
            [void] $proc.Start()
            $proc.StandardInput.Close()
            # Both streams are read asynchronously so a full stderr buffer cannot block
            # against a full stdout buffer.
            $outTask = $proc.StandardOutput.ReadToEndAsync()
            $errTask = $proc.StandardError.ReadToEndAsync()
            $proc.WaitForExit()
            $outText = $outTask.GetAwaiter().GetResult()
            $errText = $errTask.GetAwaiter().GetResult()
            $code = $proc.ExitCode
        } finally {
            $proc.Dispose()
        }
        return [pscustomobject]@{ ExitCode = $code; Out = [string] $outText; Err = [string] $errText }
    }

    # Runs a scriptblock with every server variable removed from this process's environment,
    # then puts back what was there. Used for Start-Process, which cannot edit the child's
    # environment itself.
    function Invoke-WithoutServerEnv([scriptblock] $Body) {
        $saved = @{}
        foreach ($key in $ServerEnvKeys) {
            $saved[$key] = [Environment]::GetEnvironmentVariable($key)
            if ($null -ne $saved[$key]) { [Environment]::SetEnvironmentVariable($key, $null) }
        }
        try {
            & $Body
        } finally {
            foreach ($key in $ServerEnvKeys) {
                if ($null -ne $saved[$key]) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
            }
        }
    }

    # True when the run may ask a question: the session is interactive, stdin is the console,
    # and the host was not started with -NonInteractive.
    function Test-Interactive {
        try {
            if (-not [Environment]::UserInteractive) { return $false }
            if ([Console]::IsInputRedirected) { return $false }
            foreach ($arg in [Environment]::GetCommandLineArgs()) {
                if ($arg -match '^-noni') { return $false }
            }
            return $true
        } catch {
            return $false
        }
    }

    function Test-HostLoopback([string] $HostName) {
        if (-not $HostName) { return $true }
        $lower = $HostName.ToLowerInvariant()
        return ($lower -like '127.*') -or ($lower -eq 'localhost') -or ($lower -eq '::1') -or ($lower -eq '[::1]')
    }

    function Get-Sha256([string] $Path) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    # ---- configuration file helpers (merge rules: one line per key, other lines untouched) ----------

    # Reads a configuration file as a list of lines (a trailing newline adds no empty line).
    function Read-EnvLines([string] $Path) {
        $list = New-Object System.Collections.Generic.List[string]
        if (Test-Path -LiteralPath $Path) {
            $text = Read-Utf8File $Path
            if ($text.Length -gt 0) {
                foreach ($part in ($text -split "`n")) { $list.Add($part) }
                if ($list[$list.Count - 1] -eq '') { $list.RemoveAt($list.Count - 1) }
            }
        }
        return , $list
    }

    function Write-EnvLines([string] $Path, $Lines) {
        $text = ''
        if ($Lines.Count -gt 0) { $text = ($Lines -join "`n") + "`n" }
        [IO.File]::WriteAllText($Path, $text, $Utf8)
    }

    function Get-EnvPattern([string] $Key) {
        return '^[ \t]*' + [regex]::Escape($Key) + '[ \t]*='
    }

    # The value of KEY in a configuration file: the last line that defines it, trimmed.
    function Get-EnvValue([string] $Path, [string] $Key) {
        $lines = Read-EnvLines $Path
        $pattern = Get-EnvPattern $Key
        $value = ''
        foreach ($line in $lines) {
            if ($line -cmatch $pattern) { $value = $line.Substring($line.IndexOf('=') + 1).Trim() }
        }
        return $value
    }

    # Sets KEY to VALUE: replaces the last line that defines KEY and deletes the earlier
    # ones, or appends the line. No other line changes.
    function Set-EnvValue($Lines, [string] $Key, [string] $Value) {
        $pattern = Get-EnvPattern $Key
        $found = @()
        for ($i = 0; $i -lt $Lines.Count; $i++) {
            if ($Lines[$i] -cmatch $pattern) { $found += $i }
        }
        if ($found.Count -eq 0) {
            $Lines.Add("$Key=$Value")
            return
        }
        $Lines[$found[$found.Count - 1]] = "$Key=$Value"
        for ($j = $found.Count - 2; $j -ge 0; $j--) { $Lines.RemoveAt($found[$j]) }
    }

    # Deletes every line that defines KEY.
    function Remove-EnvValue($Lines, [string] $Key) {
        $pattern = Get-EnvPattern $Key
        for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
            if ($Lines[$i] -cmatch $pattern) { $Lines.RemoveAt($i) }
        }
    }

    # A value written to the configuration: no space, #, quote, backtick, CR or LF : the server reads the file without quotes and ends a value at #.
    function Assert-PlainValue([string] $What, [string] $Value) {
        if ($Value -match '[\s#"''`]') { Fail "$What must not contain spaces, # or quotes: $Value" }
    }

    # ---- the address question ----------------------------------------------------------------------

    function Get-ReasonText([int] $Reason, [int] $PortNumber) {
        switch ($Reason) {
            1 { return 'it must start with http:// or https://' }
            2 { return 'it must not contain spaces, a user name (@), a query (?) or a fragment (#)' }
            3 { return 'it has no host name' }
            4 { return "an IPv6 address must be in brackets, for example http://[fe80::1]:$PortNumber" }
            5 { return 'its port must be a number from 1 to 65535' }
        }
        return ''
    }

    # Mode 'ask' is a typed answer (steps 1 to 11). Mode 'flag' is a -PublicUrl value (steps 1
    # and 4 to 8: no scheme added, no loopback conversion). Returns Kind (local, url or
    # reject), Url and Reason (1 to 5).
    function ConvertFrom-Address([string] $Text, [int] $PortNumber, [string] $Mode) {
        $a = $Text.Trim()
        $schemeAdded = $false
        if ($a.Length -eq 0) {
            if ($Mode -eq 'ask') { return @{ Kind = 'local'; Url = ''; Reason = 0 } }
            return @{ Kind = 'reject'; Url = ''; Reason = 1 }
        }
        if (($Mode -eq 'ask') -and ($a.IndexOf('://', [StringComparison]::Ordinal) -lt 0)) {
            $a = "http://$a"
            $schemeAdded = $true
        }
        if (-not ($a.StartsWith('http://', [StringComparison]::Ordinal) -or $a.StartsWith('https://', [StringComparison]::Ordinal))) {
            return @{ Kind = 'reject'; Url = ''; Reason = 1 }
        }
        if ($a -match '[\s@?#]') { return @{ Kind = 'reject'; Url = ''; Reason = 2 } }
        $sep = $a.IndexOf('://', [StringComparison]::Ordinal)
        $scheme = $a.Substring(0, $sep)
        $rest = $a.Substring($sep + 3)
        $slash = $rest.IndexOf('/')
        if ($slash -ge 0) {
            $authority = $rest.Substring(0, $slash)
            $path = $rest.Substring($slash)
        } else {
            $authority = $rest
            $path = ''
        }
        $hostPart = ''
        $portText = ''
        $havePort = $false
        if ($authority.StartsWith('[')) {
            $close = $authority.IndexOf(']')
            if ($close -lt 0) { return @{ Kind = 'reject'; Url = ''; Reason = 3 } }
            $hostPart = $authority.Substring(0, $close + 1)
            $after = $authority.Substring($close + 1)
            if ($after.Length -eq 0) {
                # no port
            } elseif ($after.StartsWith(':')) {
                $portText = $after.Substring(1)
                $havePort = $true
            } else {
                return @{ Kind = 'reject'; Url = ''; Reason = 3 }
            }
        } else {
            $colons = @($authority.ToCharArray() | Where-Object { $_ -eq ':' }).Count
            if ($colons -gt 1) { return @{ Kind = 'reject'; Url = ''; Reason = 4 } }
            $colon = $authority.IndexOf(':')
            if ($colon -ge 0) {
                $hostPart = $authority.Substring(0, $colon)
                $portText = $authority.Substring($colon + 1)
                $havePort = $true
            } else {
                $hostPart = $authority
            }
        }
        if (($hostPart.Length -eq 0) -or ($hostPart -eq '[]')) { return @{ Kind = 'reject'; Url = ''; Reason = 3 } }
        if ($havePort) {
            if (($portText -cnotmatch '^[0-9]+$') -or ($portText.Length -gt 5) -or ([int] $portText -lt 1) -or ([int] $portText -gt 65535)) {
                return @{ Kind = 'reject'; Url = ''; Reason = 5 }
            }
        }
        $path = $path.TrimEnd('/')
        if ($schemeAdded -and (-not $havePort)) { $authority = "${authority}:$PortNumber" }
        if ($Mode -eq 'ask') {
            $lower = $hostPart.ToLowerInvariant()
            if (($lower -eq 'localhost') -or ($lower -like '127.*') -or ($lower -eq '[::1]')) {
                return @{ Kind = 'local'; Url = ''; Reason = 0 }
            }
        }
        return @{ Kind = 'url'; Url = "${scheme}://${authority}${path}"; Reason = 0 }
    }

    function Get-FirstIPv4 {
        try {
            $found = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
                Where-Object { ($_.IPAddress -notlike '127.*') -and ($_.PrefixOrigin -ne 'WellKnown') } |
                Select-Object -First 1
            if ($found) { return [string] $found.IPAddress }
        } catch {
            Write-Verbose $_.Exception.Message
        }
        return '192.168.1.20'
    }

    # Asks the address question on the console (Q1 to Q3). Returns Kind (local or url) and Url.
    function Read-Address([int] $PortNumber) {
        $ip = Get-FirstIPv4
        Say 'Which address will people open to use Urutau?'
        Say ''
        Say "  Press Enter to use it on this computer only, at http://127.0.0.1:$PortNumber."
        Say ''
        Say '  To use it from other computers too, type the address they will open,'
        Say "  for example http://${ip}:$PortNumber or http://urutau.lan:$PortNumber."
        Say '  Urutau then listens on every network interface of this computer.'
        Say ''
        Say '  The first person to open a new Urutau creates its admin account.'
        Say ''
        for ($tries = 0; $tries -lt 3; $tries++) {
            Write-Host -NoNewline 'Address (Enter for this computer only): '
            $answer = Read-Host
            if ($null -eq $answer) { $answer = '' }
            $result = ConvertFrom-Address -Text $answer -PortNumber $PortNumber -Mode 'ask'
            if ($result.Kind -ne 'reject') { return $result }
            Say ('That is not an address Urutau can use: ' + (Get-ReasonText -Reason $result.Reason -PortNumber $PortNumber) + '.')
        }
        Fail 'no usable address after 3 tries. Nothing was changed. Re-run the installer, or pass -PublicUrl <address>.'
    }

    # Q5: a public URL whose explicit port is not the one Urutau listens on.
    function Write-UrlPortWarning([string] $Url, [int] $PortNumber) {
        if (-not $Url.StartsWith('http://', [StringComparison]::Ordinal)) { return }
        $authority = $Url.Substring(7)
        $slash = $authority.IndexOf('/')
        if ($slash -ge 0) { $authority = $authority.Substring(0, $slash) }
        $urlPort = ''
        if ($authority.StartsWith('[')) {
            $close = $authority.IndexOf(']')
            if (($close -ge 0) -and ($authority.Length -gt $close + 1) -and ($authority[$close + 1] -eq ':')) {
                $urlPort = $authority.Substring($close + 2)
            }
        } elseif ($authority.Contains(':')) {
            $urlPort = $authority.Substring($authority.IndexOf(':') + 1)
        }
        if (($urlPort -ne '') -and ($urlPort -ne [string] $PortNumber)) {
            Write-Warn "$Url names port $urlPort, but Urutau listens on port $PortNumber. That is right only behind a reverse proxy that forwards $urlPort to $PortNumber; otherwise re-run with -Port $urlPort."
        }
    }

    # ---- platform and install root -----------------------------------------------------------------

    function Get-NodeArch {
        $arch = $env:PROCESSOR_ARCHITEW6432
        if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
        switch ($arch) {
            'AMD64' { return 'x64' }
            'ARM64' { return 'arm64' }
            default { Fail "unsupported architecture: $arch. The installer supports x64 and arm64." }
        }
    }

    function Test-AbsolutePath([string] $Path) {
        return ($Path -match '^[A-Za-z]:[\\/]') -or ($Path -match '^\\\\')
    }

    # A relative path is taken from the current directory of the PowerShell session.
    function Resolve-UserPath([string] $Path) {
        if (-not (Test-AbsolutePath $Path)) { $Path = Join-Path (Get-Location).ProviderPath $Path }
        return [IO.Path]::GetFullPath($Path)
    }

    function Resolve-Root {
        if ($InstallDir) {
            $full = Resolve-UserPath $InstallDir
        } else {
            if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set; cannot compute a default install directory. Pass -InstallDir.' }
            $full = Join-Path $env:LOCALAPPDATA 'Urutau'
        }
        if ($full -match '[#%"\r\n]') {
            Fail "the install directory contains a character that is not allowed (one of # % `" or a CR or LF): $full"
        }
        if (-not (Test-AbsolutePath $full)) { Fail "the install directory must be an absolute path: $full" }
        $driveRoot = [IO.Path]::GetPathRoot($full)
        $trimmed = $full.TrimEnd('\')
        if ($trimmed -ieq $driveRoot.TrimEnd('\')) {
            Fail "the install directory must not be a drive root or your profile directory: $full"
        }
        if ($env:USERPROFILE -and ($trimmed -ieq $env:USERPROFILE.TrimEnd('\'))) {
            Fail "the install directory must not be a drive root or your profile directory: $full"
        }
        return $trimmed
    }

    function Get-DefaultRoot { return (Join-Path $env:LOCALAPPDATA 'Urutau') }

    # Gives the install root an explicit ACL: this user and SYSTEM only, no inherited entries.
    # SIDs, not account names, so a Windows in another language works.
    function Set-RootAcl {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $result = Invoke-Native -File 'icacls.exe' -ArgList @($S.Root, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F", '*S-1-5-18:(OI)(CI)F')
        if ($result.ExitCode -ne 0) { Fail "could not restrict the permissions of $($S.Root) to your user: icacls exited with $($result.ExitCode)." }
    }

    # ---- marker ------------------------------------------------------------------------------------

    function Read-Marker {
        $path = Join-Path $S.Root '.urutau-install'
        $m = @{ Have = $false; Version = ''; Node = ''; Autostart = 'none'; Firewall = '0'; State = ''; InstalledAt = '' }
        if (Test-Path -LiteralPath $path) {
            $m.Have = $true
            $values = @{}
            foreach ($line in ((Read-Utf8File $path) -split "`r?`n")) {
                if (($line -match '^\s*#') -or ($line -notmatch '=')) { continue }
                $idx = $line.IndexOf('=')
                $values[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
            }
            if (($values['layout'] -match '^[0-9]+$') -and ([int] $values['layout'] -gt 1)) {
                Fail 'this install was created by a newer installer; get a newer install.ps1'
            }
            if ($values.ContainsKey('version')) { $m.Version = $values['version'] }
            if ($values.ContainsKey('node')) { $m.Node = $values['node'] }
            if ($values['autostart']) { $m.Autostart = $values['autostart'] }
            if ($values['firewall_rule']) { $m.Firewall = $values['firewall_rule'] }
            if ($values.ContainsKey('state')) { $m.State = $values['state'] }
            if ($values.ContainsKey('installed_at')) { $m.InstalledAt = $values['installed_at'] }
        }
        $S.M = $m
    }

    function Write-Marker([string] $State, [string] $MarkerVersion, [string] $MarkerNode, [string] $MarkerAutostart, [string] $MarkerFirewall) {
        $now = Get-NowUtc
        $installedAt = if ($S.M.InstalledAt) { $S.M.InstalledAt } else { $now }
        $lines = @(
            '# Urutau install marker - written by the installer, do not edit.',
            'layout=1',
            "version=$MarkerVersion",
            "node=$MarkerNode",
            'os=windows',
            "arch=$($S.Arch)",
            "autostart=$MarkerAutostart",
            'linger_enabled_by_installer=0',
            "firewall_rule=$MarkerFirewall",
            "state=$State",
            "installed_at=$installedAt",
            "updated_at=$now"
        )
        Write-Utf8File -Path (Join-Path $S.Root '.urutau-install') -Content (($lines -join "`n") + "`n")
        $S.M.InstalledAt = $installedAt
    }

    # ---- downloads ---------------------------------------------------------------------------------

    # Downloads a URL to a file. Returns the HTTP status (200 on success), or 0 when no HTTP
    # answer came back. A 404 is not retried; anything else is tried 3 times.
    function Get-HttpFile([string] $Url, [string] $OutFile, [hashtable] $Headers) {
        $code = 0
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                if ($Headers) {
                    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers $Headers | Out-Null
                } else {
                    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing | Out-Null
                }
                return 200
            } catch {
                $code = 0
                $response = $null
                try { $response = $_.Exception.Response } catch { $response = $null }
                if ($response) {
                    try { $code = [int] $response.StatusCode } catch { $code = 0 }
                }
                if ($code -eq 404) { return 404 }
                if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
            }
        }
        return $code
    }

    # Text downloads go through a file and are decoded as UTF-8 here: Invoke-WebRequest
    # returns .Content as bytes when the server's Content-Type is not text, and GitHub serves
    # a release's .sha256 as application/octet-stream. Returns $null on any failure.
    function Get-HttpText([string] $Url, [hashtable] $Headers) {
        $tmp = Join-Path $S.Staging 'text-download.tmp'
        try {
            $code = Get-HttpFile -Url $Url -OutFile $tmp -Headers $Headers
            if ($code -ne 200) { return $null }
            return (Read-Utf8File $tmp)
        } finally {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }

    # One GET. Returns Code (0 when nothing answered), Body and Location. NoProxy is for the
    # probes of the local server only: a proxy configured for the user's session must not carry
    # a request to 127.0.0.1, while the github.com request still needs it.
    function Invoke-HttpGet([string] $Url, [int] $TimeoutMs, [bool] $NoRedirect, [bool] $NoProxy) {
        $request = [Net.HttpWebRequest]::Create($Url)
        if ($NoProxy) { $request.Proxy = $null }
        $request.Timeout = $TimeoutMs
        $request.ReadWriteTimeout = $TimeoutMs
        $request.UserAgent = 'urutau-install'
        if ($NoRedirect) { $request.AllowAutoRedirect = $false }
        $response = $null
        try {
            try {
                $response = $request.GetResponse()
            } catch [Net.WebException] {
                $response = $_.Exception.Response
                if (-not $response) { return [pscustomobject]@{ Code = 0; Body = ''; Location = '' } }
            }
            $body = ''
            $stream = $response.GetResponseStream()
            if ($stream) {
                $reader = New-Object IO.StreamReader($stream, $Utf8)
                try { $body = $reader.ReadToEnd() } finally { $reader.Close() }
            }
            return [pscustomobject]@{ Code = [int] $response.StatusCode; Body = $body; Location = [string] $response.Headers['Location'] }
        } catch {
            return [pscustomobject]@{ Code = 0; Body = ''; Location = '' }
        } finally {
            if ($response) { $response.Close() }
        }
    }

    # ---- Node --------------------------------------------------------------------------------------

    # Stages the latest Node 24 in .staging\node when it differs from the installed one, after
    # checking its SHA-256 against nodejs.org's SHASUMS256.txt. Sets NodeDir and NodeReplaced.
    function Initialize-Node {
        $dl = Join-Path $S.Staging 'dl'
        New-Item -ItemType Directory -Path $dl -Force | Out-Null
        $sumsUrl = "$NodeDistUrl/latest-v24.x/SHASUMS256.txt"
        $sumsFile = Join-Path $dl 'node-SHASUMS256.txt'
        if ((Get-HttpFile -Url $sumsUrl -OutFile $sumsFile) -ne 200) { Fail "could not download the Node 24 checksums from $sumsUrl" }
        $pattern = 'node-v24\.[0-9]+\.[0-9]+-win-' + $S.Arch + '\.zip$'
        $line = $null
        foreach ($candidate in ((Read-Utf8File $sumsFile) -split "`r?`n")) {
            if ($candidate -cmatch $pattern) { $line = $candidate.Trim(); break }
        }
        if (-not $line) { Fail "could not find a Node 24 build for win-$($S.Arch) in $sumsUrl" }
        $parts = $line -split '\s+'
        $hash = $parts[0].ToLowerInvariant()
        $file = $parts[1]
        if ($file -cmatch '^node-v(24\.[0-9]+\.[0-9]+)-') { $target = $Matches[1] } else { Fail "could not read a Node version from $file" }
        $nodeExe = Join-Path $S.Root 'node\node.exe'
        $current = ''
        if (Test-Path -LiteralPath $nodeExe) {
            $probe = Invoke-Native -File $nodeExe -ArgList @('--version')
            if ($probe.ExitCode -eq 0) { $current = $probe.Out.Trim().TrimStart('v') }
        }
        $S.NodeVersion = $target
        if ($current -eq $target) {
            $S.NodeReplaced = $false
            $S.NodeDir = Join-Path $S.Root 'node'
            return
        }
        Write-Info "Downloading Node $target for win-$($S.Arch)"
        $zip = Join-Path $dl $file
        if ((Get-HttpFile -Url "$NodeDistUrl/v$target/$file" -OutFile $zip) -ne 200) { Fail "could not download Node: $NodeDistUrl/v$target/$file" }
        if ((Get-Sha256 $zip) -ne $hash) { Fail "checksum mismatch for $file. Nothing was changed." }
        $extract = Join-Path $S.Staging 'node-extract'
        Remove-Tree $extract
        Remove-Tree (Join-Path $S.Staging 'node')
        # Not Expand-Archive: it is a script-module cmdlet that ignores this function's
        # $ProgressPreference and draws a slow progress bar on Windows PowerShell 5.1.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
        $inner = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
        if (-not $inner) { Fail "unexpected layout in $file" }
        Move-Path -From $inner.FullName -To (Join-Path $S.Staging 'node')
        Remove-Tree $extract
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        $S.NodeReplaced = $true
        $S.NodeDir = Join-Path $S.Staging 'node'
    }

    function Get-NodeExe { return (Join-Path $S.NodeDir 'node.exe') }

    # ---- version and bundle ------------------------------------------------------------------------

    function Test-NoBundleVersion([string] $Candidate) {
        return ($NoBundleVersions -contains $Candidate)
    }

    # Sets Version to the latest release: one GET to the GitHub REST API without credentials,
    # then the redirect of github.com/.../releases/latest when that fails.
    function Resolve-LatestVersion {
        $tag = ''
        $json = Get-HttpText -Url $ApiUrl -Headers @{
            'Accept' = 'application/vnd.github+json'
            'X-GitHub-Api-Version' = '2022-11-28'
            'User-Agent' = 'urutau-install'
        }
        if ($json) {
            try {
                $tag = [string] ($json | ConvertFrom-Json).tag_name
                if ($tag.StartsWith('v')) { $tag = $tag.Substring(1) }
            } catch {
                $tag = ''
            }
        }
        if ($tag -cnotmatch $VersionRe) {
            $tag = ''
            $reply = Invoke-HttpGet -Url $LatestReleasePage -TimeoutMs 30000 -NoRedirect $true -NoProxy $false
            $marker = '/tag/v'
            $at = $reply.Location.IndexOf($marker, [StringComparison]::Ordinal)
            if ($at -ge 0) { $tag = $reply.Location.Substring($at + $marker.Length) }
            if ($tag -cnotmatch $VersionRe) { $tag = '' }
        }
        if (-not $tag) { Fail 'could not find the latest Urutau release (api.github.com and github.com did not answer). Pass -Version X.Y.Z.' }
        $S.Version = $tag
        if (Test-NoBundleVersion $tag) {
            Fail "the latest release, v$tag, has no installer bundle. Packaged releases start with the release after v0.5.0. Until it is published, use Docker (ghcr.io/oshogun/urutau:$tag) or a source checkout."
        }
    }

    function Assert-Checksum([string] $File, [string] $ShaFile, [string] $Name) {
        $text = (Read-Utf8File $ShaFile).Trim()
        $expected = ($text -split '\s+')[0].ToLowerInvariant()
        if ((Get-Sha256 $File) -ne $expected) { Fail "checksum mismatch for $Name. Nothing was changed." }
    }

    # Gets the bundle (release download or -Bundle), verifies it before extracting, extracts it
    # to .staging\app and checks it.
    function Get-Bundle {
        $dl = Join-Path $S.Staging 'dl'
        New-Item -ItemType Directory -Path $dl -Force | Out-Null
        $tarball = Join-Path $dl 'bundle.tar.gz'
        $shaFile = Join-Path $dl 'bundle.tar.gz.sha256'
        $haveSha = $false
        if ($Bundle) {
            if ($Bundle -cmatch '^https?://') {
                Write-Info "Downloading $Bundle"
                $code = Get-HttpFile -Url $Bundle -OutFile $tarball
                if ($code -ne 200) { Fail "could not download $Bundle (HTTP $code)" }
                if ((Get-HttpFile -Url "$Bundle.sha256" -OutFile $shaFile) -eq 200) { $haveSha = $true }
                if (-not $haveSha) { Write-Warn "no checksum file at $Bundle.sha256; installing $Bundle unverified." }
            } else {
                if (-not (Test-Path -LiteralPath $S.BundlePath -PathType Leaf)) { Fail "the bundle was not found: $($S.BundlePath)" }
                Copy-Item -LiteralPath $S.BundlePath -Destination $tarball -Force
                if (Test-Path -LiteralPath "$($S.BundlePath).sha256") {
                    Copy-Item -LiteralPath "$($S.BundlePath).sha256" -Destination $shaFile -Force
                    $haveSha = $true
                } else {
                    Write-Warn "no checksum file at $($S.BundlePath).sha256; installing $($S.BundlePath) unverified."
                }
            }
        } else {
            $url = "$ReleaseBaseUrl/v$($S.Version)/urutau-server-$($S.Version).tar.gz"
            Write-Info "Downloading Urutau $($S.Version)"
            $code = Get-HttpFile -Url $url -OutFile $tarball
            if ($code -ne 200) {
                if ($code -eq 404) {
                    Fail "no installer bundle at $url (HTTP 404). Either v$($S.Version) is not a release, or it was published before the installers existed: packaged releases start with the first release whose assets include urutau-server-<version>.tar.gz. Releases: https://github.com/oshogun/urutau/releases"
                }
                Fail "could not download $url (HTTP $code)"
            }
            $shaCode = Get-HttpFile -Url "$url.sha256" -OutFile $shaFile
            if ($shaCode -ne 200) { Fail "no checksum file at $url.sha256 (HTTP $shaCode). Nothing was changed." }
            $haveSha = $true
        }
        if ($haveSha) {
            $shown = if ($Bundle) { Split-Path -Leaf $Bundle } else { "urutau-server-$($S.Version).tar.gz" }
            Assert-Checksum -File $tarball -ShaFile $shaFile -Name $shown
        }

        $extract = Join-Path $S.Staging 'extract'
        $app = Join-Path $S.Staging 'app'
        Remove-Tree $app
        Remove-Tree $extract
        New-Item -ItemType Directory -Path $extract -Force | Out-Null
        # The system tar.exe (bsdtar, Windows 10 1803 and later) reads the gzip tarball. It runs
        # with the staging directory as its working directory and relative ASCII arguments, so a
        # non-ASCII install path never goes through its command line.
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (-not (Test-Path -LiteralPath $tar)) { Fail "tar.exe was not found at $tar. Windows 10 version 1803 or later is required." }
        $untar = Invoke-Native -File $tar -ArgList @('-xzf', 'dl\bundle.tar.gz', '-C', 'extract') -WorkDir $S.Staging
        if ($untar.ExitCode -ne 0) { Fail 'could not extract the bundle' }
        $entries = @(Get-ChildItem -LiteralPath $extract -Force)
        if (($entries.Count -ne 1) -or (-not $entries[0].PSIsContainer)) { Fail 'unexpected bundle layout: it must hold one top-level directory' }
        Move-Path -From $entries[0].FullName -To $app
        Remove-Tree $extract
        Remove-Tree $dl
        foreach ($rel in @('VERSION', 'package.json', 'package-lock.json', 'server\main.ts', 'dist\index.html')) {
            if (-not (Test-Path -LiteralPath (Join-Path $app $rel) -PathType Leaf)) { Fail "the bundle is missing $($rel.Replace('\', '/'))" }
        }
        $bundleVersion = (Read-Utf8File (Join-Path $app 'VERSION')).Trim()
        if ($bundleVersion -cnotmatch $VersionRe) { Fail "the bundle's VERSION is not a version: $bundleVersion" }
        if ($Bundle) {
            $S.Version = $bundleVersion
        } elseif ($bundleVersion -ne $S.Version) {
            Fail "the downloaded bundle reports version $bundleVersion, expected $($S.Version)"
        }
        $pkgText = Read-Utf8File (Join-Path $app 'package.json')
        if (-not $pkgText.Contains('"node": ">=24 <25"')) {
            $engines = ''
            try { $engines = [string] ($pkgText | ConvertFrom-Json).engines.node } catch { $engines = '' }
            Fail "this release needs Node $engines, and this installer installs Node 24. Use the installer attached to that release: https://github.com/oshogun/urutau/releases/download/v$($S.Version)/install.ps1"
        }
    }

    function Install-Dependencies {
        Write-Info 'Installing the dependencies (npm ci --omit=dev)'
        $nodeExe = Get-NodeExe
        $npmCli = Join-Path $S.NodeDir 'node_modules\npm\bin\npm-cli.js'
        $result = Invoke-Native -File $nodeExe -ArgList @($npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund') `
            -WorkDir (Join-Path $S.Staging 'app') -ExtraEnv @{ PATH = "$($S.NodeDir);$env:PATH" }
        if ($result.ExitCode -ne 0) {
            $tail = (($result.Out + "`n" + $result.Err) -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last 20) -join "`n"
            Write-Host $tail
            Fail 'npm ci failed while installing the dependencies. Nothing was changed.'
        }
    }

    # ---- configuration -----------------------------------------------------------------------------

    function Write-Helpers {
        Write-Utf8File -Path (Join-Path $S.Staging 'check-config.mjs') -Content @'
// Written by install.sh and install.ps1 into <root>/.staging/check-config.mjs and run as
//   <node> --env-file=<root>/.staging/urutau.env <root>/.staging/check-config.mjs <staged app dir>
// with every server variable removed from the environment first, so the only values it
// sees are the staged file's. It loads the staged app's own configuration reader and
// runs it, so the installer accepts exactly what the new server will accept. Exit 0: the
// file is valid. Exit 1: the first line of stderr is the reader's message, which names
// the variable and never its value. Prints nothing on success: the file holds a secret.
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const appDir = process.argv[2]
const { loadConfig } = await import(pathToFileURL(join(appDir, 'server', 'config.ts')).href)
try {
  loadConfig(process.env)
} catch (error) {
  console.error(`urutau-install: ${error instanceof Error ? error.message : 'the configuration is not valid'}`)
  process.exit(1)
}
'@
        Write-Utf8File -Path (Join-Path $S.Staging 'port-free.cjs') -Content @'
// Written by install.sh and install.ps1 into <root>/.staging/port-free.cjs and run as
//   <node> <root>/.staging/port-free.cjs <host> <port>
// Exit 0: host:port can be bound now. Exit 1: it cannot (stderr names the error code,
// for example EADDRINUSE or EACCES).
const net = require('node:net')

const [host, port] = process.argv.slice(2)
const server = net.createServer()
server.once('error', (error) => {
  console.error(error.code ?? 'error')
  process.exit(1)
})
server.listen(Number(port), host, () => server.close(() => process.exit(0)))
'@
    }

    # Builds .staging\urutau.env from the existing file (or a new one) and this run's options.
    # Sets ConfigChanged ($true when it differs from the file in place, or there is none).
    function Merge-Config {
        $staged = Join-Path $S.Staging 'urutau.env'
        $live = Join-Path $S.Root 'urutau.env'
        $wantPort = if ($Port) { [string] [int] $Port } else { '' }
        if (-not (Test-Path -LiteralPath $live)) {
            $lines = New-Object System.Collections.Generic.List[string]
            $lines.Add('# Urutau server configuration. The installer wrote this file and keeps your edits.')
            $lines.Add('# One KEY=value per line, without quotes. Variables: https://github.com/oshogun/urutau#environment-variables')
            Set-EnvValue $lines 'HOST' $(if ($S.WantHost) { $S.WantHost } else { '127.0.0.1' })
            Set-EnvValue $lines 'PORT' $(if ($wantPort) { $wantPort } else { [string] $DefaultPort })
            Set-EnvValue $lines 'DATABASE_URL' ('sqlite:' + (Join-Path $S.Root 'data\urutau.db'))
            # The key is generated once, for a new file only, by the private Node. It stays in
            # this variable: never printed, never on a command line.
            $generated = Invoke-Native -File (Get-NodeExe) -ArgList @('-e', "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")
            $key = $generated.Out.Trim()
            if (($generated.ExitCode -ne 0) -or ($key -cnotmatch '^[A-Za-z0-9+/]{43}=$')) { Fail 'could not generate TOKEN_ENCRYPTION_KEY' }
            $lines.Add("TOKEN_ENCRYPTION_KEY=$key")
            $key = ''
            $generated = $null
            if ($S.WantPublicUrl) { Set-EnvValue $lines 'PUBLIC_URL' $S.WantPublicUrl }
            if ($AllowedHosts) { Set-EnvValue $lines 'ALLOWED_HOSTS' $AllowedHosts }
            Write-EnvLines $staged $lines
            $S.ConfigChanged = $true
            return
        }
        $lines = Read-EnvLines $live
        if ($S.WantHost) { Set-EnvValue $lines 'HOST' $S.WantHost }
        if ($wantPort) { Set-EnvValue $lines 'PORT' $wantPort }
        if ($S.WantPublicUrl) { Set-EnvValue $lines 'PUBLIC_URL' $S.WantPublicUrl }
        if ($S.RemovePublicUrl) { Remove-EnvValue $lines 'PUBLIC_URL' }
        if ($AllowedHosts) { Set-EnvValue $lines 'ALLOWED_HOSTS' $AllowedHosts }
        $hasKey = $false
        $keyPattern = Get-EnvPattern 'TOKEN_ENCRYPTION_KEY'
        foreach ($line in $lines) { if ($line -cmatch $keyPattern) { $hasKey = $true } }
        if (-not $hasKey) {
            Write-Warn "$live has no TOKEN_ENCRYPTION_KEY, so agent integrations cannot store a GitHub token. The installer only creates a key for a new configuration; add one yourself (32 random bytes in base64)."
        }
        Write-EnvLines $staged $lines
        $S.ConfigChanged = ((Get-Sha256 $staged) -ne (Get-Sha256 $live))
    }

    # ---- service -----------------------------------------------------------------------------------

    function Get-ServiceScriptPath { return (Join-Path $S.Root 'bin\urutau-service.ps1') }

    function Get-SupervisorContent {
        return @'
# Urutau service supervisor - written by the installer. Runs the server and restarts it
# with a delay when it exits unexpectedly. It finds the install directory from its own
# location, so the file holds no machine-specific path.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $root 'run'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$supervisorPidFile = Join-Path $runDir 'supervisor.pid'
$nodePidFile = Join-Path $runDir 'node.pid'

# Only urutau.env, through --env-file, may set the server's variables: a value inherited
# from this process would win over the file.
foreach ($urutauEnvKey in @('HOST', 'PORT', 'DATABASE_URL', 'PUBLIC_URL', 'ALLOWED_HOSTS', 'TRUST_PROXY', 'TOKEN_ENCRYPTION_KEY', 'KEYCLOAK_ISSUER', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET', 'KEYCLOAK_GITHUB_IDP', 'KEYCLOAK_BROKER_API', 'KEYCLOAK_ALLOW_HTTP', 'NODE_OPTIONS')) {
    Remove-Item -Path "Env:$urutauEnvKey" -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $supervisorPidFile) {
    $existingId = Get-Content -LiteralPath $supervisorPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    # A process name alone is not enough: a process id can be reused by any powershell
    # process once the old supervisor has exited. The command line must name this script,
    # and this process's own id is never accepted.
    if ($existingId -and ($existingId -ne $PID)) {
        $existing = Get-Process -Id $existingId -ErrorAction SilentlyContinue
        if ($existing -and ($existing.ProcessName -eq 'powershell' -or $existing.ProcessName -eq 'pwsh')) {
            $existingCommandLine = $null
            try {
                $existingCommandLine = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$existingId" -ErrorAction Stop).CommandLine
            } catch {
                $existingCommandLine = $null
            }
            if ($existingCommandLine) {
                $normalizedCommandLine = ($existingCommandLine -replace '\\{2,}', '\').ToLowerInvariant()
                $normalizedSelf = ($PSCommandPath -replace '\\{2,}', '\').ToLowerInvariant()
                if ($normalizedCommandLine.Contains($normalizedSelf)) {
                    return
                }
            }
        }
    }
}
Set-Content -LiteralPath $supervisorPidFile -Value $PID -Encoding ASCII

function Move-LogAside([string] $Path) {
    if (Test-Path -LiteralPath $Path) {
        Move-Item -LiteralPath $Path -Destination "$Path.1" -Force -ErrorAction SilentlyContinue
    }
}

$backoffSteps = @(5, 10, 20, 40, 60, 60)
$backoffIndex = 0

try {
    while ($true) {
        $outLog = Join-Path $logDir 'urutau.out.log'
        $errLog = Join-Path $logDir 'urutau.err.log'
        Move-LogAside $outLog
        Move-LogAside $errLog

        $nodeExe = Join-Path $root 'node\node.exe'
        $envFile = Join-Path $root 'urutau.env'
        $startedAt = Get-Date

        $proc = Start-Process -FilePath $nodeExe `
            -ArgumentList @("--env-file=`"$envFile`"", "`"$root\app\server\main.ts`"") `
            -WorkingDirectory (Join-Path $root 'app') `
            -NoNewWindow -PassThru `
            -RedirectStandardOutput $outLog `
            -RedirectStandardError $errLog

        # Reading Handle keeps PowerShell 5.1 from losing ExitCode later.
        $null = $proc.Handle
        Set-Content -LiteralPath $nodePidFile -Value $proc.Id -Encoding ASCII
        $proc.WaitForExit()
        Remove-Item -LiteralPath $nodePidFile -ErrorAction SilentlyContinue

        $uptimeSeconds = ((Get-Date) - $startedAt).TotalSeconds
        if ($uptimeSeconds -ge 600) { $backoffIndex = 0 }

        if ($proc.ExitCode -eq 0) { break }

        $delay = $backoffSteps[[Math]::Min($backoffIndex, $backoffSteps.Length - 1)]
        $backoffIndex++
        Start-Sleep -Seconds $delay
    }
} finally {
    Remove-Item -LiteralPath $nodePidFile -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $supervisorPidFile -ErrorAction SilentlyContinue
}
'@
    }

    # The Scheduled Task definition: a logon trigger for this user (15 second delay) that runs the
    # supervisor hidden, with the user and the root filled in.
    function Get-TaskXml {
        $user = "$env:USERDOMAIN\$env:USERNAME"
        $template = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Urutau kanban board server (per-user, starts at logon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{USER}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{USER}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{ROOT}\bin\urutau-service.ps1"</Arguments>
      <WorkingDirectory>{ROOT}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
'@
        return $template.Replace('{USER}', [Security.SecurityElement]::Escape($user)).Replace('{ROOT}', [Security.SecurityElement]::Escape($S.Root))
    }

    function Get-StartupShortcutPath {
        return (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Urutau.lnk')
    }

    function New-StartupShortcut {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Get-StartupShortcutPath))
        $shortcut.TargetPath = 'powershell.exe'
        $shortcut.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Get-ServiceScriptPath)`""
        $shortcut.WorkingDirectory = $S.Root
        $shortcut.WindowStyle = 7
        $shortcut.Save()
    }

    function Test-TaskRegistered {
        return ($null -ne (Get-ScheduledTask -TaskName 'Urutau' -ErrorAction SilentlyContinue))
    }

    function Test-Elevated {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }

    function Invoke-Elevated([string] $Command) {
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
        $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
        return $proc.ExitCode
    }

    function Test-FirewallRule { return ($null -ne (Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue)) }

    # True when the rule exists and names this install's node.exe and this port.
    function Test-FirewallRuleMatches([int] $PortNumber) {
        $rule = Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
        if (-not $rule) { return $false }
        $app = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
        $ports = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
        return [bool] ($app -and $ports -and ($app.Program -ieq (Join-Path $S.Root 'node\node.exe')) -and ($ports.LocalPort -eq [string] $PortNumber))
    }

    function Get-FirewallSetCommand([int] $PortNumber) {
        $nodeQ = Format-PSSingleQuoted (Join-Path $S.Root 'node\node.exe')
        return "Remove-NetFirewallRule -Name '$FirewallRuleName' -ErrorAction SilentlyContinue; New-NetFirewallRule -Name '$FirewallRuleName' -DisplayName 'Urutau server' -Direction Inbound -Action Allow -Profile Private -Program '$nodeQ' -Protocol TCP -LocalPort $PortNumber | Out-Null"
    }

    function Get-FirewallRemoveCommand {
        return "Remove-NetFirewallRule -Name '$FirewallRuleName' -ErrorAction SilentlyContinue"
    }

    # Does the work that needs administrator rights: the firewall rule ('set', 'remove' or
    # 'none') and registering the task. Elevated already: runs it here. Otherwise one UAC
    # prompt covers all of it, unless -NoElevate, which prints the command instead.
    function Invoke-Privileged([string] $Firewall, [int] $PortNumber, [bool] $NeedTask) {
        if (($Firewall -eq 'none') -and (-not $NeedTask)) { return }
        $taskXmlPath = Join-Path $S.Staging 'Urutau-task.xml'
        $commands = @()
        if ($Firewall -eq 'set') { $commands += (Get-FirewallSetCommand $PortNumber) }
        if ($Firewall -eq 'remove') { $commands += (Get-FirewallRemoveCommand) }
        if ($NeedTask) {
            $commands += ("Register-ScheduledTask -TaskName 'Urutau' -Xml ([IO.File]::ReadAllText('" + (Format-PSSingleQuoted $taskXmlPath) + "', (New-Object Text.UTF8Encoding(`$false)))) -Force | Out-Null")
        }
        if (Test-Elevated) {
            try {
                if ($Firewall -eq 'set') {
                    Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
                    New-NetFirewallRule -Name $FirewallRuleName -DisplayName 'Urutau server' -Direction Inbound -Action Allow -Profile Private -Program (Join-Path $S.Root 'node\node.exe') -Protocol TCP -LocalPort $PortNumber | Out-Null
                }
                if ($Firewall -eq 'remove') { Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue }
                if ($NeedTask) { Register-ScheduledTask -TaskName 'Urutau' -Xml (Get-TaskXml) -Force -ErrorAction Stop | Out-Null }
            } catch {
                Write-Warn "an administrator step failed: $($_.Exception.Message)"
            }
        } elseif (-not $NoElevate) {
            try {
                [void] (Invoke-Elevated -Command ($commands -join '; '))
            } catch {
                Write-Warn "the administrator prompt did not run: $($_.Exception.Message)"
            }
        } else {
            Write-Warn '-NoElevate was given, so these steps were not done. To do them, run this in a PowerShell window opened as administrator:'
            foreach ($command in $commands) { Write-Host "  $command" }
        }
    }

    # ---- stopping, starting and checking the server ------------------------------------------------

    # The process named by a pid file when it is this root's node.exe, else $null.
    function Get-NodeProcess {
        $pidFile = Join-Path $S.Root 'run\node.pid'
        if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
        $procId = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if (-not $procId) { return $null }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { return $null }
        try { $imagePath = $proc.Path } catch { $imagePath = $null }
        if ((-not $imagePath) -or ($imagePath -ine (Join-Path $S.Root 'node\node.exe'))) { return $null }
        return $proc
    }

    # A name check alone (powershell or pwsh) is not enough to trust run\supervisor.pid: a
    # process id can be reused by any powershell process. The command line must name this
    # root's bin\urutau-service.ps1, and this installer's own $PID is never accepted.
    function Get-SupervisorProcess {
        $pidFile = Join-Path $S.Root 'run\supervisor.pid'
        if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
        $procId = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ((-not $procId) -or ($procId -eq $PID)) { return $null }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { return $null }
        if (($proc.ProcessName -ne 'powershell') -and ($proc.ProcessName -ne 'pwsh')) { return $null }
        try {
            $commandLine = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine
        } catch {
            return $null
        }
        if (-not $commandLine) { return $null }
        $normalizedCommandLine = ($commandLine -replace '\\{2,}', '\').ToLowerInvariant()
        $normalizedExpected = ((Get-ServiceScriptPath) -replace '\\{2,}', '\').ToLowerInvariant()
        if ($normalizedCommandLine.Contains($normalizedExpected)) { return $proc }
        return $null
    }

    # Stops the Scheduled Task, then the supervisor and node, each only when its pid file
    # names a process of this root (never by process name), and waits up to 30 seconds. Windows
    # has no SIGTERM, so the server does not close its database: the -wal and -shm files stay,
    # and the backup copies them.
    function Stop-UrutauService {
        if (Test-TaskRegistered) {
            try { Stop-ScheduledTask -TaskName 'Urutau' -ErrorAction SilentlyContinue } catch { Write-Verbose $_.Exception.Message }
        }
        $supervisor = Get-SupervisorProcess
        if ($supervisor) {
            try { Stop-Process -Id $supervisor.Id -Force -ErrorAction SilentlyContinue } catch { Write-Verbose $_.Exception.Message }
        }
        $node = Get-NodeProcess
        if ($node) {
            try { Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue } catch { Write-Verbose $_.Exception.Message }
        }
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            if ((-not (Get-SupervisorProcess)) -and (-not (Get-NodeProcess))) { break }
            Start-Sleep -Milliseconds 500
        }
        Remove-Item -LiteralPath (Join-Path $S.Root 'run\supervisor.pid') -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $S.Root 'run\node.pid') -ErrorAction SilentlyContinue
    }

    # Starts the server for a trial (no service): node in the background, its output in
    # trial.log (stdout) and trial.err.log (stderr) of the staging directory.
    function Start-Trial([string] $Name) {
        $out = Join-Path $S.Staging "$Name.log"
        $err = Join-Path $S.Staging "$Name.err.log"
        $envFile = Join-Path $S.Root 'urutau.env'
        $main = Join-Path $S.Root 'app\server\main.ts'
        $proc = Invoke-WithoutServerEnv {
            Start-Process -FilePath (Join-Path $S.Root 'node\node.exe') `
                -ArgumentList @("--env-file=`"$envFile`"", "`"$main`"") `
                -WorkingDirectory (Join-Path $S.Root 'app') `
                -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        }
        $null = $proc.Handle
        $S.TrialProc = $proc
    }

    function Stop-Trial {
        $proc = $S.TrialProc
        if (-not $proc) { return }
        try {
            if (-not $proc.HasExited) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                [void] $proc.WaitForExit(15000)
            }
        } catch {
            Write-Verbose $_.Exception.Message
        }
        $S.TrialProc = $null
    }

    # Prints the last 20 lines of the trial server's output when it did not become healthy.
    function Show-TrialLog {
        if ($S.Autostart -ne 'none') { return }
        foreach ($name in @('trial.log', 'trial.err.log')) {
            $file = Join-Path $S.Staging $name
            if (Test-Path -LiteralPath $file) {
                Say "The last lines of ${file}:"
                Get-Content -LiteralPath $file -Tail 20 | ForEach-Object { Write-Host $_ }
            }
        }
    }

    function Stop-Server {
        if ($S.Autostart -ne 'none') { Stop-UrutauService } else { Stop-Trial }
    }

    function Wait-SupervisorStarted([int] $TimeoutSeconds) {
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        do {
            if (Get-SupervisorProcess) { return $true }
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $deadline)
        return $false
    }

    # Starts the server in the way the install is set up: through the Scheduled Task, falling
    # back to starting the supervisor directly (Start-ScheduledTask can return without error
    # from a non-interactive session while the task never runs), or the trial process.
    function Start-Server {
        if ($S.Autostart -eq 'none') {
            Start-Trial -Name 'trial'
            return
        }
        if ($S.Autostart -eq 'task') {
            $verified = $false
            try {
                Start-ScheduledTask -TaskName 'Urutau' -ErrorAction Stop
                $verified = Wait-SupervisorStarted -TimeoutSeconds 10
            } catch {
                Write-Warn "Start-ScheduledTask -TaskName 'Urutau' failed: $($_.Exception.Message)"
            }
            if ($verified) { return }
            Write-Info 'The logon task did not visibly start the service; started it directly for this run. It stays registered for future logons.'
        }
        # The supervisor has its own single-instance check, so this cannot start a second one.
        try {
            Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$(Get-ServiceScriptPath)`""
            ) | Out-Null
        } catch {
            Fail "Start-Process powershell.exe -File $(Get-ServiceScriptPath) failed, so the server was not started: $($_.Exception.Message)"
        }
    }

    # Writes the supervisor, registers the Scheduled Task (or the Startup-folder shortcut when
    # the task cannot be registered) and sets the firewall rule to match HOST. Sets Autostart.
    function Register-Autostart {
        Write-Utf8File -Path (Get-ServiceScriptPath) -Content (Get-SupervisorContent)
        Write-Utf8File -Path (Join-Path $S.Staging 'Urutau-task.xml') -Content (Get-TaskXml)
        $taskOk = $false
        try {
            Register-ScheduledTask -TaskName 'Urutau' -Xml (Get-TaskXml) -Force -ErrorAction Stop | Out-Null
            $taskOk = $true
        } catch {
            $taskOk = $false
        }
        $hostNow = Get-EnvValue (Join-Path $S.Root 'urutau.env') 'HOST'
        $portText = Get-EnvValue (Join-Path $S.Root 'urutau.env') 'PORT'
        $portNow = if ($portText) { [int] $portText } else { $DefaultPort }
        $needRule = -not (Test-HostLoopback $hostNow)
        $firewall = 'none'
        if ($needRule -and (-not (Test-FirewallRuleMatches $portNow))) { $firewall = 'set' }
        if ((-not $needRule) -and (Test-FirewallRule)) { $firewall = 'remove' }
        Invoke-Privileged -Firewall $firewall -PortNumber $portNow -NeedTask (-not $taskOk)
        $taskOk = Test-TaskRegistered
        if ($needRule) {
            if (-not (Test-FirewallRule)) {
                Write-Warn "the firewall rule $FirewallRuleName was not created, so other computers cannot reach Urutau until it is. When the server starts, Windows may ask whether to allow node.exe through the firewall: choose Private networks and Allow access."
            }
            try {
                foreach ($netProfile in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
                    if ($netProfile.NetworkCategory -eq 'Public') {
                        Write-Warn "Network '$($netProfile.Name)' is classified Public; the firewall rule covers Private networks only. Mark it Private in Windows Settings if other computers need to connect."
                    }
                }
            } catch {
                Write-Warn "could not read the network profile: $($_.Exception.Message)"
            }
        }
        $shortcut = Get-StartupShortcutPath
        if (-not $taskOk) {
            Write-Warn "Register-ScheduledTask -TaskName 'Urutau' failed, so Urutau starts from the Startup folder at logon instead."
        }
        if ($taskOk) {
            if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
            $S.Autostart = 'task'
        } else {
            try {
                New-StartupShortcut
            } catch {
                Fail "neither Register-ScheduledTask -TaskName 'Urutau' nor creating $shortcut worked: $($_.Exception.Message)"
            }
            $S.Autostart = 'startup-folder'
        }
    }

    # Sets the firewall rule to match the configuration at $ConfigPath (used by the rollback).
    function Restore-Firewall([string] $ConfigPath) {
        $hostNow = Get-EnvValue $ConfigPath 'HOST'
        $portText = Get-EnvValue $ConfigPath 'PORT'
        $portNow = if ($portText) { [int] $portText } else { $DefaultPort }
        $needRule = -not (Test-HostLoopback $hostNow)
        $firewall = 'none'
        if ($needRule -and (-not (Test-FirewallRuleMatches $portNow))) { $firewall = 'set' }
        if ((-not $needRule) -and (Test-FirewallRule)) { $firewall = 'remove' }
        Invoke-Privileged -Firewall $firewall -PortNumber $portNow -NeedTask $false
    }

    function Get-FirewallMarkerValue {
        if ($S.Autostart -eq 'none') { return '0' }
        if (Test-FirewallRule) { return '1' }
        return '0'
    }

    # ---- port, health and the final output ---------------------------------------------------------

    # Used for the port check only: a Windows listener on 0.0.0.0 or :: holds the port for
    # every address, so a wildcard bind and a bind of one address collide both ways.
    function Test-AddressBusy([string] $BindAddr, [string] $ListenerAddr) {
        if ($ListenerAddr -eq '::') { return $true }
        if ($BindAddr -eq '::') { return $true }
        $listenerIsV6 = $ListenerAddr.Contains(':')
        if ($BindAddr -and $BindAddr.Contains(':')) { return ($ListenerAddr -eq $BindAddr) }
        if ($listenerIsV6) { return $false }
        if ((-not $BindAddr) -or ($BindAddr -eq '0.0.0.0') -or ($BindAddr -eq '*')) { return $true }
        return ($ListenerAddr -eq $BindAddr) -or ($ListenerAddr -eq '0.0.0.0')
    }

    # True when HOST:PORT can be bound. Reads the system's list of listening sockets
    # (Get-NetTCPConnection) instead of binding the port with the staged node.exe: binding a
    # wildcard address with a program Windows does not know yet shows the firewall's "allow
    # access" prompt. Without that cmdlet, port-free.cjs tries 127.0.0.1.
    function Test-PortFree([string] $HostName, [int] $PortNumber) {
        if ($null -ne (Get-Command -Name Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $PortNumber -ErrorAction SilentlyContinue)
            if ($listeners.Count -eq 0) { return $true }
            $bindAddrs = @($HostName)
            if ($HostName -and ($HostName -ne '0.0.0.0') -and ($HostName -ne '::') -and ($HostName -ne '*')) {
                try { $bindAddrs = @([Net.Dns]::GetHostAddresses($HostName) | ForEach-Object { $_.ToString() }) } catch { $bindAddrs = @($HostName) }
            }
            foreach ($bindAddr in $bindAddrs) {
                foreach ($listener in $listeners) {
                    if (Test-AddressBusy -BindAddr $bindAddr -ListenerAddr $listener.LocalAddress) { return $false }
                }
            }
            return $true
        }
        $probe = Invoke-Native -File (Get-NodeExe) -ArgList @((Join-Path $S.Staging 'port-free.cjs'), '127.0.0.1', [string] $PortNumber)
        return ($probe.ExitCode -eq 0)
    }

    # Sets Probe, the address the installer asks, from the configuration at $ConfigPath.
    function Set-ProbeUrl([string] $ConfigPath) {
        $hostName = Get-EnvValue $ConfigPath 'HOST'
        if (-not $hostName) { $hostName = '127.0.0.1' }
        $portText = Get-EnvValue $ConfigPath 'PORT'
        if (-not $portText) { $portText = [string] $DefaultPort }
        if (($hostName -eq '0.0.0.0') -or ($hostName -eq 'localhost')) {
            $hostName = '127.0.0.1'
        } elseif (($hostName -eq '::') -or ($hostName -eq '::1')) {
            $hostName = '[::1]'
        } elseif ($hostName.Contains(':') -and (-not $hostName.StartsWith('['))) {
            $hostName = "[$hostName]"
        }
        $S.Probe = "http://${hostName}:$portText"
    }

    # Waits up to $Seconds seconds for GET /api/health to answer 200.
    function Wait-Health([int] $Seconds) {
        for ($i = 0; $i -lt $Seconds; $i++) {
            $reply = Invoke-HttpGet -Url "$($S.Probe)/api/health" -TimeoutMs 5000 -NoRedirect $false -NoProxy $true
            if ($reply.Code -eq 200) { return $true }
            if ($S.TrialProc -and $S.TrialProc.HasExited) { return $false }
            Start-Sleep -Seconds 1
        }
        return $false
    }

    # After a healthy answer: the process that answered is ours, not a foreign program.
    function Test-OwnProcess {
        if ($S.Autostart -ne 'none') {
            for ($i = 0; $i -lt 10; $i++) {
                if (Get-NodeProcess) { return $true }
                Start-Sleep -Milliseconds 500
            }
            return $false
        }
        return [bool] ($S.TrialProc -and (-not $S.TrialProc.HasExited))
    }

    function Get-LogCommand {
        if ($S.Autostart -ne 'none') { return "Get-Content -Wait `"$($S.Root)\logs\urutau.out.log`"" }
        return (Join-Path $S.Staging 'trial.log')
    }

    function Get-StartCommand {
        return "& `"$($S.Root)\node\node.exe`" --env-file=`"$($S.Root)\urutau.env`" `"$($S.Root)\app\server\main.ts`""
    }

    function Get-UninstallCommand {
        $extra = ''
        if ($S.Root -ine (Get-DefaultRoot)) { $extra = "`$env:URUTAU_INSTALL_DIR = '" + (Format-PSSingleQuoted $S.Root) + "'; " }
        return "$extra`$env:URUTAU_UNINSTALL = '1'; irm $UninstallUrl | iex"
    }

    function Write-FirstRunNotice {
        $reply = Invoke-HttpGet -Url "$($S.Probe)/api/session" -TimeoutMs 5000 -NoRedirect $false -NoProxy $true
        # A failed request prints N1 as well; only a known "firstRun":false prints nothing.
        if ($reply.Body.Contains('"firstRun":false')) { return }
        $config = Join-Path $S.Root 'urutau.env'
        $public = Get-EnvValue $config 'PUBLIC_URL'
        $hostName = Get-EnvValue $config 'HOST'
        Say ''
        if ($public -and (-not (Test-HostLoopback $hostName))) {
            Say "Urutau is reachable from other computers at $public."
            Say 'Nobody has an account yet, and whoever opens it first becomes the admin.'
            Say "Open $public now and create the admin account. Use that address on"
            Say 'this computer too: Urutau refuses sign-ins that come from any other address.'
        } else {
            $url = if ($public) { $public } else { $S.Probe }
            Say "Open $url now to create the admin account."
        }
    }

    function Get-DatabaseLabel {
        $url = Get-EnvValue (Join-Path $S.Root 'urutau.env') 'DATABASE_URL'
        if ($url.StartsWith('sqlite:')) { return $url.Substring(7) }
        return 'set by DATABASE_URL in the configuration'
    }

    function Write-Summary([string] $SummaryVersion) {
        $public = Get-EnvValue (Join-Path $S.Root 'urutau.env') 'PUBLIC_URL'
        $url = if ($public) { $public } else { $S.Probe }
        Say ''
        if ($S.Autostart -ne 'none') {
            Say "Urutau $SummaryVersion is running at $url"
            Say ''
            Say "  Install directory  $($S.Root)"
            Say "  Configuration      $($S.Root)\urutau.env"
            Say "  Database           $(Get-DatabaseLabel)"
            Say "  Logs               $(Get-LogCommand)"
            Say '  Upgrade            run the install command again'
            Say "  Uninstall          $(Get-UninstallCommand)"
        } else {
            Say "Urutau $SummaryVersion is installed in $($S.Root). It is not registered as a service, and it is not running."
            Say 'Start it with:'
            Say "  $(Get-StartCommand)"
            Say ''
            Say "  Configuration      $($S.Root)\urutau.env"
            Say "  Database           $(Get-DatabaseLabel)"
            Say '  Upgrade            run the install command again'
            Say "  Uninstall          $(Get-UninstallCommand)"
        }
    }

    # ---- backup, swap and rollback -----------------------------------------------------------------

    # The SQLite database file the configuration at $ConfigPath points at, or '' when it is not
    # a SQLite file (or is the in-memory database). A relative path is taken from <root>\app.
    function Get-DatabasePath([string] $ConfigPath) {
        $url = Get-EnvValue $ConfigPath 'DATABASE_URL'
        if ((-not $url.StartsWith('sqlite:')) -or ($url -eq 'sqlite::memory:')) { return '' }
        $path = $url.Substring(7)
        if (-not (Test-AbsolutePath $path)) { $path = Join-Path (Join-Path $S.Root 'app') $path }
        return [IO.Path]::GetFullPath($path)
    }

    # Copies the SQLite database into backups\ when the old configuration points at one.
    # Sets DbBackupDir and DbPath.
    function Backup-Database {
        $config = Join-Path $S.Root 'urutau.env'
        $S.DbBackupDir = ''
        $S.DbPath = Get-DatabasePath $config
        if (-not $S.DbPath) {
            if (-not (Get-EnvValue $config 'DATABASE_URL').StartsWith('sqlite:')) {
                Say 'The database is not a SQLite file, so the installer does not back it up. Back it up yourself before upgrading.'
            }
            return
        }
        if (-not (Test-Path -LiteralPath $S.DbPath -PathType Leaf)) { return }
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd\THHmmss\Z', [Globalization.CultureInfo]::InvariantCulture)
        $base = Join-Path $S.Root "backups\urutau-$($S.M.Version)"
        $dir = "$base-$stamp"
        $n = 1
        while (Test-Path -LiteralPath $dir) { $n++; $dir = "$base-$stamp-$n" }
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        foreach ($file in @($S.DbPath, "$($S.DbPath)-wal", "$($S.DbPath)-shm")) {
            if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $dir -Force }
        }
        $S.DbBackupDir = $dir
        Say "Backed up the database to $dir."
        # Keep the three newest backup directories (greatest timestamp, then counter).
        $found = @()
        foreach ($entry in @(Get-ChildItem -LiteralPath (Join-Path $S.Root 'backups') -Directory -Filter 'urutau-*' -ErrorAction SilentlyContinue)) {
            if ($entry.Name -cmatch '^urutau-.+-([0-9]{8}T[0-9]{6}Z)(-([0-9]+))?$') {
                $counter = if ($Matches[3]) { [int] $Matches[3] } else { 1 }
                $found += [pscustomobject]@{ Key = ($Matches[1] + '_' + $counter.ToString('00000')); Path = $entry.FullName }
            }
        }
        $sorted = @($found | Sort-Object -Property Key)
        if ($sorted.Count -gt 3) {
            foreach ($old in $sorted[0..($sorted.Count - 4)]) { Remove-Tree $old.Path }
        }
    }

    function Invoke-Swap {
        $old = Join-Path $S.Staging 'old'
        Remove-Tree $old
        New-Item -ItemType Directory -Path $old -Force | Out-Null
        $S.AppSwapped = $false; $S.NodeSwapped = $false; $S.ConfigSwapped = $false
        if ($S.ReplaceApp) {
            if (Test-Path -LiteralPath (Join-Path $S.Root 'app')) { Move-Path (Join-Path $S.Root 'app') (Join-Path $old 'app') }
            Move-Path (Join-Path $S.Staging 'app') (Join-Path $S.Root 'app')
            $S.AppSwapped = $true
        }
        if ($S.NodeReplaced) {
            if (Test-Path -LiteralPath (Join-Path $S.Root 'node')) { Move-Path (Join-Path $S.Root 'node') (Join-Path $old 'node') }
            Move-Path (Join-Path $S.Staging 'node') (Join-Path $S.Root 'node')
            $S.NodeSwapped = $true
        }
        if ($S.ConfigChanged) {
            if (Test-Path -LiteralPath (Join-Path $S.Root 'urutau.env')) { Move-Path (Join-Path $S.Root 'urutau.env') (Join-Path $old 'urutau.env') }
            Move-Path (Join-Path $S.Staging 'urutau.env') (Join-Path $S.Root 'urutau.env')
            $S.ConfigSwapped = $true
        }
        $S.NodeDir = Join-Path $S.Root 'node'
    }

    # Puts the previous app, Node, configuration and database back, starts the old version
    # and ends the run with U3.
    function Invoke-Rollback {
        $oldVersion = $S.M.Version
        $old = Join-Path $S.Staging 'old'
        $failed = Join-Path $S.Staging 'failed'
        Stop-Server
        New-Item -ItemType Directory -Path $failed -Force | Out-Null
        if ($S.ConfigSwapped) {
            Remove-Tree (Join-Path $failed 'urutau.env')
            Move-Path (Join-Path $S.Root 'urutau.env') (Join-Path $failed 'urutau.env')
            Move-Path (Join-Path $old 'urutau.env') (Join-Path $S.Root 'urutau.env')
        }
        if ($S.AppSwapped) {
            Remove-Tree (Join-Path $failed 'app')
            Move-Path (Join-Path $S.Root 'app') (Join-Path $failed 'app')
            Move-Path (Join-Path $old 'app') (Join-Path $S.Root 'app')
        }
        if ($S.NodeSwapped) {
            Remove-Tree (Join-Path $failed 'node')
            Move-Path (Join-Path $S.Root 'node') (Join-Path $failed 'node')
            Move-Path (Join-Path $old 'node') (Join-Path $S.Root 'node')
        }
        if ($S.DbBackupDir) {
            foreach ($file in @($S.DbPath, "$($S.DbPath)-wal", "$($S.DbPath)-shm")) {
                Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            }
            foreach ($file in @(Get-ChildItem -LiteralPath $S.DbBackupDir -File)) {
                Copy-Item -LiteralPath $file.FullName -Destination (Split-Path -Parent $S.DbPath) -Force
            }
        }
        Set-ProbeUrl (Join-Path $S.Root 'urutau.env')
        if ($S.Autostart -ne 'none') { Restore-Firewall (Join-Path $S.Root 'urutau.env') }
        # The failed version's trial.log stays for the admin to read; the restored version
        # writes its own file.
        if ($S.Autostart -ne 'none') { Start-Server } else { Start-Trial -Name 'trial-restored' }
        if ((-not (Wait-Health 30)) -or (-not (Test-OwnProcess))) {
            Write-Warn "the restored version did not answer on $($S.Probe)/api/health within 30 seconds either. Logs: $(Get-LogCommand)"
        }
        # With no service the old version only proved it starts: it is not left running.
        if ($S.Autostart -eq 'none') { Stop-Trial }
        if ($S.Autostart -ne 'none') {
            $message = "error: Urutau $($S.NewVersion) did not answer on $($S.Probe)/api/health within 60 seconds.`n"
        } else {
            $message = "error: Urutau $($S.NewVersion) did not start: nothing answered on $($S.Probe)/api/health.`n"
        }
        if ($S.DbBackupDir) {
            $message += "The previous version, $oldVersion, was restored with its configuration and with its database as it was before the upgrade.`n"
        } else {
            $message += "The previous version, $oldVersion, was restored with its configuration.`n"
        }
        $message += "Logs: $(Get-LogCommand)`n"
        $message += 'Going back to an older version? A database that a newer version has migrated needs the steps in https://github.com/oshogun/urutau#downgrading-past-the-integrations'
        throw $message
    }

    # ---- install -----------------------------------------------------------------------------------

    function Invoke-InstallRun {
        $live = Join-Path $S.Root 'urutau.env'
        $newConfig = -not (Test-Path -LiteralPath $live)

        if ((Test-Path -LiteralPath $S.Root) -and (@(Get-ChildItem -LiteralPath $S.Root -Force -ErrorAction SilentlyContinue).Count -gt 0) -and (-not (Test-Path -LiteralPath (Join-Path $S.Root '.urutau-install')))) {
            Fail "$($S.Root) exists, is not empty, and is not an Urutau install. Choose another -InstallDir."
        }

        # Address decision every option first, then the question, then the
        # unattended default.
        # The port Urutau will listen on: -Port, else the one already in the configuration.
        $wantPort = $DefaultPort
        if ($Port) {
            $wantPort = [int] $Port
        } else {
            $configured = Get-EnvValue $live 'PORT'
            if ($configured -cmatch '^[0-9]+$') { $wantPort = [int] $configured }
        }
        $S.WantHost = ''; $S.WantPublicUrl = ''; $S.RemovePublicUrl = $false
        if ($PublicUrl) {
            $parsed = ConvertFrom-Address -Text $PublicUrl -PortNumber $wantPort -Mode 'flag'
            if ($parsed.Kind -ne 'url') { Fail ('-PublicUrl is not an address Urutau can use: ' + (Get-ReasonText -Reason $parsed.Reason -PortNumber $wantPort) + '.') }
            $S.WantPublicUrl = $parsed.Url
            $S.WantHost = if ($BindHost) { $BindHost } else { '0.0.0.0' }
        } elseif ($Local) {
            $S.WantHost = '127.0.0.1'
            $S.RemovePublicUrl = $true
        } elseif ($BindHost) {
            $S.WantHost = $BindHost
        } elseif ($newConfig) {
            if ((-not $Yes) -and (Test-Interactive)) {
                $answer = Read-Address -PortNumber $wantPort
                if ($answer.Kind -eq 'url') {
                    $S.WantPublicUrl = $answer.Url
                    $S.WantHost = '0.0.0.0'
                } else {
                    $S.WantHost = '127.0.0.1'
                }
            } else {
                $S.WantHost = '127.0.0.1'
                if ($Yes) {
                    Say "-Yes was given, so Urutau listens on this computer only (http://127.0.0.1:$wantPort)."
                } else {
                    Say "No terminal to answer on, so Urutau listens on this computer only (http://127.0.0.1:$wantPort)."
                }
                Say 'To open it to other computers, re-run with $env:URUTAU_PUBLIC_URL = ''<address>''.'
            }
        }
        if ($S.WantPublicUrl) { Write-UrlPortWarning -Url $S.WantPublicUrl -PortNumber $wantPort }

        New-Item -ItemType Directory -Path $S.Root -Force | Out-Null
        Set-RootAcl
        $lock = Join-Path $S.Root '.install.lock'
        try {
            New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
        } catch {
            Fail "another install or upgrade is running (lock: $lock). If none is, delete that directory and run again."
        }
        $S.LockHeld = $true
        $S.Staging = Join-Path $S.Root '.staging'
        New-Item -ItemType Directory -Path $S.Staging -Force | Out-Null
        Read-Marker
        if (-not $S.M.Have) {
            Write-Marker -State 'installing' -MarkerVersion '' -MarkerNode '' -MarkerAutostart '' -MarkerFirewall '0'
            Read-Marker
        }
        if ($NoService -and (($S.M.Autostart -eq 'task') -or ($S.M.Autostart -eq 'startup-folder')) -and ($S.M.State -eq 'installed')) {
            Fail 'this install is registered as a task. Uninstall it first, or run without -NoService.'
        }
        $oldHadApp = (Test-Path -LiteralPath (Join-Path $S.Root 'app\server\main.ts')) -and ($S.M.State -eq 'installed')

        # A re-run that only changes configuration options keeps the installed version and Node:
        # it looks up no release and downloads nothing, so it also works offline. Running the
        # installer again without options upgrades. A -Port counts only when it changes the port.
        $portChanges = $false
        if ($Port -and (([string] [int] $Port) -ne (Get-EnvValue $live 'PORT'))) { $portChanges = $true }
        $configOnly = $false
        if ($S.M.Have -and ($S.M.State -eq 'installed') -and $S.M.Version -and (-not $Version) -and (-not $Bundle) -and (-not $Force) `
            -and (Test-Path -LiteralPath (Join-Path $S.Root 'app\server\main.ts')) -and (Test-Path -LiteralPath (Join-Path $S.Root 'node\node.exe')) `
            -and ($PublicUrl -or $BindHost -or $AllowedHosts -or $portChanges -or $Local)) {
            $configOnly = $true
            Write-Info "Only configuration options were given, so Urutau $($S.M.Version) stays installed. Run the installer again without options to upgrade."
            $S.NodeReplaced = $false
            $S.NodeDir = Join-Path $S.Root 'node'
            $S.NodeVersion = $S.M.Node
        } else {
            Initialize-Node
        }

        # Version and bundle.
        $S.ReplaceApp = $true
        $S.Version = ''
        if ($configOnly) {
            $S.Version = $S.M.Version
        } elseif ($Bundle) {
            # The version is the bundle's own VERSION, known after extraction.
        } elseif ($Version) {
            $S.Version = $Version
        } else {
            Resolve-LatestVersion
        }
        if ((-not $Bundle) -and ($S.M.Version -eq $S.Version) -and (Test-Path -LiteralPath (Join-Path $S.Root 'app\server\main.ts')) -and (-not $Force) -and ($S.M.State -eq 'installed')) {
            $S.ReplaceApp = $false
        }
        if ($S.ReplaceApp) {
            Get-Bundle
            Install-Dependencies
            $checkApp = Join-Path $S.Staging 'app'
            $S.NewVersion = $S.Version
        } else {
            $checkApp = Join-Path $S.Root 'app'
            $S.NewVersion = $S.M.Version
        }

        Write-Helpers
        Merge-Config
        Set-ProbeUrl (Join-Path $S.Staging 'urutau.env')
        $hostNow = Get-EnvValue (Join-Path $S.Staging 'urutau.env') 'HOST'
        if (-not $hostNow) { $hostNow = '127.0.0.1' }
        $portNowText = Get-EnvValue (Join-Path $S.Staging 'urutau.env') 'PORT'
        if (-not $portNowText) { $portNowText = [string] $DefaultPort }

        # The new version checks the configuration before anything is stopped.
        $check = Invoke-Native -File (Get-NodeExe) -ArgList @("--env-file=$(Join-Path $S.Staging 'urutau.env')", (Join-Path $S.Staging 'check-config.mjs'), $checkApp)
        if ($check.ExitCode -ne 0) {
            $first = (($check.Err + "`n" + $check.Out) -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -First 1)
            if ($null -eq $first) { $first = 'the configuration could not be checked' }
            if ($first.StartsWith('urutau-install: ')) { $first = $first.Substring(16) }
            Fail "the configuration in $live is not valid for Urutau $($S.NewVersion): $first. Nothing was changed."
        }

        $S.Autostart = if ($NoService) { 'none' } else { 'task' }

        # The port must be free when nothing of ours holds it: a new configuration, an install
        # that was not running, a changed port, or no service (the trial start needs it).
        $oldPort = Get-EnvValue $live 'PORT'
        if (-not $oldPort) { $oldPort = [string] $DefaultPort }
        $checkPort = $newConfig -or ($S.M.State -ne 'installed') -or ($S.Autostart -eq 'none') -or ($S.M.Autostart -eq 'none') -or ($portNowText -ne $oldPort)
        if ($checkPort) {
            if (-not (Test-PortFree -HostName $hostNow -PortNumber ([int] $portNowText))) {
                Fail "port $portNowText on $hostNow is in use by another program. Nothing was changed. Re-run with -Port N."
            }
        }

        $definitionPresent = ($S.Autostart -eq 'none') -or ((Test-Path -LiteralPath (Get-ServiceScriptPath)) -and ((Test-TaskRegistered) -or (Test-Path -LiteralPath (Get-StartupShortcutPath))))
        $sameAutostart = if ($S.Autostart -eq 'none') { $S.M.Autostart -eq 'none' } else { ($S.M.Autostart -eq 'task') -or ($S.M.Autostart -eq 'startup-folder') }
        $firewallOk = $true
        if ($S.Autostart -ne 'none') {
            $firewallOk = (Test-HostLoopback $hostNow) -eq (-not (Test-FirewallRule))
        }
        if ((-not $S.ReplaceApp) -and (-not $S.NodeReplaced) -and (-not $S.ConfigChanged) -and ($S.M.State -eq 'installed') -and $sameAutostart -and $definitionPresent -and $firewallOk) {
            Say "Urutau $($S.M.Version) is already installed in $($S.Root), with this configuration. Nothing to do."
            $S.Autostart = $S.M.Autostart
            Set-ProbeUrl $live
            Remove-Tree $S.Staging
            Write-Summary $S.M.Version
            return
        }

        # Nothing above changed anything a running install uses. From here on it does.
        if ($S.ReplaceApp -or $S.NodeReplaced) {
            if ($oldHadApp) {
                $dbNow = Get-DatabasePath $live
                $appDir = (Join-Path $S.Root 'app').TrimEnd('\') + '\'
                if ($dbNow -and $dbNow.StartsWith($appDir, [StringComparison]::OrdinalIgnoreCase)) {
                    Fail "the database is inside $($S.Root)\app, which this upgrade replaces. Move it, and set DATABASE_URL, first. Nothing was changed."
                }
            }
        }
        $S.DbBackupDir = ''
        $S.DbPath = ''
        Stop-Server
        if ($oldHadApp -and ($S.ReplaceApp -or $S.NodeReplaced)) { Backup-Database }
        Invoke-Swap
        New-Item -ItemType Directory -Path (Join-Path $S.Root 'data') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $S.Root 'logs') -Force | Out-Null
        if ($S.Autostart -ne 'none') { Register-Autostart }
        # The service definition is recorded before the start, so an uninstall can remove what a
        # failed fresh install left registered.
        $firewallMarker = Get-FirewallMarkerValue
        if ($oldHadApp) {
            Write-Marker -State 'installed' -MarkerVersion $S.M.Version -MarkerNode $S.M.Node -MarkerAutostart $S.Autostart -MarkerFirewall $firewallMarker
        } else {
            Write-Marker -State 'installing' -MarkerVersion '' -MarkerNode '' -MarkerAutostart $S.Autostart -MarkerFirewall $firewallMarker
        }
        Start-Server

        if ((Wait-Health 60) -and (Test-OwnProcess)) {
            # Healthy.
        } elseif ($oldHadApp) {
            Show-TrialLog
            Invoke-Rollback
        } else {
            $logs = Get-LogCommand
            Show-TrialLog
            Stop-Server
            if ($S.Autostart -ne 'none') {
                Fail "Urutau $($S.NewVersion) did not answer on $($S.Probe)/api/health within 60 seconds. It is left installed so you can read its logs: $logs"
            }
            Fail "Urutau $($S.NewVersion) did not start: nothing answered on $($S.Probe)/api/health. It is left installed so you can read its logs: $logs"
        }

        $S.M.Version = $S.NewVersion
        Write-Marker -State 'installed' -MarkerVersion $S.NewVersion -MarkerNode $S.NodeVersion -MarkerAutostart $S.Autostart -MarkerFirewall (Get-FirewallMarkerValue)
        Write-FirstRunNotice
        if ($S.Autostart -eq 'none') { Stop-Trial }
        Remove-Tree $S.Staging
        Write-Summary $S.NewVersion
    }

    # ---- uninstall and purge -----------------------------------------------------------------------

    function Invoke-UninstallRun {
        if (-not (Test-Path -LiteralPath (Join-Path $S.Root '.urutau-install'))) {
            Fail "$($S.Root) is not an Urutau install: there is no .urutau-install file there."
        }
        $lock = Join-Path $S.Root '.install.lock'
        try {
            New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
        } catch {
            Fail "another install or upgrade is running (lock: $lock). If none is, delete that directory and run again."
        }
        $S.LockHeld = $true
        Read-Marker
        if ($S.M.State -ne 'uninstalled') {
            # What is removed comes from the marker, not from the options of this run.
            if (($S.M.Autostart -eq 'task') -or ($S.M.Autostart -eq 'startup-folder')) {
                $S.Autostart = $S.M.Autostart
                try {
                    Stop-UrutauService
                    $stillThere = Test-TaskRegistered
                    if ($stillThere) {
                        try { Unregister-ScheduledTask -TaskName 'Urutau' -Confirm:$false -ErrorAction Stop } catch { Write-Warn "Unregister-ScheduledTask -TaskName 'Urutau' failed: $($_.Exception.Message)" }
                    }
                    $shortcut = Get-StartupShortcutPath
                    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
                } catch {
                    Write-Warn "could not remove part of the service: $($_.Exception.Message)"
                }
                $taskLeft = Test-TaskRegistered
                $ruleLeft = ($S.M.Firewall -eq '1') -and (Test-FirewallRule)
                if ($taskLeft -or $ruleLeft) {
                    $commands = @()
                    if ($ruleLeft) { $commands += (Get-FirewallRemoveCommand) }
                    if ($taskLeft) { $commands += "Unregister-ScheduledTask -TaskName 'Urutau' -Confirm:`$false -ErrorAction SilentlyContinue" }
                    if (Test-Elevated) {
                        try {
                            if ($ruleLeft) { Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue }
                            if ($taskLeft) { Unregister-ScheduledTask -TaskName 'Urutau' -Confirm:$false -ErrorAction SilentlyContinue }
                        } catch {
                            Write-Warn "an administrator step failed: $($_.Exception.Message)"
                        }
                    } elseif (-not $NoElevate) {
                        try { [void] (Invoke-Elevated -Command ($commands -join '; ')) } catch { Write-Warn "the administrator prompt did not run: $($_.Exception.Message)" }
                    } else {
                        Write-Warn '-NoElevate was given, so these steps were not done. To finish removing the service, run this in a PowerShell window opened as administrator:'
                        foreach ($command in $commands) { Write-Host "  $command" }
                    }
                }
            }
            foreach ($name in @('app', 'node', 'bin', 'run', '.staging')) {
                Remove-Tree (Join-Path $S.Root $name)
            }
            Write-Marker -State 'uninstalled' -MarkerVersion $S.M.Version -MarkerNode $S.M.Node -MarkerAutostart 'none' -MarkerFirewall '0'
        }
        Remove-Item -LiteralPath $lock -Force -Recurse -ErrorAction SilentlyContinue
        $S.LockHeld = $false
        Say "Removed the Urutau service and application from $($S.Root)."
        Say 'Kept: urutau.env, data/, backups/, logs/. Installing again in the same directory reuses them.'

        if ($Purge) {
            if (-not $Yes) {
                if (Test-Interactive) {
                    Write-Host -NoNewline "Type `"purge`" to delete $($S.Root), including the database and its backups: "
                    $answer = Read-Host
                    if ($answer -cne 'purge') { Fail 'purge cancelled.' }
                } else {
                    Fail '-Purge without a terminal needs -Yes.'
                }
            }
            Remove-Tree $S.Root
            Say "Purged $($S.Root)."
        }
    }

    # ---- main body ---------------------------------------------------------------------------------

    if ($Help) {
        Show-Usage
        return
    }

    if ($UrutauBound.ContainsKey('InstallDir') -and [string]::IsNullOrWhiteSpace($InstallDir)) { Fail '-InstallDir needs a value' }
    if ((-not $UrutauBound.ContainsKey('InstallDir')) -and (Test-Path -LiteralPath 'Env:URUTAU_INSTALL_DIR') -and [string]::IsNullOrWhiteSpace($env:URUTAU_INSTALL_DIR)) { Fail 'URUTAU_INSTALL_DIR is set but empty.' }
    if ($Purge -and (-not $Uninstall)) { Fail '-Purge needs -Uninstall.' }
    if ($Local -and ($PublicUrl -or $BindHost)) { Fail '-Local cannot be combined with -PublicUrl or -BindHost.' }
    if ($Port) {
        if (($Port -cnotmatch '^[0-9]+$') -or ($Port.Length -gt 5) -or ([int] $Port -lt 1024) -or ([int] $Port -gt 65535)) {
            Fail '-Port must be a number from 1024 to 65535'
        }
    }
    if ($Version) {
        if ($Version.StartsWith('v')) { $Version = $Version.Substring(1) }
        if ($Version -cnotmatch $VersionRe) { Fail "-Version must look like X.Y.Z or X.Y.Z-PRERELEASE: $Version" }
        if (Test-NoBundleVersion $Version) {
            Fail "Urutau $Version has no installer bundle. Releases v0.1.0 to v0.5.0 were published before the installers existed. Run $Version with Docker (ghcr.io/oshogun/urutau:$Version) or from a source checkout."
        }
    }
    if ($PublicUrl) { Assert-PlainValue '-PublicUrl' $PublicUrl }
    if ($AllowedHosts) { Assert-PlainValue '-AllowedHosts' $AllowedHosts }
    if ($BindHost) { Assert-PlainValue '-BindHost' $BindHost }

    if ($env:OS -ne 'Windows_NT') { Fail 'this installer is for Windows. Use install.sh on Linux.' }
    $S.Arch = Get-NodeArch
    $S.Root = Resolve-Root
    if ($Bundle) {
        if ($Bundle -cmatch '^https?://') { $S.BundlePath = '' } else { $S.BundlePath = Resolve-UserPath $Bundle }
    }

    try {
        if ($Uninstall) { Invoke-UninstallRun } else { Invoke-InstallRun }
    } finally {
        # Runs on every way the script ends: stops a trial server this run started and
        # releases the lock, so a run that ends with an error never blocks the next one.
        Stop-Trial
        if ($S.LockHeld) {
            Remove-Item -LiteralPath (Join-Path $S.Root '.install.lock') -Force -Recurse -ErrorAction SilentlyContinue
        }
    }
}

Install-Urutau
