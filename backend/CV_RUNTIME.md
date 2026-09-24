# CV extraction runtime and recovery

## Railway / Nixpacks

Build context and Railway Root Directory: repository root (`/`), not `backend`.
There is intentionally no root package.json. `railway.json` selects NIXPACKS;
`nixpacks.toml` explicitly defines setup, install, build and start.

- Nix archive: `e6f23dc08d3624daab7094b701aa3954923c6bbb`.
- Package: `nodejs_22`, version **22.14.0** in this archive.
- Source: https://github.com/NixOS/nixpkgs/blob/e6f23dc08d3624daab7094b701aa3954923c6bbb/pkgs/development/web/nodejs/v22.nix
- package.json and lockfile engines: `>=22.13.0` (PDF.js requirement).
- Install: `node backend/scripts/check-runtime.js --deployment`, then
  `npm --prefix backend ci --omit=optional`.
- Build: `npm --prefix backend run test:syntax`, then
  `npm --prefix backend run test:static`.
- Start: `npm --prefix backend start`.

The pre-install check fails if Node is not exactly 22.14.0 or the checked-in
configuration drifts. The pin is reproducible, not an automatic security-update
policy: future Node updates must update and revalidate the archive and check.
No Railway service settings or production deployment are changed by this branch.

On a Linux host with Nixpacks CLI and Docker, from repository root:

```sh
nixpacks build . --config nixpacks.toml --name swipsales-cv-review
docker run --rm --entrypoint node swipsales-cv-review backend/scripts/check-runtime.js --deployment
docker run --rm --entrypoint npm swipsales-cv-review --prefix backend test
docker run --rm -p 3000:3000 --env-file /path/to/test-only.env swipsales-cv-review
curl --fail http://localhost:3000/
curl --fail http://localhost:3000/api/config
```

Use an isolated test environment, not production credentials. This workstation
has no Docker or Nixpacks CLI, and WSL reports not installed. An actual Linux
image build was **not** performed. Local install, tests and app HTTP smoke are
performed with Windows Node 22.14.0; they do not establish Linux image validity.

## Dependencies / Canvas

PDF.js stays pinned to `pdfjs-dist@6.3.289`. No new npm dependency is added.
`@napi-rs/canvas` is optional upstream; the lockfile retains its reproducible
resolution and platform packages, but install uses `--omit=optional` and
`backend/.npmrc` defaults to omission. Text extraction does not render pages.
PDF fixtures cover compressed, embedded-font, multipage, scanned, protected and
near-8-MiB documents without the native Canvas package installed.

## DOCX safety

ZIP parsing and inflate run in a worker, sharing the PDF pool (two workers per
process, 30-second deadline, 128-MiB V8 old-generation limit). The latter is not
a process RSS or native-allocation ceiling.

Before any decompression, validate central directory and local headers, bounds,
methods, names, duplicates, encryption, and all selected XML sizes. Only
`word/document.xml`, headers and footers are decompressed; media is ignored.
Limits: 512 directory entries; 1 MiB per XML entry; 4 MiB aggregate selected XML;
maximum 200:1 expansion. ZIP64/multidisk are unsupported. zlib `maxOutputLength`
also enforces the smaller of declared size and effective ceiling, so lying
metadata cannot authorize a larger inflate. Actual lengths must match metadata.
No CRC verification is implemented. Final analysis remains limited to 30,000
characters; readable oversized text is exposed for manual editing, not truncated.

The adversarial fixture reproduces 16,488 compressed bytes containing roughly
16 MiB of text. Honest metadata is rejected before inflate; fake 100,000-byte
metadata is stopped by zlib. Tests then successfully extract a normal document
and exercise the HTTP service after rejection.

## Timeout recovery and limits

No schema or SQL migration. Existing quota reservation/finalization semantics
and quota values remain unchanged. A durable cross-instance idempotency key
would require separately designed persistent request state and atomic handling;
this change implements the authorized history-reconciliation alternative.

Before POST the browser snapshots the ten most recently created owned analyses
and saves a SHA-256 fingerprint of normalized inputs, previous IDs and start
time in user-scoped sessionStorage. No CV, offer or token is stored in this
marker. History returns the same fingerprint but no raw source/offer fields.
Ambiguous POST failures preserve the marker across reloads and block new POSTs.
The recovery button performs GET only, matching a new ID and exact fingerprint.
Old matching results and new unrelated results do not unlock the pending request.

After at least three minutes AND a successful empty reconciliation, an explicit
retry authorization is offered with a double-consumption warning. It does not
POST automatically. Failed history requests never authorize retry.
This is not server idempotence: a late completion after explicit retry, another
tab/device, cleared sessionStorage, or a direct API client can still duplicate a
request. Closing the tab loses the marker. History is limited to ten records;
heavy parallel use can hide a completed result. These cases are not silently
reported as a guarantee of single consumption.

## Privacy

Assistant error logs contain an allowlisted public code, fixed diagnostic
categories and finite nonnegative numbers only. JSON.parse exception messages,
provider messages, stack traces and arbitrary diagnostic strings are excluded.
CV storage cleanup errors also use fixed messages. Worker stdout/stderr is
consumed without forwarding document diagnostics. Tests capture log/warn/error/
info/debug with a secret marker in invalid AI JSON and exception fields and
assert it occurs in none of the captured logs.

## Local validation (2026-09-24)

- Clean `npm --prefix backend ci --omit=optional` under Node 22.14.0:
  164 packages installed, 165 audited, zero reported vulnerabilities.
- `check-runtime.js --deployment`: passed with Node 22.14.0.
- `npm test`: 368 passed, zero failed/skipped; Node syntax on 103 JS files,
  static HTML check on 10 files.
- Actual app imported from server.js and listening on ephemeral loopback port,
  with dotenv loading disabled and fictitious credentials: `/` and `/api/config`
  both 200; public DOCX bomb upload 422, followed by normal DOCX upload 200.
  No authenticated production or live AI call was made.
- Canvas module resolution fails as expected after omission; extraction passes.
- Review bomb: 16,488 bytes, rejection in 62 ms in this run. This is a timing
  observation, not a process RSS bound; the metadata-only test proves rejection
  before any inflate of the honest-size bomb.
- Image-heavy PDF: 8,346,764 bytes, 252 text characters, extraction in 332 ms.
- Personal diff review and `git diff --check`: passed.
