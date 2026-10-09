# Frozen production main tools for the offline chain test

These are read-only test inputs from the existing production main kernel at
`d357ec`. They are not installed by this change, and Acceptance does not modify
them. The fixture redirects absolute paths into a temporary directory and runs
the real `update-main-online.sh` controller and `prepare-online-candidate.sh`.

SHA-256 of the exact unmodified source inputs:

- `scripts/deploy/lib.sh`: `fd564574afd8c01fadcba3f64866f79594aa83dc2277059f77429589f75ca6bb`
- `scripts/deploy/prepare-online-candidate.sh`: `66b8d37cc6bb1a39ee81ccb4e04a8c5c2561c659064721bea4410b45a5d5c5a8`
- `scripts/deploy/update-main-online.sh`: `b12a9ca0f3d330386c096076421ce91044ca459bb004d0bbf74aa910b3848876`

The candidate bundles already have valid checksums. This fixture validates
preparation/registration and the two slot transitions around Acceptance; it
does not compile application code. Database, PM2, privileged identity, HTTP,
Nginx worker helpers and registration/process persistence are local doubles.
Generation creation and alias selection use the real library primitives.
No remote transport, ECS, production files or real database is used.

The old Acceptance controller fixture is the exact script from
`c734c34fa9a232f40f9e16bd4e12f591e58eaa79`; it demonstrates both the old 3201
failure and the existing refresh validator refusing executable policy changes.
