# Loading data

- Use a module-owned `createDataSource` for each shared resource. Subscribe with
  `useDataSource`; events invalidate it and explicit refreshes go through it. Poll
  only when events cannot report a change. Polling stops with the last subscriber
  or a hidden document, backs off on errors, and preserves equal snapshots and the
  last good value. `mutate` fences reads when a write returns authoritative data.
- Use `useResource(load, dependencies)` for component-owned, parameterized queries.
  Dependencies must include every request input and target identity. It isolates old
  requests while retaining the displayed value during reload/error. The owner
  invalidates queries on events/focus; there is no implicit focus refresh or polling.
  Unmount removes its subscription. `loading` is initial loading; `refreshing` reports
  a background read with retained data (for example the Requests refresh indicator).
- Timing is not data: `refreshTiming` provides `subscribeFixedWindowEvent` (a fixed
  trailing window that continuous events cannot postpone), `startStaleFocusRefresh`
  (one freshness owner, explicitly marked fresh on query/manual changes), and
  `useVisibleInterval` (no initial/catch-up tick, paused while hidden or disabled).
  Usage records use a 2 s window and 30 s focus freshness; the relative-range clock
  ticks every 60 s only while the core is ready. Collector status remains a data
  source with 30 s polling, 120 s error backoff, and `eventDelayMs: 2000` for its
  event reads; keeping that option lets its refresh consume pending invalidations.
  Analyses share a per-snapshot promise map, evicting failed requests for retry.
- Settings draft loaders use `createSettingsRead`: explicit reads share one in-flight
  request without a subscription. Existing mount/event/action triggers apply data;
  focus must not overwrite unsaved drafts. Event/action reads use `fresh: true`
  and authoritative responses use `publish` to fence older reads. There is no
  polling or focus IPC.
- OAuth sessions use `startSessionPolling`: a private source with a delayed first
  check, serial visible checks and terminal errors. Stop it on cancel, completion,
  retry and unmount. Session cancellation on the core and wall-clock expiry still
  belong to the flow owner, including cancellation of late start responses.
- One-shot actions (writes, exports, probes, launches), bounded post-write plugin
  reconciliation, UI expiry/debounce timers and native collector queue draining are
  not subscribed data resources. Keep their action/deadline ownership explicit.

Sources do not replace transport fencing. Core-bound loads must still use
`documentTarget` (or a service wrapping it), never capture a new target revision to
retry an old request. See [fencing and revision semantics](../../docs/remote-core.md#fencing-and-revision-semantics).
