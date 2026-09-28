# Job taxonomy foundation

Base audited: 22b8c0b39e709ce3a8c0b04c610d35751212d87d.
No production database inspection, migration, backfill or deployment performed.
The contracts below describe the repository's writers/readers, not measured DB contents.

## Authoritative registry

`utils/yannisTaxonomies.js`: `JOB_TYPE_DESCRIPTORS`, in existing order:

- `sdr`: SDR / BDR
- `bizdev`: Business Developer
- `ae`: Account Executive
- `terrain`: Commercial terrain
- `kam`: Key Account Manager
- `manager`: Manager commercial

They are validated and frozen by `createJobTaxonomy()` (`utils/jobTaxonomy.js`)
when the module loads; an invalid registry throws a `JobTaxonomyError` (server,
tests and taxonomy:check all fail closed).

IDs are the existing `ADN.job_profile.poste` / `candidats.type_poste` codes.
`TARGET_JOB_TYPES` is derived from active descriptor **labels** because profile
`target_job_types text[]` and offer `job_type text` persist labels. Do not switch
these columns to IDs as part of a cleanup.

Helpers: `activeJobTypes`, `jobTypeById`, `isJobTypeId`, `resolveJobTypeLabel`,
`resolveStoredJobType`, `jobTypeLabel`, `canonicalizeTargetJobType`.
Invalid/non-string inputs return null (false for validation); no string coercion.
Exact IDs are read separately from labels. Label resolution preserves the existing
trim + case-insensitive behavior. There were no semantic job aliases in the old
normalizer: aliases are empty. BDR, Closer, Sales, Head of Sales and Sales Engineer
are NOT silently mapped to one of the six jobs.

### Descriptor contract

`{ id, label, active?, aliases? }`, no other key.

- `id`: `/^[a-z][a-z0-9_]{0,39}$/` (interpolated in onclick handlers and JS keys).
- `label` and each alias: string, non-empty, no leading/trailing whitespace, no
  control character (CR, LF, TAB, C0/C1) nor U+2028/U+2029, at most 80 chars.
  Apostrophes, quotes, `&`, `<`, `>`, backslashes and `</script>` sequences are
  supported: HTML output is entity-escaped, JS output is a quoted literal with `<`
  written as `<`. The generator decodes its own output and fails if any
  label does not round-trip exactly.
- `active`: boolean, default true. At least one job must be active.

### Collisions

Normalization is exactly the resolver's: `value.trim().toLowerCase()`.
Every token must resolve to at most one job, inactive jobs included. Refused:
duplicate ID; two labels equal after normalization; an alias equal (normalized)
to any label or alias, including its own job's; a label or alias equal to another
job's ID (reads try exact IDs first, so it would be ambiguous). Resolution uses a
prebuilt map: there is no "first match wins".

### Inactive jobs (`active: false`)

- Reads (`jobTypeById`, `resolveJobTypeLabel`, `resolveStoredJobType`,
  `jobTypeLabel`): still resolve, so stored IDs/labels stay readable.
- New choices: absent from `TARGET_JOB_TYPES`, ADN buttons, profile suggestions
  and recruiter filter chips. No ADN module is required or generated.
- Writes: `canonicalizeTargetJobType` returns null for an inactive job. Writers
  that keep unknown text (profile `target_job_types`, offer `job_type`) therefore
  store the submitted text verbatim: an old value round-trips through a profile
  save, it is never rewritten, dropped or remapped to another job. Offer deck
  filters only accept active labels, as before.
- An inactive job keeps its ID/label/aliases reserved (collision checks).

## Consumers and compatibility

- `candidateProfileWrite`: canonical label normalization, arrays and unknown
  legacy text preserved. Existing generic request parsing is otherwise unchanged.
- `offerWrite` and `offerDeckQuery`: consume the existing exported list/helper;
  unknown text remains governed by their previous contracts.
- `candidateDeckQuery`: exact label overlap remains unchanged; no new alias
  normalization in filters and no matching/scoring change.
- `filterTaxonomies`: existing export now derives from the registry.
- ADN: `PROFILE_QUESTIONS` retains the six IDs and every question/option; it is
  generated from the registry (labels) and `utils/adnProfileQuestions.js` (q1/q2).
- `routes/ai`: unchanged questionnaire, score formula, type_poste write and history.
- `candidats/benchmark`: unchanged scalar cohort. Evaluations retain original JSON.
- `bilanCarriere`: independent `reponses.b0.poste` / `bilans_carriere.type_poste`,
  unchanged; not the current Deep ADN questionnaire.
- Profile title, application snapshots, CV target_role and Coach contexts are
  independent free-text/snapshot fields, not rewritten through this registry.

Unknown labels and arbitrary historical text are possible because the previous
writers were open. Do not discard those values because the registry cannot resolve
them. This foundation does not harden every generic parser or rewrite persisted data.

## ADN module contract

`utils/adnProfileQuestions.js` holds `{ [jobId]: { q1, q2 } }`, derived from the
current candidat.html flow: `selectJobType` -> `renderProfileQuestion(1)` ->
`renderProfileQuestion(2)` -> `submitADN`, so both questions are always rendered.

- Every active job needs a module; a module for an unknown ID is refused.
- Module keys: exactly `q1`, `q2`. `label` is refused: it is generated from the
  registry (`poste_label` sent by `submitToAPI`).
- Question keys: exactly `text` (safe text, max 200) and `options`: array of
  2 to 8 safe, distinct (normalized) strings, max 120 each.

A label-only module, a missing question, a missing/blank text or invalid options
make taxonomy:sync and taxonomy:check fail before anything is written.

## Static frontend generation

Run from repository root:

```sh
npm --prefix backend run taxonomy:sync
npm --prefix backend run taxonomy:check
npm --prefix backend test
```

`scripts/sync-job-taxonomy.js` regenerates marker-delimited zones:

| File | Zone | Content |
| --- | --- | --- |
| candidat.html | `CANDIDATE_ADN_JOB_BUTTONS` | `job-type-opts` buttons (IDs + labels) |
| candidat.html | `CANDIDATE_PROFILE_SUGGESTIONS` | `PROFILE_PREF_SUGGESTIONS.target_job_types` |
| candidat.html | `CANDIDATE_ADN_QUESTIONS` | whole `PROFILE_QUESTIONS` object |
| recruteur.html | `RECRUITER_FILTER_CHIPS` | `filt-job-types` chips |

Boundaries are only the marker lines: `<!-- JOB_TAXONOMY:<ZONE>:START -->` /
`<!-- JOB_TAXONOMY:<ZONE>:END -->` in HTML, `// JOB_TAXONOMY:<ZONE>:START` /
`// JOB_TAXONOMY:<ZONE>:END` in JS. Each must appear exactly once in its file,
alone on its line, START before END, zones may not overlap, and any unknown
`JOB_TAXONOMY:` marker is refused. Only lines strictly between the two markers
are rewritten; indentation of surrounding tags plays no role. Do not edit inside
a zone by hand: taxonomy:check reports it as drift.

Transactional behavior: all files are read, the registry and ADN modules are
validated, every output is rendered and verified in memory (markers, decoded
round-trip of IDs/labels/questions, no `</script`/`<!--` in JS zones, every
inline script compiles, second rendering is identical). Only then are files
written, through temporary files renamed into place; if a rename fails, already
replaced files are restored. Any validation error means zero file modified.

`taxonomy:check` (also run first by `npm test` and by `test:static`, which the
Railway build runs) fails on drift, invalid registry, invalid ADN module,
collision or invalid markers, and prints the correction to apply. The browser
still receives the same static HTML/JS: no runtime dependency, endpoint or request.

## Deliberately separate lists

- ADN preference chips (`closer`, `sales`, `sdr`, `ae`, `head`, `se`) are a different
  historical vocabulary from the single-job question. Keep payloads unchanged.
- Free-text recruiter title suggestions contain many job titles outside the six
  categories; they must not be narrowed to the registry.
- Offer job_type and candidate search job_type inputs remain free text.
- Marketing examples and tests' expected historical contracts are not runtime
  registries.

## Adding a job later

1. Obtain the approved product label and decide its assessment module separately.
2. Add one descriptor in `JOB_TYPE_DESCRIPTORS`, with a new durable lowercase ID.
   Never rename the six existing IDs or stored labels.
3. Add an alias only when an exact historical equivalence is established; test it.
   Do not confuse a related profession or an ADN preference token with an alias.
4. Add a complete `{ q1, q2 }` module in `utils/adnProfileQuestions.js`. Sync fails
   without it; do not invent questions or add a placeholder to make it pass.
5. Run taxonomy:sync. Profile suggestions, recruiter filter chips, ADN buttons and
   `PROFILE_QUESTIONS` are generated; backend TARGET_JOB_TYPES derives automatically.
   The fixture test "future job simulation: technico_commercial" shows the result.
6. The legacy preference chips, free-title suggestions and assessment content need
   explicit product decisions; no automatic remapping occurs there.
7. No enum migration is required by existing text/text[] columns. A storage-ID
   migration, assessment redesign or backfill is a separate project.
8. Retiring a job: set `active: false`, never delete the descriptor (see above).
9. Review scoring consequences before changing questionnaire data: the current ADN
   scorer depends on serialized size.
