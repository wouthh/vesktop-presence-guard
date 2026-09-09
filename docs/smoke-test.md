# Verification boundaries and manual checks

`pnpm check` covers synthetic engine, detector, status-provenance and installation
safety cases, plus actual plugin type/lint/build integration against the pinned
public Vencord revision. The local client check matches and compiles patches; it
does not execute the client or prove physical events. A live loaded bundle,
working panel/history, validated hooks, and healthy detector probes are distinct
from the following human-triggered checks.

1. Leave both rules off. Let the desktop become inactive and blank normally.
   Return normally and inspect/export history. Compare configured and effective
   status and display snapshots. The raw display facts distinguish power-save mode
   from lock/shield activity, even when automatic Idle remains Unknown. A
   `display_facts_observed_cause_not_proven` entry records those facts, not a status
   request or proof of what caused blanking. Any native Idle observation should have no
   preceding PresenceGuard request. Do not force Online to produce a test.
2. When you naturally choose Online, enable Automatic Idle. Let normal desktop
   inactivity blank the screen, then return normally. Confirm one owned Idle and
   a guarded release only on fresh active-session evidence.
3. While plugin-owned Idle, manually select Idle again, including a duration
   change. Returning to the desktop must leave it Idle with ownership revoked.
   Repeat the same-value check with webcam-owned DND when practical.
4. Enable Webcam DND and use your camera normally in Vesktop or a PipeWire camera
   application. Confirm the panel actually reports a positive supported capture
   before expecting DND. Stop the capture normally. Remaining display inactivity
   should yield owned Idle if enabled; an active session may release to Online.
5. With manual Idle, DND or Invisible selected, detector changes must not write
   status. Test disabling an owning rule: status remains unchanged and ownership
   is lost. Restart/reconnect must never restore old ownership.
6. A manual lock before qualifying inactivity, monitor removal, window hiding,
   provider loss or Unknown sample must not be described as proven inactivity
   blanking or used to return Online. Inspect partial-camera coverage honestly.
7. Use clear/export and the explicitly labelled fixture simulation in the panel.
   Export remains local; simulations must not produce real requests or ownership.

These checks are performed by the user during ordinary activity. The installer
must never activate a camera, force a status, blank/lock a display, change power
policy or synthesize activity to make a test succeed. Record actual observations
separately from pending checks, and keep all real diagnostics out of Git.
