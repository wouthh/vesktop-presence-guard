# PresenceGuard

A small unofficial Vencord userplugin for **local own-status history**, optional
Idle after inactivity-associated display blanking, and optional webcam DND.
No backend, telemetry, other-user tracking, or media acquisition.

Installation enables PresenceGuard and local history in the selected main
profile. **Automatic Idle and Webcam DND both start off.** Discord's existing
automatic idle behavior stays enabled. Other profiles and plugins are preserved.

Open **User Settings → Vencord → Plugins → PresenceGuard → settings → Open
PresenceGuard history and detector panel**. The Vencord toolbox also has a
PresenceGuard history action. The panel opens once after first installation.
It shows configured status, local effective presence, a separately labelled local
aggregate view, ownership, detector health, and recent events. Enable either rule
independently there or in the plugin settings. Unsupported safety hooks prevent
all automatic writes even if a switch is on.

## Baseline and history

Leave both rules off to answer: “Did my locally observed status become Idle
when the display blanked, without PresenceGuard changing it?” Compare
`OBSERVATION` events and their display snapshots. Configured Online and effective
Idle are separate values; native idle is never adopted as plugin ownership.
`SIMULATION` / `would_…` decisions are hypothetical, never status writes.

History is profile-local in the native Vencord data directory's `PresenceGuard`
subdirectory, outside cloud-synced settings. It retains at most 500 events and
seven days (pruned on reads/writes while running), uses restrictive permissions
and atomic writes, and contains no
account IDs. Clear it in the panel or explicitly export JSON to a chosen local
file. Nothing is uploaded. Local observations do not independently prove what
another session or user sees. Confirmation means Discord applied the local
update; it does not prove a successful server save.

## Status safety

Automation starts only from positively confirmed configured **and** effective
Online, with a ready account, established gateway connection and verified client
hooks. It never changes manual Idle, DND, Invisible, disconnected or uncertain
presence. Confirmed camera capture takes precedence over qualifying display
inactivity. Return to Online requires fresh return/clear evidence and continued
ownership of the current status.

Every observed manual selection, including selecting the same value or changing
its duration, invalidates pending writes and ownership before processing the
action. Writes use exact callback/update-object provenance, serialized execution,
and generation checks inside Discord's asynchronous settings callback. Only the
manual selection's new configured value can release a pending non-Online intent
guard; the old Online preference cannot authorize another write while it loads.
An explicit manual Online selection permits fresh evaluation. Only the
status field changes; duration and other profile fields stay intact. Observable
unattributed writes revoke ownership. An unreported cross-device **same-value**
selection cannot be detected. A matching value or nearby timestamp is never
proof of ownership.

Disabling an owning rule, stopping the plugin, switching accounts or reconnecting
revokes ownership and leaves status unchanged. Ownership never survives a
restart. Re-enabling the plugin in the same renderer leaves webcam automation
unavailable until a renderer restart, because acquisitions while disabled cannot
be reconstructed safely; Idle and observation remain available. Unexplained reversals pause the affected rule instead of repeatedly
fighting the client. Resume explicitly in the panel or select Online manually.
`CustomIdle` and `AutoDNDWhilePlaying` are detected conflicts; resolve them yourself
before using automation. PresenceGuard never disables other plugins.

## Supported detectors

The implemented target is Linux GNOME/Mutter on Wayland. Initial host probes used
Fedora 44, GNOME/Mutter 50.4, Vesktop Flatpak 1.6.7 and PipeWire 1.6.8. Other
platforms are not implemented or claimed tested. Vencord integration is pinned to
[`0e40e433d7aa9168f656aba733d01e761b7ca8ca`](https://github.com/Vendicated/Vencord/commit/0e40e433d7aa9168f656aba733d01e761b7ca8ca).
Discord changes independently; runtime patch checks fail closed.

- **Display:** a GJS/Gio helper reads Mutter power state, logical monitor topology,
  idle time, lock and suspend signals. It follows the desktop's existing idle
  delay, changes no power policy, requires a preceding inactivity-to-blanking
  sequence and labels its cause **inferred**. A manual lock, monitor removal,
  startup already blanked, provider restart or suspend gap cannot establish that
  sequence. Lock already present at startup or reconnect, or arriving before or
  together with blanking, remains Unknown; the
  interface cannot prove whether that lock was manual or automatic. Return requires powered-on displays and recent actual activity.
  Window visibility is not used. The helper collects only during a fresh plugin
  lease and exits with its owning main launch process. It publishes a bounded
  snapshot through an existing read-only build-directory grant; no added Flatpak
  permissions, daemon, command receiver or network endpoint.
- **Camera:** **partial coverage** of observed Vesktop camera acquisitions and
  visible PipeWire UVC camera capture. A running hardware source must have an
  active link to a running capture consumer; presence, permissions, an open
  device, video playback and generic video nodes are insufficient. Existing
  Vesktop stream/track lifecycle is observed without requesting a stream or
  reading frames. Direct V4L2 applications outside that graph remain unproven.
  Missing/stale providers mean Unknown, never “camera stopped”. An unavailable
  camera provider does not prevent eligible Idle acquisition, but cannot clear
  camera-owned DND or authorize return to Online.

Queries are bounded, reconciled every two seconds, and expire after ten seconds.
The initial host probes confirmed available display interfaces and a suspended
hardware camera node. **Physical blanking/capture cycles still require the
human-triggered checks below; fixtures are not physical verification.**

## Installation and development

See [installation, update and rollback](docs/installation.md), and the
[manual smoke-test checklist](docs/smoke-test.md). This project uses the existing
[Vencord plugin/native facilities](https://docs.vencord.dev/plugins/) and the
read-only [PipeWire metadata graph](https://docs.pipewire.org/page_man_pw-dump_1.html).
It does not distribute a customized Vencord bundle.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Use Node 22.12+ and the pinned pnpm version in `package.json`. The canonical gate
runs lint, strict types, production-logic tests with fake time, a privacy scan,
the helper build, and an isolated clone/build of the pinned public Vencord
revision (network needed initially). An additional runtime variant test runs when
GJS is installed and is explicitly skipped otherwise. Cached/generated files stay
ignored.
`pnpm test` runs focused tests. Local client compatibility can be checked without
executing its code:

```sh
pnpm exec tsx scripts/check-client.ts /absolute/private/path/to/public-client.js
```

Never publish cached client files, real histories, installation descriptors,
private instructions, machine paths or other plugins. CI only uses synthetic
fixtures and public upstream dependencies. See [AGENTS.md](AGENTS.md) for review
and contribution invariants.

GPL-3.0-or-later; see [LICENSE](LICENSE). Vencord-derived headers retain upstream
notices. This is an unofficial client modification, not approved by Discord;
compatibility is not guaranteed.
