# Installation, updates and rollback

This is a plugin for an existing maintained custom Vencord build. Inspect the
actual Vesktop package, both profiles, build sources, other userplugins and
launcher before changing anything. Preserve them. The first supported deployment
uses Linux GNOME and a Flatpak with an existing read-only Vencord-directory grant.
If that grant or the host GJS/Mutter interfaces are absent, report display support
as unavailable; do not broaden sandbox permissions as a shortcut.

The installer deliberately consumes an **owner-only, external JSON descriptor**.
Keep this local. Required absolute-path fields are `vencordRoot`, `mainProfile`,
`altProfile`, `mainLauncher`, `updater`, `updaterLock`, and `ledger`. The two
profiles must differ and main `state.json` must already reference the maintained
`dist` location. The supported main launcher ends in its existing `exec`
Mullvad-excluded Flatpak invocation; unexpected launchers are rejected intact.

Before the first installation, the private ledger's `backups` directory must
contain `main-launcher`, `updater`, and `main-plugins` (the original main Vencord
settings JSON). Also back up both profiles' state/settings and the Alt launcher.
The existing private updater needs a reviewed extension to include the exact
PresenceGuard staging manifest, verify its hashes, preserve its source alongside
all existing custom plugins, and protect the release named in
`.presence-guard/baseline.json` from retention pruning. Record its installed SHA256
in `installed-updater.sha256` in the ledger. This project does not publish or
replace private updaters. The adapter's supported commands are `rebuild` and
`activate`, using the existing lock and retained-release workflow.

```sh
node scripts/install.mjs inspect --config "$PG_CONFIG"
node scripts/install.mjs stage --config "$PG_CONFIG" --dry-run
node scripts/install.mjs prepare --config "$PG_CONFIG"
node scripts/install.mjs install --config "$PG_CONFIG" --dry-run
```

`PG_CONFIG` names your private descriptor. `stage` copies only plugin-owned source,
writes commit/upstream/file fingerprints, preserves other userplugin directories,
and rejects changed or unowned staging trees. `prepare` stages under the updater
lock, then asks the updater to build an isolated candidate without activation.
The canonical project gate and the full combined Vencord checks must pass first.
Commit all source changes before installation; dirty or mismatched heads fail.

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
Unexpected source/launcher/updater/build drift stops the operation for review.
Do not delete receipts to bypass a drift failure.

## Rollback or uninstall

After the same call/capture preflight, gracefully close both profiles:

```sh
node scripts/install.mjs rollback --config "$PG_CONFIG"
# `uninstall` is an alias for the same integration restoration.
```

Rollback checks launcher/updater receipts, current installed bundle hashes and
the pinned original release, then atomically switches the retained build back.
It restores the original main launcher and private updater, restores only the
PresenceGuard settings entry, and disables the helper lease. Unrelated settings,
Alt configuration and local history remain. Relaunch normally. Repeating a
successful rollback is a verified no-op. Later unrelated updater activation is
considered drift and requires reviewing the recorded release before rollback.

Generated source/helper files and history are retained for inspection, not
collected after uninstall. Reinstallation after rollback requires repeating the
reviewed private updater setup and starting a new installation ledger. Do not
restore whole profile backups over newer authentication or unrelated settings.
