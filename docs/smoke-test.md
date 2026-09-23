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
2. On Main with Automatic Idle enabled, begin from configured Online. Leave the
   desktop untouched for five minutes. Confirm configured Idle, local effective
   presence, native Idle and plugin ownership separately. Under healthy detector
   conditions, the transition target is within ten seconds of five minutes.
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
9. Restart or reconnect, disable the plugin, or make detector data unavailable.
   Ownership and pending writes must be discarded at restart/reconnect/disable;
   an already owned status may remain local while activity is Unknown, but no
   return may be inferred from stale data. Existing configured Idle is never
   adopted. If the native Idle hook is unsupported, Idle automation must remain
   unavailable and the panel must report that state.
10. Use clear/export and the labelled fixture simulation. Export remains local;
    simulation must not create real status writes or ownership.

The desktop inactivity timer does not use phone activity. Human observations
must record synthetic output, local configured/effective state, correlated save
evidence, and physical/mobile observations separately. Keep real profile
diagnostics out of Git. Tests never activate a camera, force a status, blank or
lock a display, change power policy, synthesize input or send account messages.
