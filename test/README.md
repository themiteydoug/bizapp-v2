# Tests

Plain Node scripts, no dependencies and no runner. Each exits non-zero on
failure, so they work in a shell or in CI:

    node test/origins.test.js

They live here rather than in a scratch directory because every one of them
was written to pin down a bug that had already reached production, and a
regression test that disappears with the machine it was written on is no
test at all.

- **origins.test.js** — which addresses `/api/data` accepts. Browsers omit the
  `Origin` header on a same-origin GET but send it on a POST, so trusting a
  single origin let a device on the previous domain pull data and silently
  fail every write.

- **sync.test.js** — the three ways `js/sync.js` lost data during the domain
  move. An unsynced singleton edit (staff, timesheet adjustments, cleaning
  jobs) was overwritten by the server copy on the next app open, because the
  "dirty" marker lived only in memory and a reload wiped it. A failed write was
  only retried inside a full pull, and a full pull only happens when the
  revision changes, so a device that was offline when it saved sat on its
  backlog until some *other* device wrote something. And the header said
  "Synced" the whole time.
