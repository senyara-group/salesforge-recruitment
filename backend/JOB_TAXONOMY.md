# Job taxonomy foundation

Base audited: 22b8c0b39e709ce3a8c0b04c610d35751212d87d.
No production database inspection, migration, backfill or deployment performed.
The contracts below describe the repository's writers/readers, not measured DB contents.

## Authoritative registry

`utils/yannisTaxonomies.js`: immutable `JOB_TYPES` descriptors, in existing order:

- `sdr`: SDR / BDR
- `bizdev`: Business Developer
- `ae`: Account Executive
- `terrain`: Commercial terrain
- `kam`: Key Account Manager
- `manager`: Manager commercial

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

## Consumers and compatibility

- `candidateProfileWrite`: canonical label normalization, arrays and unknown
  legacy text preserved. Existing generic request parsing is otherwise unchanged.
- `offerWrite` and `offerDeckQuery`: consume the existing exported list/helper;
  unknown text remains governed by their previous contracts.
- `candidateDeckQuery`: exact label overlap remains unchanged; no new alias
  normalization in filters and no matching/scoring change.
- `filterTaxonomies`: existing export now derives from the registry.
- ADN: `PROFILE_QUESTIONS` retains the six IDs and every question/option;
  its labels and job buttons are generated from the registry.
- `routes/ai`: unchanged questionnaire, score formula, type_poste write and history.
- `candidats/benchmark`: unchanged scalar cohort. Evaluations retain original JSON.
- `bilanCarriere`: independent `reponses.b0.poste` / `bilans_carriere.type_poste`,
  unchanged; not the current Deep ADN questionnaire.
- Profile title, application snapshots, CV target_role and Coach contexts are
  independent free-text/snapshot fields, not rewritten through this registry.

Unknown labels and arbitrary historical text are possible because the previous
writers were open. Do not discard those values because the registry cannot resolve
them. This foundation does not harden every generic parser or rewrite persisted data.

## Static frontend generation

Run from repository root:

```sh
npm --prefix backend run taxonomy:sync
npm --prefix backend run taxonomy:check
npm --prefix backend test
```

`scripts/sync-job-taxonomy.js` generates checked-in content in:

- candidat.html: `job-type-opts`, `PROFILE_PREF_SUGGESTIONS.target_job_types`,
  and labels in `PROFILE_QUESTIONS`;
- recruteur.html: `filt-job-types`.

The browser still receives the same static HTML/JS: no runtime dependency, new
endpoint or network request. `test:static` checks synchronization, including in
the existing Railway build. The generator preserves line endings and fails when
anchors are absent/ambiguous. Generated copies are artifacts, not independently
maintained lists. For this foundation, the HTML changes are comments only.

## Deliberately separate lists

- ADN preference chips (`closer`, `sales`, `sdr`, `ae`, `head`, `se`) are a different
  historical vocabulary from the single-job question. Keep payloads unchanged.
- Free-text recruiter title suggestions contain many job titles outside the six
  categories; they must not be narrowed to the registry.
- Offer job_type and candidate search job_type inputs remain free text.
- Marketing examples and tests' expected historical contracts are not runtime
  registries. Question content and ID-keyed modules remain explicit.

## Adding a job later

1. Obtain the approved product label and decide its assessment module separately.
2. Add one descriptor in `JOB_TYPES`, with a new durable lowercase ID, following
   the existing ID convention. Never rename the six existing IDs or stored labels.
3. Add an alias only when an exact historical equivalence is established; test it.
   Do not confuse a related profession or an ADN preference token with an alias.
4. The generator requires a `PROFILE_QUESTIONS` module for each active ADN choice.
   It deliberately fails if missing. Adding a profession without changing ADN
   requires a separately approved per-surface availability policy; do not invent
   questions or silently skip the module to make the command pass.
5. Run taxonomy:sync. Profile suggestions, recruiter filter chips, ADN buttons and
   question labels are generated; backend TARGET_JOB_TYPES derives automatically.
6. The legacy preference chips, free-title suggestions and assessment content need
   explicit product decisions; no automatic remapping occurs there.
7. No enum migration is required by existing text/text[] columns. A storage-ID
   migration, assessment redesign or backfill is a separate project.
8. Extend ID/label/order/alias/invalid-input tests and profile/offer/filter contracts;
   check generation and rerun the full suite. Review scoring consequences before
   changing questionnaire data: the current ADN scorer depends on serialized size.
