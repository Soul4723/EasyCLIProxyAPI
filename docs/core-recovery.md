# Kernel exit recovery

The desktop backend automatically recovers only local managed kernels that it
successfully started. Adopted processes are observed but never automatically
restarted. An unsuccessful initial launch does not enable recovery. An observed
managed-child exit is unexpected unless an intentional stop, update, connection
change, or application shutdown has disarmed supervision.

## Runtime cost

The existing managed-child supervisor owns exit detection and restart execution.
Recovery status is a passive view of that supervisor; it does not add a second
restart loop. Healthy status serialization omits the recovery field. The desktop
application must remain running for supervision to operate.

## Recovery policy

- Delays are 1, 2, 5, 10, and 30 seconds, with at most five attempts.
- Sixty seconds of stable managed-child uptime resets the retry budget.
- Exhaustion pauses recovery until a manual start or restart.
- Stop, shutdown, update, or switching to a remote target invalidates delayed work.
- The existing operation lock serializes recovery with manual commands and
  updates. Target revision and supervision generation checks reject stale work.
- Recovery never stops a live process because a port check timed out. It uses the
  existing startup path and its readiness checks only when a restart is needed.

The Overview page displays recovery progress and failure details. Waiting recovery
can be canceled with Stop. Exit information and startup failures also go through
the existing diagnostic logging. Persistent recovery metadata is not written to
the usage database or configuration files.
