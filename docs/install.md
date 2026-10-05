# Installing a release

`packaging/install.sh` (Linux) and `packaging/install.ps1` (Windows) install a
packaged release without a checkout, a build or a system Node. Each release
from the first packaged one on carries both scripts and the server bundle as
assets (see [release.md](release.md#the-release-bundle)).

The releases with no bundle are v0.1.0 to v0.5.0. The first release with one is
the next release after v0.5.0. Until it exists, the installers have nothing to
install: they print that the release has no bundle and exit with status 1, and
the Docker image or a source checkout is the way to run Urutau (see the
[README](../README.md#deploying)).

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.ps1 | iex
```

For a pinned install, download `install.sh` or `install.ps1` from the Release
you want and run it. A prerelease is installed only when you name it:

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash -s -- --version 1.2.0-beta.1
```

```powershell
$env:URUTAU_VERSION = '1.2.0-beta.1'; irm https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.ps1 | iex
```

## Supported platforms

| Platform | Status |
| --- | --- |
| Linux x64, glibc 2.28 or later | Supported (`install.sh`). Tested in CI on Ubuntu with a systemd user service. |
| Windows 10 and 11 x64 | Supported (`install.ps1`, Windows PowerShell 5.1 or later). Tested in CI on `windows-latest`. |
| Linux arm64 and Windows arm64 | Expected to work, not tested on arm64 hardware. |
| macOS | Not supported by the installer. Use the Docker image `ghcr.io/oshogun/urutau`. |
| Linux with musl, such as Alpine | Not supported by the installer: the official Node binaries need glibc. Use the Docker image. |

Both installers are per user. They never use `sudo`, and `install.sh` refuses to
run under sudo. The one step that needs administrator rights is the Windows
firewall rule (see "Where things go").

## What it does

1. Downloads the latest Node 24 from nodejs.org into `<root>/node`, checked
   against `SHASUMS256.txt`. The system Node is never used or changed.
2. Resolves the latest release (or `--version`), downloads
   `urutau-server-X.Y.Z.tar.gz`, checks it against its `.sha256`, and runs
   `npm ci --omit=dev` in it. That installs the optional `pg` and `mysql2`
   drivers too.
3. Writes `<root>/urutau.env` on a new install: `HOST`, `PORT`,
   `DATABASE_URL` (a SQLite file in `<root>/data`), `TOKEN_ENCRYPTION_KEY` and,
   when you open Urutau to other computers, `PUBLIC_URL`.
   `TOKEN_ENCRYPTION_KEY` is generated once, 32 random bytes in base64, and is
   never printed. An upgrade never replaces it, because a new key would make the
   stored agent integration GitHub tokens unreadable. Back up `urutau.env`
   separately from the database: the database alone cannot decrypt those
   tokens. The installer keeps any lines you add by hand, such as `TRUST_PROXY`
   and the `KEYCLOAK_*` variables.
4. Checks the new configuration against the new version's own `loadConfig`
   before anything is stopped, so a value the server would refuse never takes
   the running server down.
5. Registers a service (below), starts it, waits until `/api/health` answers,
   and prints the address. While nobody has an account, it prints a reminder to
   create the admin account.

### The address question

Whoever opens a new Urutau first creates the admin account, so the installer
asks which address people will open. It asks only on a new install, in an
interactive run, and reads the terminal even under `curl | bash`.

- Press Enter for this computer only: `HOST=127.0.0.1`, no `PUBLIC_URL`.
- Type an address, such as `192.168.1.20` or `http://urutau.lan:8787`:
  `PUBLIC_URL` is set to it and `HOST=0.0.0.0`.

An unattended install (no terminal, or `--yes`) never waits and defaults to
this computer only. It prints how to open it to other computers. Nobody has an
account yet, so whoever opens the address first creates the admin; with the
default of this computer only, that is someone on this computer.

The address can be changed later with a configuration-only re-run, which needs
no network: it keeps the installed version and Node, downloads nothing and
changes only the options you pass.

```bash
curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash -s -- --public-url http://192.168.1.20:8787
curl -fsSL https://raw.githubusercontent.com/oshogun/urutau/main/packaging/install.sh | bash -s -- --local
```

With `PUBLIC_URL` set, the server refuses sign-ins and first-run requests from
any other address, so open Urutau at that address on this computer too.

## Where things go

| | Linux | Windows |
| --- | --- | --- |
| Default root | `${XDG_DATA_HOME:-$HOME/.local/share}/urutau` | `%LOCALAPPDATA%\Urutau` |
| Service | systemd user unit `urutau.service`; linger is enabled so it starts at boot, not only at login (`--no-linger` skips that) | Scheduled Task `\Urutau` at logon, running a hidden supervisor that restarts the server when it exits; a Startup-folder shortcut `Urutau.lnk` when the task cannot be registered |
| Logs | `journalctl --user -u urutau -f` | `<root>\logs\urutau.out.log` and `urutau.err.log` |
| Firewall | none | rule `UrutauServer-In` (Private networks, `<root>\node\node.exe`, the port), only when `HOST` is not loopback |

The unit is `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/urutau.service`.

Inside the root:

| Path | What |
| --- | --- |
| `app/` | the bundle plus `node_modules/`; replaced on upgrade |
| `node/` | the private Node 24; replaced when its version changes |
| `urutau.env` | the configuration; the installer and you both edit it |
| `data/urutau.db` (and `-wal`, `-shm`) | the SQLite database |
| `backups/urutau-<from>-<UTC>/` | copies of the database taken before an upgrade; the three newest are kept |
| `.urutau-install` | marker the installer reads to find what it installed |
| `bin/`, `run/` | Windows only: the supervisor script and its process ids |

The Windows root's permissions are restricted to your account and SYSTEM. The
firewall rule is the only step that needs administrator rights, and it is shared
with the task registration when that needs it too. One UAC prompt covers both. If
you decline, or pass `-NoElevate`, the installer prints the administrator
commands, and Urutau still works on `127.0.0.1`. It also warns when the network
is classified Public, because the rule covers Private networks only.

## Options

Each option has a flag (`install.sh`), a parameter (`install.ps1`) and a
`URUTAU_*` variable. The variable is the only way to pass an option through
`irm | iex`; with `curl | bash` use either the variable or `bash -s -- <flags>`.
Boolean variables take effect only when set to `1`. A flag wins over its
variable, then comes the existing configuration, then the default.

| install.sh | install.ps1 | Variable | Meaning |
| --- | --- | --- | --- |
| `--version X.Y.Z` | `-Version` | `URUTAU_VERSION` | Install this release instead of the latest; a leading `v` is accepted. A prerelease is installed only when named here |
| `--bundle PATH_OR_URL` | `-Bundle` | `URUTAU_BUNDLE` | Install from this bundle; no release lookup. A relative path is taken from the current directory |
| `--install-dir DIR` | `-InstallDir` | `URUTAU_INSTALL_DIR` | Install root |
| `--port N` | `-Port` | `URUTAU_PORT` | `PORT`, 1024 to 65535 (default 8787, or the existing value) |
| `--public-url URL` | `-PublicUrl` | `URUTAU_PUBLIC_URL` | Open Urutau to other computers at this address: sets `PUBLIC_URL`, and `HOST=0.0.0.0` unless `--bind-host` is given. Skips the question |
| `--local` | `-Local` | `URUTAU_LOCAL=1` | This computer only: `HOST=127.0.0.1`, removes `PUBLIC_URL`, and on Windows removes the firewall rule. Skips the question |
| `--bind-host ADDR` | `-BindHost` | `URUTAU_BIND_HOST` | `HOST` itself, for one interface or a proxy on the same machine. Skips the question |
| `--allowed-hosts a,b` | `-AllowedHosts` | `URUTAU_ALLOWED_HOSTS` | `ALLOWED_HOSTS` |
| `--no-service` | `-NoService` | `URUTAU_NO_SERVICE=1` | Register no service; check the install with a trial start |
| `--force` | `-Force` | `URUTAU_FORCE=1` | Replace the app even when that version is installed |
| `--uninstall` | `-Uninstall` | `URUTAU_UNINSTALL=1` | Remove the service and the app; keep the configuration and data |
| `--purge` | `-Purge` | `URUTAU_PURGE=1` | With uninstall: delete the whole root |
| `--yes` | `-Yes` | `URUTAU_YES=1` | Ask nothing: the address defaults to this computer only, and purge needs no typed confirmation |
| `--no-linger` | none | `URUTAU_NO_LINGER=1` | Linux: do not enable linger |
| none | `-NoElevate` | `URUTAU_NO_ELEVATE=1` | Windows: never show a UAC prompt (no firewall rule; autostart may use the Startup folder) |
| `--help` | `-Help` | none | Print the options and exit |

## Upgrading

Run the installer again. Before it stops the running server it downloads and
checks the new release, builds the new configuration, checks it with the new
version and checks the port. If any of that fails, the old server keeps running
unchanged.

Then it stops the service, copies the SQLite database (and its `-wal` and `-shm`
files) to `backups/`, swaps the app, and starts the new version. A database that
is not SQLite is not copied; back it up yourself. If the new version does not
answer `/api/health`, the installer restores the previous app, Node,
configuration and database, restarts the old version, and exits with the logs
command. There is no version-ordering check: `--version` with an older number
installs it, and if that build refuses the migrated database it is rolled back
the same way. Going back deliberately needs the steps in the
[README](../README.md#downgrading-past-the-integrations).

A re-run with no options and nothing newer to install changes nothing.

## Uninstalling

`--uninstall` (`-Uninstall`) removes the service, the firewall rule and the app
files. It keeps `urutau.env`, `data/`, `backups/`, `logs/` and the marker, so a
later install in the same root reuses the key and the database. Adding `--purge`
(`-Purge`) deletes the whole root after you type `purge`, or with `--yes`.
`--purge` without a terminal and without `--yes` exits with status 1.

## Versions with no bundle

v0.1.0 to v0.5.0 have no bundle. Asking for one with `--version` prints that
the release has no bundle and exits 1 before any download. When the latest
release is one of them, the installer says so and exits 1. Any other version
whose bundle answers 404 gets a similar message. The first packaged release is
the first one whose assets include `urutau-server-X.Y.Z.tar.gz`.

## What was tested

CI runs both installers on every pull request, on Ubuntu and `windows-latest`
(Windows PowerShell 5.1), against a locally served copy of the release layout:

- an unattended install through the pipe, with no terminal, which listens on
  `127.0.0.1` and prints that it did;
- an upgrade that opens Urutau to a network address;
- an upgrade whose new bundle does not start, which rolls back to the old version;
- uninstall (configuration and data kept) and purge;
- Linux: the systemd user service was active and enabled after the install and
  after a rollback, with linger on, and gone after the uninstall;
- Windows: the Scheduled Task autostart, the root's permissions limited to the
  account and SYSTEM, the firewall rule `UrutauServer-In` created on the upgrade
  to a network address (with the Public-network warning) and removed on uninstall.

macOS and arm64 are not tested.

## Testing the installer

These variables point the installers at a local copy of GitHub and nodejs.org.
CI uses them; they are not for normal use.

| Variable | Default |
| --- | --- |
| `URUTAU_API_URL` | `https://api.github.com/repos/oshogun/urutau/releases/latest` |
| `URUTAU_RELEASE_BASE_URL` | `https://github.com/oshogun/urutau/releases/download` |
| `URUTAU_NODE_DIST_URL` | `https://nodejs.org/dist` |
