# PresenceGuard

A small unofficial Vencord userplugin for **local own-status history**, optional
configured Idle after five minutes of desktop-wide inactivity, and optional webcam DND.
No backend, telemetry, other-user tracking, or media acquisition.

Installation enables PresenceGuard and local history in the selected main
profile. **Automatic Idle and Webcam DND start off on first installation.** A
verified update preserves each profile's saved choices. Main's managed
deployment uses Automatic Idle at 300 seconds; Alt keeps PresenceGuard disabled.
The native Idle path remains in place and is narrowly coordinated with the
desktop activity source. Other profiles and plugins are preserved.

Open **User Settings → Vencord → Plugins → PresenceGuard → settings → Open
PresenceGuard history and detector panel**. The Vencord toolbox also has a
PresenceGuard history action. The panel opens once after first installation.
It shows configured status, local effective presence, a separately labelled local
aggregate view, ownership, detector health, and recent events. Enable either rule
independently there or in the plugin settings. Unsupported safety hooks prevent
all automatic writes even if a switch is on.

## Baseline and history

Leave both rules off to answer: “Did my locally observed status become Idle
when the desktop went inactive, without PresenceGuard changing configured
status?” Compare observation events. Configured status, local effective
presence, native Idle, and plugin ownership are separate values.
SIMULATION / would… decisions are hypothetical, never status writes.

History is profile-local in the native Vencord data directory's `PresenceGuard`
subdirectory, outside cloud-synced settings. It retains at most 500 events and
seven days (pruned on reads/writes while running), uses restrictive permissions
and atomic writes with temporary-file cleanup on failure, and contains no
account IDs. Clear it in the panel or explicitly export JSON to a chosen local
file. Nothing is uploaded. Local observations do not independently prove what
another session or user sees. Confirmation means Discord applied the local
update; it does not prove a successful server save.
The panel reports local storage failures separately from status-hook health.
Failures remain visible until the corresponding operation succeeds. Diagnostic
write failures do not invalidate otherwise healthy detector observations. Native
JSON reads reject non-regular files without waiting on a FIFO.

Transient history-write failures retain recent pending events in memory and retry
on subsequent events or the existing two-second poll. The panel shows storage
health and the pending count; export waits for those events to be saved. Pending
events share the 500-event/seven-day limit and cannot survive process exit while
storage remains unavailable. Successful clear cancels older pending events.

## Status safety

Automatic Idle starts only from configured Online and either local effective
Online or effective Idle positively attributed to Discord's native automatic
Idle path. It requires a ready account, established gateway connection,
verified status/native hooks and fresh GNOME evidence. Camera DND retains its
existing Online-only eligibility and precedence. Manual Idle, DND, Invisible,
disconnected or uncertain configured status is never changed.

Every observed manual selection, including selecting the same value or changing
its duration, invalidates pending writes and ownership before processing the
action. Writes use exact callback/update-object provenance, serialized execution,
and generation checks inside Discord's asynchronous settings callback. Only the
manual selection's new configured value can release a pending non-Online intent
guard; the old Online preference cannot authorize another write while it loads.
This guard survives a same-account reconnect and a temporarily unknown account;
only a confirmed different account or explicit logout clears its account scope.
An explicit manual Online selection permits fresh evaluation. PresenceGuard uses
Discord's normal configured-status updater and changes only the status value;
duration and other profile fields stay intact. Ownership begins only after the
plugin's attributable configured Idle update is locally applied. Native Idle
alone never grants ownership. A one-shot Mutter user-active watch restores
configured Online on genuine input in any desktop application, while the plugin
still owns Idle. Display blanking, locking, focus, aggregate presence and session
events do not drive the inactivity timer.

The local panel/history distinguishes configured status, effective presence,
native Idle, ownership, local update confirmation and the updater's save
lifecycle. A correlated save acknowledgement is evidence of that client save;
local application alone is not proof of server persistence or mobile
propagation. Rate-limited saves remain pending while Discord retries; terminal
failures remain visible and pause that rule until Resume. If the native Idle hook
fails its compatibility check, Automatic Idle stays unavailable and the panel
reports the missing hook. The timer measures this desktop only. Observable
external configured-status changes revoke ownership and pause automation. If
Discord provides no distinguishable event for a cross-device same-value
selection, PresenceGuard cannot detect it; equal values and timestamps do not
prove ownership.

Disabling an owning rule, stopping the plugin, switching accounts or reconnecting
cancels pending work, revokes ownership and leaves configured status unchanged.
Startup/reconnect establishes fresh detector continuity and never adopts an
existing configured Idle. Missing or stale activity evidence holds automation;
an existing process-local owner may remain while configuration is still valid,
but return requires fresh desktop input. Ownership never survives a restart.
Stopping restores native Idle behavior. Re-enabling the plugin in the same renderer leaves webcam automation
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

- **Activity:** a GJS/Gio helper reads Mutter's GNOME-wide idle counter and a
  one-shot user-active watch. The status policy uses a fixed 300-second
  inactivity threshold independent of display blanking, lock state and Vesktop
  focus. A brief input between polls is retained as an activity serial. Provider
  or session changes, suspend/resume gaps, unverified counter resets and stale
  observations produce Unknown; they do not invent a return or acquire a status.
  Native Idle is cleared or suppressed while this source positively says the
  desktop is active and configured Online or plugin-owned Idle is in scope. The
  hook changes only Discord's local IDLE event; it leaves shared activity times,
  AFK and notifications alone.
- **Display:** a GJS/Gio helper reads Mutter power state, logical monitor topology,
  idle time, screen-shield activity, actual login1 lock state and suspend signals,
  reconciling current login1 sleep state
  after subscription gaps. It follows the desktop's existing idle
  delay, changes no power policy, requires a preceding inactivity-to-blanking
  sequence and labels its cause **inferred**. A manual lock, monitor removal,
  startup already blanked, provider restart or suspend gap cannot establish that
  sequence. Lock already present at startup or reconnect, or arriving before or
  together with blanking, remains Unknown; the
  interface cannot prove whether that lock was manual or automatic. These
  observations do not authorize status changes. Screen-shield
  activity is kept distinct from locking and conservatively treated as ambiguous
  when it precedes blanking. The lock hint must come from the current user's
  active Wayland session; missing or unsupported session state stays Unknown.
  Camera-owned DND return still requires its confirmed display, native-idle and
  camera conditions; plugin-owned Idle return uses fresh system-wide input.
  History retains power mode, lock, shield, suspend, threshold-crossed and monitor-count
  facts even when the inactivity cause is Unknown. Fact transitions are recorded
  separately from status changes; polling timestamps and changing idle counters
  do not create repeated events. No monitor or session identifiers are retained.
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

PipeWire capture can include browsers and other desktop applications, not just
Vesktop. Coverage depends on their capture path; direct V4L2 remains unproven.
The native query reads only Core, Node and Link objects, avoiding unrelated Port
parameters that Flatpak's PipeWire 1.4.9 tool cannot serialize against the tested
1.6.8 host. Node identities/states and daemon identity must remain stable around
the link query. All five bounded reads share a two-second/four-MiB budget;
malformed relevant objects or inconsistent observations produce Unknown.
Captured cameras retain their node ID and stable object serial across polls;
reusing a disappeared camera's numeric ID does not confirm capture cessation.
Another active camera cannot erase an unresolved disappeared capture either.

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
Privacy checks scan the staged Git blobs and working copies separately, reject
non-regular source entries, and do not skip force-added generated artifacts.
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
