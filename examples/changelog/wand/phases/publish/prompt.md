Phase goal: produce the final changelog.

Read everything under `entries/`, then write `CHANGELOG.md` with a version heading
and grouped bullets:

    ## 1.2.0

    ### Added
    - ...

When the file is ready, call `CheckPhase({ "version": "1.2.0" })` using the real
version number. On pass, the Wand is complete.
