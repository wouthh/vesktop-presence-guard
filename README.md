# PresenceGuard

PresenceGuard is a small Vencord userplugin for Vesktop on Linux GNOME. It keeps
a local history of your own Discord status and can optionally set your configured
status to Idle after five minutes of desktop-wide inactivity, or to Do Not Disturb
while your webcam is in use. It has no backend, telemetry, other-user tracking or
media acquisition. This release is **0.2.3**.

PresenceGuard is an unofficial Vencord userplugin; client modifications are
against Discord's Terms of Service, so install it at your own discretion.

## What it does

- Records your own configured status, local effective presence and detector
  events in a bounded local history, with a panel to inspect, clear or export it.
- **Automatic Idle** (optional): sets configured Idle after 300 seconds without
  input anywhere on the GNOME desktop, and restores Online on your next input.
- **Webcam DND** (optional): sets Do Not Disturb while a camera capture is
  positively observed, and can return to Online once capture has stopped.
- Acts only from configured Online and only reverts a status it set itself.
  Manual selections, uncertain detector data and unsupported client hooks stop
  automation.

## Install

PresenceGuard installs into an existing custom Vencord build through a guarded
installer with verification, backup and rollback. See
[installation, update and rollback](docs/installation.md) for the procedure and
its prerequisites. It does not distribute a customized Vencord bundle.

For development:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Use Node 22.12+ and the pinned pnpm version in `package.json`. `pnpm check` is the
canonical gate: lint, strict types, deterministic tests with fake time, a privacy
scan, the helper build, and an isolated clone/build of the pinned public Vencord
revision (network needed initially). A GJS runtime variant test runs when GJS is
installed and is explicitly skipped otherwise. `pnpm test` runs focused tests.
Local client compatibility can be checked without executing client code:

```sh
pnpm exec tsx scripts/check-client.ts /absolute/private/path/to/public-client.js
```

## Settings

Open **User Settings → Vencord → Plugins → PresenceGuard → settings → Open
PresenceGuard history and detector panel**, or use the PresenceGuard action in the
Vencord toolbox. The panel opens once after first installation.

- Installation enables observation and local history. **Automatic Idle and Webcam
  DND start off**; a verified update keeps your saved choices.
- Enable either rule independently in the panel or the plugin settings. The
  inactivity threshold is fixed at 300 seconds.
- The panel shows configured status, local effective presence, ownership,
  detector health, pending writes, paused rules and recent events. A paused rule
  resumes from the panel or when you select Online manually.
- `CustomIdle` and `AutoDNDWhilePlaying` are detected as conflicts. Resolve them
  yourself before using automation; PresenceGuard never disables other plugins.

With both rules off, PresenceGuard only observes, which lets you check whether
your status already goes Idle when the desktop is inactive.

## Privacy

- Observes only the signed-in account and local display and camera state. It
  never reads camera frames, requests streams or tracks other users.
- History stays in the profile's native Vencord data directory, outside
  cloud-synced settings, with restrictive permissions. It holds at most 500 events
  for seven days and contains no account IDs. Nothing is uploaded; export writes
  JSON only to a local file you choose.
- The diagnostic record keeps a bounded operation number, target, phase,
  timestamps, outcome and error code; never exception text or settings contents.
- The GNOME helper runs only while the plugin holds a fresh lease, exits with
  Vesktop, and adds no Flatpak permissions, daemon or network endpoint.

## Limits

- Implemented and tested only on Linux GNOME/Mutter on Wayland with the Vesktop
  Flatpak. Other platforms are not supported.
- Vencord integration is pinned to
  [`0e40e433d7aa9168f656aba733d01e761b7ca8ca`](https://github.com/Vendicated/Vencord/commit/0e40e433d7aa9168f656aba733d01e761b7ca8ca).
  Discord changes independently; runtime patch checks fail closed and block writes.
- Camera coverage is partial: Vesktop camera use and PipeWire UVC capture are
  observed, direct V4L2 applications are not.
- Local confirmation means the client applied the update; it does not prove a
  server save or what other devices show. A same-value status change made on
  another device may be undetectable.
- Ownership never survives a plugin or Vesktop restart, and an existing
  configured Idle is never adopted.
- Physical camera and display cycles need the
  [manual smoke-test checklist](docs/smoke-test.md); fixtures are not physical
  verification.

The full state, ownership, history and detector semantics are in
[behaviour and safety semantics](docs/behaviour.md). See [AGENTS.md](AGENTS.md)
for review and contribution invariants. Never publish cached client files, real
histories, installation descriptors, machine paths or other plugins.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). Vencord-derived headers retain upstream
notices. PresenceGuard is not approved by Discord, and compatibility is not
guaranteed.
