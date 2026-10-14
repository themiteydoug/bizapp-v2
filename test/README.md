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
