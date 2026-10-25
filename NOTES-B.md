NOTES: Implementer B - re-point profile + positions roles reads via identity-backend, flag-gated.
DONE: both sites re-pointed (OFF byte-identical direct get; ON bundle roles via getIdentityBundleViaBackend). Field audit: both sites consume only snap.exists + data().role, both inside bundle projection - no STOP.
GATES: positions 3 suites/20 tests green (existing unmodified + new 5); profile new suite 5/5; adjacent (telemetry, identity-backend, identity-supa, founder-transfer-raw-consumers, consent-bypass-inventory) 75 green; identity-cache-integration 15 green; tsc completes, 151 errors = baseline 151, zero new, none in touched files.
NOTE: jest needs --forceExit for the profile route suite due to the routes pre-existing module-level setInterval open handle (unmodified code).
