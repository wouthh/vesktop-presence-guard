# PresenceGuard repository guidance

Policy: `implementation-review-loop-v1`. Adapted from the reviewed AI-assisted
engineering playbook at `bd51a9360e3e46d3ad5b0f4f2fb25b644995bd2a`.

## Purpose and layout

PresenceGuard is an unofficial Vencord userplugin for observing the signed-in
account's status and optionally managing Idle/DND on a GNOME Vesktop desktop.
`src/` owns the plugin and pure decision/detector logic; `helper/` owns the
process-bound GNOME observer; `scripts/` owns checks and installation;
`tests/` contains synthetic fixtures. No nested instruction overrides exist.

## Protected state and invariants

- Idle ownership may be acquired only from configured Online plus either local
  effective Online or effective Idle positively attributed to the verified
  native automatic-Idle path. Native Idle alone never grants ownership and
  does not block the explicit configured Idle write after 300 seconds.
- Manual selections, including the same value and duration edits, revoke
  ownership before asynchronous work. Unknown never means cleared.
- Keep GNOME system-wide input evidence, raw display facts, native Idle
  attribution, configured-status writes and local effective presence distinct.
  Display blanking, locking and Vesktop focus never control the five-minute timer.
- Ownership begins only after the exact plugin updater operation locally applies
  configured Idle. Ownership is process-local; never restore it from history or
  adopt native Idle. Revoke it on an observable configured-status intervention.
- Provider/session changes, counter resets, suspend/resume gaps and stale input
  evidence never fabricate activity. Aggregate/session presence updates are not
  proof of a manual configured-status selection.
- Renderer reconnects preserve an activity recovery boundary. A high post-resume
  counter requires fresh five-minute continuity before Idle; a fresh one-shot
  input remains immediately recognizable.
- A one-shot input that invalidates an in-flight counter read remains positive
  activity evidence while that counter is refreshed; the stale counter alone is
  withheld and independent display facts remain usable. Snapshot readers consume
  activity and display facts from one fresh, sequenced helper generation.
- Cancellation before local mutation is not a write failure and does not pause
  automation. Genuine updater, confirmation, and terminal-save failures remain
  visible and pause the affected rule.
- Parse only supported configured-status group/root envelopes and wrappers;
  group-level or root-level duration metadata is accepted when unambiguous, and
  malformed or competing status locations and unknown required shapes fail
  closed. Wrapped null expiry remains valid no-duration evidence. A no-duration
  picker selection may correlate with an explicit null or zero expiry, but
  never with a nonzero duration; present undefined duration fields are invalid.
  Save acknowledgements require one exact queued updater operation with
  compatible parsed status/duration evidence. A successful request with an
  undecodable/null response is an unavailable terminal outcome for its active
  candidate, never an unreported success;
  ambiguous, unparseable, or mismatched evidence never counts as success, while
  candidate tokens remain attached so terminal outcomes pause affected rules.
- Resolve status writes from the raw settings updater whose numeric type is 1
  and whose `ProtoClass.typeName` is exactly
  `discord_protos.discord_users.v1.PreloadedUserSettings`. Validate current
  status field descriptors and update/save patch fingerprints before enabling
  writes. Never select by generic method presence: favourites settings share
  those methods. Keep the same raw receiver through loading, mutation and save
  correlation, and accept status events/save callbacks only from that verified
  type-1 instance.
- Keep a bounded allowlist-only last-write diagnostic with operation number,
  target, phase, timestamps, outcome and classified error code. Do not persist
  exception text, settings, responses or account identifiers. Ordinary decision
  skips belong in detector history; requests, cancellations, confirmations,
  saves, failures, manual boundaries and ownership changes use control history.
  Migrate only known repetitive legacy skip reasons out of the control
  reservation, while retaining legacy status observations there.
- Retain no more than 500 history events for seven days, reserving 400 for
  status/control and 100 for coalesced detector summaries. Status changes use
  the control reservation; ordinary decision skips and activity, display, and
  camera uncertainty-reason changes use bounded detector summaries. Persisted-event
  deduplication includes activity evidence and native Idle attribution; legacy
  status-observation reasons migrate into the control reservation. Detector
  caps select by latest occurrence; known repetitive legacy skips migrate into
  the detector reservation. Overlapping
  summaries use the greater repeat count because individual occurrences are not
  retained; disjoint ranges add. In-flight append identity stays stable, and
  events recorded during Clear survive while prior visible history is removed.
  Close the clear-collection window before transferring its final events so a
  completion-microtask enqueue cannot be dropped.
  A failed Clear restores through the same retention limits before attempting
  a best-effort storage reload, so a reload failure cannot expand memory history.
- Native Idle integration may suppress or clear only the local IDLE event while
  fresh desktop activity is proven. It must not change shared activity times,
  AFK or notification behavior. The desktop timer never uses phone activity.
- Observe only the signed-in account and local display/camera state. No media
  acquisition, telemetry, network control listener, or other-user tracking.
- Preserve existing plugins, profiles, launch routes, settings, and unexplained
  dirty work. Installation requires a verified candidate and reversible backup.
- Keep personal histories, Discord identifiers, credentials, host paths,
  private instructions, and customized bundles out of Git and public fixtures.
- Do not force real status changes, camera use, locking, blanking, or activity
  for a test. Distinguish simulation, integration, and physical verification.

## Validation and delivery

`pnpm check` is the canonical gate: lint, types, deterministic tests, privacy
scan, helper build, and pinned upstream plugin integration. `pnpm test` is the
focused engine/detector/adapter gate. `pnpm exec tsx scripts/check-client.ts`
with an explicit local public-client script checks patch compatibility without
executing client code; the current public-client schema check must also confirm
the PreloadedUserSettings status descriptors and update path. Physical
camera/display cycles require human smoke tests.

Bootstrap `main`, then use a feature branch. Preserve dirty work; no reset,
stash, rebase, amend, or force-push. Use normal commits and a ready PR after
passing applicable checks. Inspect the complete staged diff and `git diff --check`.
Never claim an unavailable check passed.

Let configured automatic Codex review start on PR creation; do not duplicate a
running cycle. Otherwise request one `@codex review`. Inspect body/comment
reactions, reviews, inline threads and checks against the exact head. Eyes and
silence are not clearance. Fix valid scoped findings, validate, push, reply with
SHA/evidence and resolve addressed threads. Each substantive head needs fresh
completed review; poll at 30–60 second intervals for at most 15 minutes per
cycle, then report an exact-head external blocker. Leave the PR unmerged unless
separately authorized. Public repository creation is authorized for this task.

## Installation and maintenance

Use an explicit installation descriptor stored outside this repository. Never
embed workstation paths in tracked files. Honor the existing updater's lock,
source validation, retained-release activation and rollback. Read
[the delivery procedure](docs/installation.md) explicitly before delivery.
Apply the owner's scoped restart authority recorded outside the repository;
timing permission does not waive the required durable closed-client state,
integrity checks, locks, pending-snapshot binding, or recovery guards.
Compile installed helper code from the recorded Git tree. Serialize staging with
the integration check; prepare durable file images before activation or rollback.
Bind activation to the authenticated pending snapshot and expected release; reject
changed target-parent identities on recovery. Bind target images to file states
captured before planning; restore staging trees
by atomic rename before recursively removing discarded generations.
Recover interrupted operations only after validating recorded before/after state.
History survives uninstall by default. Stop helper collection when its lease
ends and terminate it with its owning application process.

Document behavior and compatibility changes alongside code. Keep this file
concise and idempotent; do not copy private workstation guidance here. The
owner-only system ledger records installation identity, backups, verification,
rollback and any pending review head. Do not update generated agent memories.

## Review priorities

1. Status-write provenance must survive async races without swallowing manual actions.
2. Positive camera/display evidence must be distinct from missing or stale data.
3. Installation must preserve existing plugins and reject unexplained drift.
