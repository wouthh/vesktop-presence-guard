# Verification boundaries and manual checks

The local gate covers synthetic engine, activity detector, status provenance and
installation safety cases, plus plugin build integration against pinned public
Vencord source. The public-client check matches and compiles patches; it does not
execute Discord code or prove physical events. A loaded build, local status
application, correlated save acknowledgement, remote status and mobile display
are separate evidence.

1. With both rules off, inspect configured status, local effective presence,
   native Idle, desktop activity and ownership. Let ordinary display blanking or
   locking occur. Those display facts must not cause configured-status writes.
2. On Main with Automatic Idle enabled, deliberately select configured Online.
   Run one unlocked and one locked-but-awake five-minute inactivity cycle. A lock
   does not select Idle immediately; the desktop timer continues while locked.
   Confirm configured Idle, local effective presence, native Idle and plugin
   ownership separately. Under healthy detector conditions, the transition
   target is within ten seconds of five minutes.
3. While PresenceGuard owns Idle, make a brief input in another application.
   Confirm configured Online within ten seconds, ownership release, native Idle
   cleared and local effective presence separately. Repeat several away/return
   cycles. A display wake, focus change or phone interaction alone must not count.
4. Inspect the phone using the same account. Record the selected status separately
   from its presence indicator after both desktop transitions. Repeat while the
   mobile app is foregrounded and backgrounded, then reopen it. Measure observed
   propagation; do not assume desktop-local confirmation proves synchronization
   or promise mobile latency.
5. Make a manual mobile status override while desktop ownership is active.
   Include same-value or duration selection if the app exposes it. Record whether
   Discord emits a distinguishable configured-status change and confirm desktop
   control pauses when it is observable. An indistinguishable same-value change
   remains an explicit limitation.
6. Let native Idle occur before the five-minute desktop threshold when normal
   client behavior permits it. Confirm it does not acquire PresenceGuard
   ownership or suppress the later explicit configured Idle write. Do not force
   an Idle status to create this case.
7. With manual Idle, DND or Invisible selected, activity and camera changes must
   not change configured status. Test same-value and duration edits during an
   owned state; ownership must be revoked before asynchronous work.
8. Keep the existing Webcam DND behavior: use a camera normally in Vesktop or a
   supported PipeWire application, verify positive capture evidence, then stop
   capture normally. Confirm the previous camera-owned transitions still work.
9. Restart, naturally reconnect, disable the plugin, or make detector data
   unavailable. A restart/disable discards ownership and pending work without
   changing configured status. A same-process gateway interruption suspends only
   a locally applied plugin-owned Idle claim; after resume or fresh READY, confirm
   the account, updater, session, configured signature and correlated save before
   activity can restore Online. Matching settings alone cannot restore ownership.
   Manual interventions, account changes, unsupported hooks and updater identity
   loss revoke the claim. The panel reports connection/ownership phase and any
   recovery blocker. Fresh detector continuity is required after reconnect,
   suspend/resume, provider replacement or counter reset before a new Idle write;
   a genuine one-shot input remains immediately recognizable. Existing configured
   Idle is never adopted. If the native Idle hook is unsupported, Idle automation
   must remain unavailable and the panel must report that state.
10. Use clear/export and the labelled fixture simulation. Export remains local;
    simulation must not create real status writes or ownership.

11. In synthetic integration, expose the favourites updater before the main
    settings updater even though both have `updateAsync` and `markDirty`. Confirm
    discovery selects raw type-1 `PreloadedUserSettings`, validates its status
    descriptor and patched save lifecycle, and preserves the same receiver
    through asynchronous load, local application and save acknowledgement. The
    favourites updater must not load, mutate, affect ownership or confirm a save.
    Verify missing/wrong updater metadata and unknown schema show a fail-closed
    readiness reason, and inspect the allowlisted last-write diagnostic without
    any settings payload or exception text.

Synthetic acceptance also checks both the status-group draft and nested root
settings envelope, status-only updates, optional timestamp wrappers, exact save
echo provenance, unrelated snapshots, cancelled writes during settings loading,
and protected status history under overnight-scale detector churn passing through
the engine and history writer, including migration of repetitive legacy skips.
These checks do not establish remote save or mobile behavior.

The desktop inactivity timer does not use phone activity. Human observations
must record synthetic output, local configured/effective state, correlated save
evidence, and physical/mobile observations separately. Keep real profile
diagnostics out of Git. Tests never activate a camera, force a status, blank or
lock a display, change power policy, synthesize input or send account messages.
