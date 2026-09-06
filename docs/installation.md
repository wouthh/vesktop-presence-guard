# Installation, updates and rollback

This is a plugin for an existing maintained custom Vencord build. Inspect the
actual Vesktop package, both profiles, build sources, other userplugins and
launcher before changing anything. Preserve them. The first supported deployment
uses Linux GNOME and a Flatpak with an existing read-only Vencord-directory grant.
If that grant or the host GJS/Mutter interfaces are absent, report display support
as unavailable; do not broaden sandbox permissions as a shortcut.

The installer deliberately consumes an **owner-only, external JSON descriptor**.
Keep this local. Required absolute-path fields are `vencordRoot`, `mainProfile`,
`altProfile`, `mainLauncher`, `updater`, `updaterLock`, and `ledger`.
Installation also requires `updaterPending`, the absolute path to the maintained
updater's private `pending.json`. The two profiles must differ and main `state.json` must already reference the maintained
`dist` location. The supported main launcher ends in its existing `exec`
Mullvad-excluded Flatpak invocation; unexpected launchers are rejected intact.

Before the first installation, the private ledger's `backups` directory must
contain `main-launcher`, `updater`, and `main-plugins` (the original main Vencord
settings JSON). Also back up both profiles' state/settings and the Alt launcher.
Before modifying executables, record their original numeric Unix modes in
`backups/executable-modes.json`, with keys `main-launcher` and `updater` (for
example, 448 represents mode 0700). The baseline authenticates this file and
restores those modes; private backup copies may themselves stay mode 0600.
This first implementation has no previously released installation format.
Intermediate, unmerged development receipts are not a supported upgrade source;
do not rewrite authenticated metadata or guess missing original modes to bypass
a failure. Preserve it and use independently verified recovery evidence.
The existing private updater needs a reviewed extension to include the exact
PresenceGuard staging manifest, verify its hashes against canonical source,
recheck candidate bundle hashes at activation, preserve its source alongside
all existing custom plugins, and protect the release named in
`.presence-guard/baseline.json` from retention pruning. Record its installed SHA256
in the required `installed-updater.sha256` receipt in the ledger; an original
unextended updater is not accepted as a substitute. This project does not publish or
replace private updaters. The adapter's supported commands are `rebuild` and
`activate`, using the existing lock and retained-release workflow. It must support
the reviewed Linux descriptor handoff: validate `PRESENCE_GUARD_LOCK_FD=4` against
the actual lock file and a held exclusive flock before retaining that descriptor
instead of acquiring a second lock. A caller-supplied flag alone is insufficient.
The installer holds the lock across verification, staging, updater execution and
activation wiring, and executes the verified open file through descriptor 3.

```sh
node scripts/install.mjs inspect --config "$PG_CONFIG"
node scripts/install.mjs stage --config "$PG_CONFIG" --dry-run
node scripts/install.mjs prepare --config "$PG_CONFIG"
node scripts/install.mjs install --config "$PG_CONFIG" --dry-run
```

`PG_CONFIG` names your private descriptor. `stage` copies only plugin-owned source,
writes commit/upstream/file fingerprints, preserves other userplugin directories,
and rejects changed or unowned staging trees. A separate receipt in the Vencord
Git metadata pins the previous marker before any replacement; editing both source
and its colocated marker cannot silently authorize deletion. Marker and receipt
reads reject symlinks, FIFOs and oversized files without blocking.
Receipt writability is checked before replacing the old staging tree.
A replacement is built and synced in a hidden sibling directory before changing
the old tree. A bounded recovery record in Git metadata preserves both generations
until the new tree and receipt are committed. A normal locked retry validates and
recovers an interrupted transaction; a dry run reports recovery is required.
Unexpected changes stop recovery without deleting them. An interrupted cleanup
can leave hidden generated directories for later inspection; never remove
unexplained directories to bypass a receipt failure. Legacy staging can
be attested only when it matches current canonical source exactly. `prepare`
checks updater provenance and executable modes before staging
(including dry runs). Preparation and updater invocation share one held lock;
the updater inherits that lock and the verified executable descriptor.
It builds an isolated candidate without activation.
The canonical project gate and the full combined Vencord checks must pass first.
Commit all source changes before installation; dirty or mismatched heads fail.
Installation compiles the helper from Git blobs of the recorded commit in an
isolated snapshot, rejects compiler inputs outside that snapshot, and records its
hash; ignored build artifacts are never installed as trusted input. Launcher and
helper configuration and the installation receipt target are checked before
candidate activation. Unexpected directories, symlinks and read-only receipt
targets stop the operation before integration changes.
An installation receipt also requires its recorded helper and configuration to
remain present; updates do not silently recreate missing installed artifacts.
Orphaned helper configuration and unsafe helper log, lease, history, diagnostics
and snapshot targets are also rejected. Without an installation receipt those
runtime files must be absent, even if they are regular and writable. Installed
launcher and updater receipts are mandatory for updates. A first install forces observation on
and both rules off, even if a stale settings entry exists; verified updates keep
the existing rule preferences.

Immediately before restart, verify **neither profile has a call or capture**.
If reliable client inspection is unavailable, obtain an explicit no-call/capture
confirmation. Neither process presence nor idle audio proves it. Quit the two
identified profiles gracefully using their normal Quit action, then run:

```sh
node scripts/install.mjs install --config "$PG_CONFIG"
```

The script refuses to mutate integration while any identified Vesktop main
process is running. It pins and hashes the previous retained release, activates
the validated candidate, verifies its plugin and commit identity, adds the
process-bound helper to the existing main launcher, and enables main observation
with both rules off. Alt settings stay unchanged. Relaunch both profiles through
their existing launchers. The panel opens once. Verify the main profile's local
`PresenceGuard/diagnostics.json`, `history.json`, and panel; check enabled state,
commit, hooks, detector health, other plugins, and startup errors. These are
private local diagnostics, never public artifacts.

For later updates, pull/review changes normally, run `pnpm check`, commit them,
run `prepare`, gracefully close both profiles after the same call/capture check,
and run `update` instead of `install`. Existing rule preferences are preserved.
`inspect` and `--dry-run` do not activate, write settings, or terminate processes.
Installation/update dry runs also check executable receipts and recorded modes.
Unexpected source/launcher/updater/build drift stops the operation for review.
Executable and receipt reads reject non-regular files without blocking. Both
executable modes must match their authenticated records; an update cannot carry
forward unexplained permission changes.
The internal lock handoff verifies a kernel-reported exclusive lock on the exact
updater lock file owned by the current process; a caller-supplied marker cannot
bypass locking.
Do not delete receipts to bypass a drift failure.

## Rollback or uninstall

After the same call/capture preflight, gracefully close both profiles:

```sh
node scripts/install.mjs rollback --config "$PG_CONFIG"
# `uninstall` is an alias for the same integration restoration.
```

Rollback checks launcher/updater receipts, current installed bundle hashes and
the pinned original release, then atomically switches the retained build back.
The manifest is authenticated against a separate `baseline.sha256` in the private
ledger before any paths or bundle hashes in it are trusted. The private updater
must verify that anchor before using the manifest to protect a release from pruning.
It restores the original main launcher and private updater with their recorded
permissions, restores only the
PresenceGuard settings entry, and disables the helper lease. Unrelated settings,
Alt configuration and local history remain. Relaunch normally. Repeating a
successful rollback is a verified no-op. Later unrelated updater activation is
considered drift and requires reviewing the recorded release before rollback.

Generated source/helper files and history are retained for inspection, not
collected after uninstall. Reinstallation after rollback uses the **original
ledger and descriptor**: reapply the reviewed private updater extension and its
installed-updater receipt, run `prepare`, then `install` after the same safe Quit
procedure. The recorded rollback, original build and retained helper/configuration
are verified before reusing them. First-install defaults and the welcome panel are
restored, and the rollback marker is cleared only after installation succeeds. Do not
restore whole profile backups over newer authentication or unrelated settings.

## Interrupted integration

Before activation or rollback, the installer durably prepares the exact target
files and atomically publishes a complete `integration-transaction.json` in the
private ledger. A crash during journal preparation leaves the published journal
absent and the live integration untouched. Recovery authenticates the original
descriptor paths and unchanged updater/receipt, including complete permission bits.
Both profiles must remain closed. Repeating the interrupted command verifies the
recorded releases, prepared file images, and every current target against its
before/after states, then finishes the recorded operation. Unexpected edits stop
recovery. A recovered older installation is reported explicitly; prepare the
current head and update again afterward. A recovered rollback requires reapplying
the reviewed updater before a new installation.

`rollback` can cancel an installation that never activated. If activation already
occurred, it finishes the known prepared file changes before restoring the pinned
baseline. This operates only while the clients are closed. Local history and
unrelated settings remain preserved. `inspect` and dry runs report pending
recovery without performing it. Staging/prepare refuse to replace sources while
integration recovery is pending. An interrupted cleanup can leave hidden prepared
images for inspection; do not delete unexplained files or edit the journal to
bypass validation.

The integration check and installation staging also share a per-checkout lock
beside the Vencord directory (`.presence-guard-stage.lock` suffix). The integration
check holds it through validation/build; preparation holds it continuously through
staging and the maintained-updater build, together with the updater lock. This prevents competing checks from recovering a live transaction.

Staging journals are also published atomically. Staging also rejects symlinked parent directories before preparation and
publication. Temporary source generations stay in Git metadata, outside the plugin inventory; the Git directory and checkout
must share a filesystem for atomic renames. An interrupted pre-publication copy
may leave an isolated temporary generation for inspection, but cannot replace
the existing plugin or poison the next build's plugin list.

First-time baseline publication records a recoverable manifest/anchor pair in
the private ledger before publishing either output. Recovery requires the
recorded original release to remain active and its files and backups to match.
An unjournaled missing or mismatched anchor remains an error. Inspection reports
a pending initial publication, and dry runs refuse recovery without writing files. Repeated rollback
validates its receipt, original PresenceGuard entry and disabled lease as well as
the build and executables; later drift is preserved and reported.

GNOME's `ScreenSaver.GetActive` exposes screen-shield activity, not an authentication
lock. The helper reads `login1.Session.LockedHint` separately and validates that
logind's automatic session lookup selects the current user's active Wayland user
session. Provider/session changes invalidate continuity. See the upstream
[screen-shield D-Bus adapter](https://raw.githubusercontent.com/GNOME/gnome-shell/50.4/js/ui/shellDBus.js)
and [lock-hint implementation](https://raw.githubusercontent.com/GNOME/gnome-shell/50.4/js/ui/screenShield.js).
