# Upstream sync ledger (fork-only)

Upstream is <https://github.com/openhwfoundation/uap> (`main`). It is a
**read-only data feed** for this branch: the IP/Task split that lives here is a
fork-side redesign and is *not* offered upstream, so every upstream data
contribution arrives in the old format and has to be **translated**, not merged.
This page is the record of those translations and of the procedure that keeps
them repeatable.

- Upstream remote: `upstream` → `git@github.com:openhwfoundation/uap.git`
  (read-only here; `origin` is the OpenHW upstream clone kept for history,
  `origin_cairo` is the fork that carries this branch).
- Branch: `ip_centered`. Commits, pushes and PRs are the maintainer's — tooling
  edits the working tree and stops.
- `scripts/upstream_audit.py` is the gate: run it **before** and **after** every
  sync. `docs/upstream-audit.md` is its output, regenerate and review it, do not
  hand-edit it.

## Procedure

1. `git fetch upstream --prune --tags` — nothing else touches git state.
2. Enumerate the delta: `git log --oneline --no-merges <last-synced>..upstream/main`
   and `git diff --name-status <last-synced>..upstream/main`.
3. `python3 scripts/upstream_audit.py --upstream-ref upstream/main --base-ref <last-synced> --out docs/upstream-audit.md`
   → the porting to-do list. Pass `--base-ref` explicitly: it defaults to
   `--upstream-ref`, and with base == upstream there is no delta left for
   `CHANGED`/`NEW-UPSTREAM`/`REMOVED` to describe.
4. Translate the data (see the field routing below), then
   `python3 scripts/build_catalog.py` — `cfg/catalog.json` is generated, never
   merged and never hand-edited.
5. `git merge --no-commit --no-ff upstream/main` and resolve with the policy
   table below. **Stop there**: leave the merge uncommitted for review
   (`git merge --abort` is always available).
6. Validate: `python3 scripts/validate_ips.py --strict`,
   `python3 scripts/build_catalog.py --check`,
   `python3 scripts/gen_migration_map.py`, `python3 scripts/check_diagrams.py`,
   `node --check script.js && node --check editor.js`; then re-run the audit
   **with step 3's `--upstream-ref`/`--base-ref`/`--out`** plus
   `--fail-on-missing --fail-on-changed` (`MISSING`/`NEW-UPSTREAM`/`CHANGED` must
   be 0 — `--fail-on-changed` is meaningless without the explicit base ref). The
   exit-code gate says nothing about `PARTIAL` and `FIELD-DIFF` (2026-11-05:
   still 107 and 159 respectively) — those are review-only by design, not
   unported work. Finally run the *regression* form
   `--upstream-ref <last-synced> --base-ref <last-synced>` with its own `--out`
   (never `docs/upstream-audit.md`) to prove the port dropped no upstream row
   (`MISSING` must be 0).
7. Add a dated entry to the ledger below.

### Git hygiene

- Merge with `--no-commit --no-ff` only. No `commit`, `add`, `stash`, `reset`,
  `rebase`, `checkout <branch>` or `tag` from tooling; no branch switching.
- `git merge` writes conflict resolutions into the **index** as part of merging
  (that is merge bookkeeping, `git rm` of a resolved path included). Everything
  the sync produces besides the merge itself — the audit report, the new
  scripts, regenerated `cfg/catalog.json` — stays unstaged or untracked.
- Finish by handing over `git status --short` and `git diff --stat`.

## Conflict policy

The two layouts use the **same paths with incompatible shapes**: upstream
`ips/<project>.json` is an array of rows, here it is one file per IP under
`ips/` plus `projects/<project>.json` tasks, so upstream edits under those paths
are always modify/delete conflicts.

| Path | Policy |
|---|---|
| `ips/isolde.json`, `ips/tristan.json`, `ips/rebecca.json`, `ips/rigoletto.json`, `ips/scale4edge.json`, `cfg/schema.json` | keep the branch deletion (the content lives in `ips/<id>.json` + `projects/`); apply the upstream delta through the audit first, then `git rm` the path |
| `cfg/catalog.json` | never resolve textually — `python3 scripts/build_catalog.py` |
| `cfg/repo-stats.json` | take ours, then `python3 scripts/fetch_repo_stats.py --only-missing` (or let the weekly `repo_stats` job refresh it); the upstream bot commit must not create review noise |
| `cfg/categories.json`, `cfg/partners.json`, `cfg/licenses.json`, `cfg/projects.json`, `cfg/compatibility-matrix.json` | take the upstream additions, re-apply the branch deltas (extra `DSP` category, IP-id-based `ipName` matrix mapping), then re-validate. When upstream **renames** a `cfg/partners.json` entry, keep the old name in `aliases`: branch data still references it and validation resolves every `Owner`/`Partner` by name or alias (see the 2026-11-05 entry) |
| `script.js`, `editor.js`, `unified-access.html`, `editor.html`, `help.html`, `index.html`, `style.css` | keep ours (card grid, detail drawer, schema-driven editor); hand-port only genuine upstream fixes |
| `.github/workflows/*`, `.gitlab-ci.yml` | keep ours (`build_catalog`, `repo_stats`, `validate_ips --strict` jobs); re-check upstream job edits |
| `README.md`, `CONTRIBUTING.md`, `DEPLOYMENT.md`, `CITATION.cff` | keep our text, port genuinely new upstream wording; do not add upstream-contribution instructions — this redesign stays in the fork unless the maintainer opens a PR personally |
| `docs/**`, `projects/**`, `scripts/upstream_audit.py` | ours — upstream has no equivalent |

### Field routing when translating a row

A `Status` change on an IP applies to `ips/<id>.json` **and** to the Tasks on
that IP whose `Status` still holds the previous value: a Task status follows the
IP it reports on, but a Task that deliberately says something else keeps its
wording. Never write into a shared IP document (PikeOS, XNG, TCCP) just because
one row changed — the audit restricts itself to documents mirroring the row by
name, URL or `WI` provenance for exactly that reason. A Task without an
upstream work item gets `WI: "TBD"` plus a `PROVISIONAL:` comment.

## Ledger

| Date | Upstream tip | Base synced | Commits reviewed | Adaptations | Upstream PRs observed |
|---|---|---|---|---|---|
| 2026-11-02 | `74625780` | `2fbedcc` | 43 data commits of the earlier port | full monolith → IP/Task translation: 58 IP docs updated, 3 created, 2 removed, 7 renamed, 4 new ISOLDE Tasks; `Status`/`Description` mirrored only where this branch held the upstream-old value or a placeholder; `git merge --no-ff --no-commit` left uncommitted | — |
| 2026-11-05 | `97545bcb` | `74625780` | 1 (`Update isolde.json (#214)`) | `ips/tccp.json` `Status` `Prototype.` → `Released`; Tasks `isolde-3.3.02`, `isolde-4.3.02` `Status` `Prototype.` → `Released` (status follows the IP); `cfg/catalog.json` regenerated; audit + this ledger added; merge of `upstream/main` left uncommitted. Also repaired a **latent break inherited from 2026-11-02**: that merge took upstream's rename of the `cfg/partners.json` entry to "Eclipse Foundation - OpenHW Foundation WG" and dropped the old name, so `validate_ips.py --strict` and `build_catalog.py --check` failed on 10 `Owner`/`Partner` references at HEAD; re-adding `"OpenHW Foundation"` to `aliases` fixes it (rule added to the policy table above) | #206 Polimi ISOLDE WP3 IPs, #204 UzL contribution, #197 ACP ISOLDE IP description+link, #194 software context-aware IPs — all four edit `ips/isolde.json` and will need translating when they land |

## Delta classification (2026-11-05: `74625780` → `97545bcb`)

| Upstream path | Bucket | Target here | Action |
|---|---|---|---|
| `ips/isolde.json` | **A** — data | `ips/tccp.json` + `projects/isolde.json` (`isolde-3.3.02`, `isolde-4.3.02`) | translate the two `Status` edits (PR #214), then `git rm` the conflicted path |
| `cfg/*` registries | **B** | same path here | none in this range |
| app code (`script.js`, `*.html`, `style.css`) | **C** | ours | none in this range |
| CI / `scripts/` | **D** | ours (this branch carries more) | none in this range |
| docs | **E** | ours | none in this range |

Upstream rows are only 255 in total across the five project arrays; the audit
matches every one of them to a Task, so `MISSING: 0` is the standing
invariant that a sync must preserve.

## Known open questions

- `0e2344bf` *"Local instrumentation/tooling - not to be merged in principle"*
  is on this branch; it must be excluded from any future upstream-facing PR.
- Upstream issue #145 (*"Change the UAP from Task-Centric to IP-Centric"*) is
  the upstream tracking issue for exactly this redesign. Upstreaming stays the
  maintainer's decision; until then this ledger is the only link between the
  two layouts.
- Four open upstream PRs edit `ips/isolde.json`; none is merged as of
  2026-11-05. Landing any of them re-opens the translation loop.
