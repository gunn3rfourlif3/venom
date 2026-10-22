<#
  Pull encrypted Xnith backups from the VPS to this machine.

  Run by Task Scheduler, daily, after the server's nightly dump. The server
  never pushes: this machine reaches out, which means no SSH server here, no
  port forwarded from the internet, and no credential for this network stored
  on a box that faces it.

  What it fetches is already encrypted to an age public key. The matching
  PRIVATE key is the only thing that can open it, and it lives here, not on
  the server.

  ----------------------------------------------------------------------------
  IF YOU LOSE THE PRIVATE KEY, EVERY BACKUP IS SCRAP.
  Not difficult to recover. Impossible. Keep a second copy somewhere that is
  not this machine - a password manager entry or a printed copy in a drawer -
  because a disk failure here must not take both the key and the copies.
  ----------------------------------------------------------------------------

  Usage:
    .\pull-backups.ps1
    .\pull-backups.ps1 -Dest 'D:\xnith-backups' -KeepDays 60
#>

param(
  [string] $VpsHost  = 'deploy@xnith.zaaka.io',
  [string] $Remote   = '/home/deploy/xnith/backups',
  [string] $Dest     = "$env:USERPROFILE\xnith-backups",
  [string] $KeyFile  = "$env:USERPROFILE\.ssh\id_ed25519",
  [int]    $KeepDays = 60
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "$(Get-Date -Format 'HH:mm:ss')  $m" }

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }

# --- what is on the server -------------------------------------------------
# Name and size together, so arrival can be checked against the source rather
# than assumed from a zero exit code.
# 2>&1 rather than 2>file: PowerShell wraps a native command's stderr into
# ErrorRecord objects on its own error stream, so redirecting to a file left
# it empty and the script reported "could not reach" with no reason attached
# — failing in exactly the way it was written to avoid.
# `|| true` matters more than it looks. The previous version ran stat over a
# glob and let its exit code stand, so an EMPTY backups directory - the normal
# state before AGE_RECIPIENT is configured - came back as non-zero with its
# stderr sent to /dev/null, and the script reported it as "could not reach the
# server". A working connection diagnosed as a dead one, because the exit code
# of the remote command was read as the health of the transport.
#
# find -printf gives basename and size directly, so nothing has to be parsed
# out of a path.
$raw = & ssh -i $KeyFile -o BatchMode=yes -o ConnectTimeout=20 $VpsHost `
  "find '$Remote' -maxdepth 1 -name '*.dump.gz.age' -printf '%f %s\n' 2>/dev/null || true" 2>&1
$sshExit = $LASTEXITCODE

$errText = ($raw | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
            ForEach-Object { $_.ToString() }) -join "`n"
$listing = $raw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }
$global:LASTEXITCODE = $sshExit

if ($LASTEXITCODE -ne 0) {
  # BatchMode turns the interactive "do you trust this host?" prompt into an
  # opaque non-zero exit. Reporting that as a key problem sends you to look
  # at the wrong file entirely, so the three causes are separated here.
  if ($errText -match 'Host key verification failed|No ED25519 host key is known') {
    throw @"
The server's host key is not known under the name '$VpsHost'.

This is NOT a problem with $KeyFile. You have almost certainly SSH'd to this
machine by IP before, and known_hosts is keyed by name - so the same server
under a new name looks like a stranger.

Verify it is the same machine before trusting it:

  ssh-keyscan -t ed25519 $($VpsHost.Split('@')[-1]) 2>`$null | ssh-keygen -lf -
  ssh-keygen -lF <the-IP-you-used-before>

If the fingerprints match, add it:

  ssh-keyscan -t ed25519 $($VpsHost.Split('@')[-1]) >> `$env:USERPROFILE\.ssh\known_hosts
"@
  }
  if ($errText -match 'Permission denied|publickey') {
    throw "The server refused the key at $KeyFile. Check that its public half is in deploy's authorized_keys on the VPS."
  }
  throw "Could not reach $VpsHost.`n$errText"
}
if (-not $listing) {
  throw "No encrypted backups on the server. Check that AGE_RECIPIENT is set in the backup environment - without it backup.sh takes a dump and stops."
}

$remoteFiles = @{}
foreach ($line in $listing) {
  if ($line -match '^(\S+)\s+(\d+)$') {
    $remoteFiles[[System.IO.Path]::GetFileName($matches[1])] = [int64]$matches[2]
  }
}
Say "server has $($remoteFiles.Count) encrypted backup(s)"

# --- fetch what is missing or wrong-sized ----------------------------------
$fetched = 0; $skipped = 0; $bad = @()
foreach ($name in $remoteFiles.Keys) {
  $want  = $remoteFiles[$name]
  $local = Join-Path $Dest $name

  # A local file of exactly the right size is taken as already pulled. A
  # partial one from an interrupted run has the wrong size and is re-fetched
  # rather than left in place looking finished.
  if ((Test-Path $local) -and ((Get-Item $local).Length -eq $want)) { $skipped++; continue }

  Say "fetching $name ($([math]::Round($want/1KB)) KB)"
  & scp -i $KeyFile -o BatchMode=yes -q "${VpsHost}:$Remote/$name" $local
  if ($LASTEXITCODE -ne 0) { $bad += "$name (scp failed)"; continue }

  $got = (Get-Item $local).Length
  if ($got -ne $want) { $bad += "$name (got $got, expected $want)"; continue }

  # Confirm it is an age file and not, say, an SSH error message written into
  # the file. Three times on this project a transfer reported success and
  # delivered something else (G33, G37, G39).
  #
  # Read 22 bytes from a stream rather than slicing ReadAllBytes: that pulls
  # the whole file into memory to look at the header, and the range operator
  # yields Object[] rather than byte[], which throws outright on a file
  # shorter than the slice - exactly the truncated case worth detecting.
  $head = New-Object byte[] 22
  $fs = [System.IO.File]::OpenRead($local)
  try { $read = $fs.Read($head, 0, 22) } finally { $fs.Dispose() }
  if ($read -lt 22 -or
      -not [System.Text.Encoding]::ASCII.GetString($head, 0, $read).StartsWith('age-encryption.org')) {
    $bad += "$name (not an age file)"
    continue
  }
  $fetched++
}

# --- local retention -------------------------------------------------------
Get-ChildItem $Dest -Filter '*.dump.gz.age' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
  Remove-Item -Force

$held = (Get-ChildItem $Dest -Filter '*.dump.gz.age' | Measure-Object).Count
Say "fetched $fetched, already had $skipped, holding $held"

if ($bad.Count -gt 0) {
  $bad | ForEach-Object { Write-Warning $_ }
  throw "$($bad.Count) backup(s) did not arrive intact."
}

# --- the check that actually matters ---------------------------------------
# Having the files is not the same as being able to open them. Nothing here
# decrypts (the private key is not this script's business), but an age file
# that is zero bytes or the wrong shape is caught above, and the newest
# copy's age is reported so a silently stalled server is visible.
$newest = Get-ChildItem $Dest -Filter '*.dump.gz.age' |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
  $hours = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalHours)
  Say "newest copy is $hours hour(s) old: $($newest.Name)"
  if ($hours -gt 48) {
    Write-Warning "The newest backup is over two days old. The nightly job on the server may have stopped."
  }
}
