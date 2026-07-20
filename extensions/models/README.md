# @mgreten/graphite-stack

A [swamp](https://swamp.club) model for the composition lifecycle of a
[Graphite](https://graphite.dev) (`gt`) multi-PR stack. A stack is an ordered,
strictly **linear** chain of PR units — each unit is exactly one commit ahead of
its declared parent — plus a composed head the whole stack validates against.
The single-commit / single-PR contract is kept **per unit**, so a stack of N
units is N commits, each on its own branch and its own draft PR. A length-1
stack degenerates cleanly to an ordinary single-PR flow.

Its defining invariant: every base relation is a declared **field**
(`baseUnit`), never inferred from `gt log` or a branch-name convention. Live
parentage is always read from `git` and compared against the declared plan — it
is never trusted from Graphite's own view. That is what lets the model reject a
drifted, collapsed, or non-linear stack instead of silently shipping it.

## Installation

```sh
swamp extension pull @mgreten/graphite-stack
```

## Setup

Create a model instance. The only global argument is the repository base branch
used when a `submitStack` call does not pass one explicitly:

```sh
swamp model create graphite-stack \
  --type @mgreten/graphite-stack \
  --global-arg defaultBaseBranch=main
```

## Usage

Drive one stack through its lifecycle by its path-safe `stack` identifier.
Validate the plan, finalize each unit's commit, restack after a lower-unit
patch, validate the composed head, then submit:

```sh
# 1. Validate + persist a declared linear plan
swamp model method run graphite-stack validateStackPlan \
  --arg stack=feature-x \
  --arg-json plan='{"baseBranch":"main","policyVersion":"1","units":[...]}'

# 2. Assert unit 0 is exactly one commit ahead of the repo base
swamp model method run graphite-stack finalizeStackUnitCommit \
  --arg stack=feature-x --arg index=0 \
  --arg repoPath=/abs/path/to/repo \
  --arg unitBaseSha=<40-char-sha> \
  --arg expectedBranch=feature-x-0 --arg baseBranch=main

# 3. Cascade a restack after patching a lower unit
swamp model method run graphite-stack restackAbove \
  --arg stack=feature-x --arg patchedIndex=0 \
  --arg repoPath=/abs/path/to/repo \
  --arg-json plan='{...}'

# 4. Pin the composed head over the ordered tips
swamp model method run graphite-stack validateComposedHead \
  --arg stack=feature-x --arg repoPath=/abs/path/to/repo \
  --arg-json plan='{...}' --arg-json unitTipShas='["<sha0>","<sha1>"]'

# 5. Submit gated, idempotent, ordered draft PRs
swamp model method run graphite-stack submitStack \
  --arg stack=feature-x --arg repoPath=/abs/path/to/repo \
  --arg baseBranch=main --arg-json plan='{...}' \
  --arg-json unitTipShas='["<sha0>","<sha1>"]'
```

## Global Arguments

| Argument            | Type   | Default | Description                                                          |
| ------------------- | ------ | ------- | -------------------------------------------------------------------- |
| `defaultBaseBranch` | string | `main`  | Repo base branch used when `submitStack` receives no `baseBranch`.   |

## Method: validateStackPlan

Validates a declared plan and persists it as `stack-plan-<stack>`. Enforces a
strict linear chain and a complete, non-overlapping acceptance-criterion
partition. Throws and writes nothing on any inferred, cyclic, gapped, or
duplicate ordering, or a criterion assigned to two units or to none.

| Argument | Type      | Description                                        |
| -------- | --------- | -------------------------------------------------- |
| `stack`  | string    | Path-safe stack identifier; names all records.     |
| `plan`   | StackPlan | The declared base branch plus ordered linear units.|

## Method: finalizeStackUnitCommit

Asserts one unit is clean, parented on its declared base, and exactly one commit
ahead, then persists `stack-unit-<stack>-<index>` evidence pinned to the unit's
base and head SHA. Fails closed on a multi-commit unit or a wrong parent.

| Argument         | Type   | Description                                          |
| ---------------- | ------ | ---------------------------------------------------- |
| `stack`          | string | Stack identifier.                                    |
| `index`          | number | Zero-based unit index.                               |
| `repoPath`       | string | Absolute path to the working tree.                   |
| `unitBaseSha`    | string | Full 40-char SHA of the unit's declared parent head. |
| `expectedBranch` | string | Branch the unit must be checked out on.              |
| `baseBranch`     | string | Human-readable base branch recorded on the evidence. |

## Method: restackAbove

Rebases every unit above a patched unit onto its new parent head via
`git rebase --onto`, asserts each stays exactly one commit ahead and linear,
and records a `stack-restack-<stack>` audit trail marking every affected unit
stale so its evidence is regenerated. The cascade is bounded by the unit count.

| Argument       | Type      | Description                             |
| -------------- | --------- | --------------------------------------- |
| `stack`        | string    | Stack identifier.                       |
| `patchedIndex` | number    | Index of the unit whose commit changed. |
| `plan`         | StackPlan | The declared linear plan.               |
| `repoPath`     | string    | Absolute path to the working tree.      |

## Method: validateComposedHead

Asserts the live stack is linear and each unit's actual parent matches the
declared plan (read from git, never `gt log`), then pins the composed head and
the ordered per-unit tips into `composed-head-validation-<stack>`. Rejects any
mixed or stale SHA.

| Argument      | Type      | Description                                     |
| ------------- | --------- | ----------------------------------------------- |
| `stack`       | string    | Stack identifier.                               |
| `plan`        | StackPlan | The declared linear plan.                       |
| `repoPath`    | string    | Absolute path to the working tree.              |
| `unitTipShas` | string[]  | Ordered per-unit tip SHAs (bottom-up).          |

## Method: submitStack

Submits the stack bottom-up as gated, idempotent, ordered draft PRs:
`gt track --parent` from the declared plan, reuse a conforming open draft PR if
one exists (no duplicate on resume), else `gt submit --draft`, and verify each
resulting PR's head/base/draft state. Persists per-unit `stack-draft-pr-*`
records and a composed `stack-draft-prs-<stack>`, and fails via a collapse guard
unless the submitted-or-reused PR count equals the declared unit count.

| Argument      | Type      | Default | Description                                     |
| ------------- | --------- | ------- | ----------------------------------------------- |
| `stack`       | string    | —       | Stack identifier.                               |
| `repoPath`    | string    | —       | Absolute path to the working tree.              |
| `baseBranch`  | string    | `main`  | Repo base branch for the bottom unit.           |
| `plan`        | StackPlan | —       | The declared linear plan.                       |
| `unitTipShas` | string[]  | —       | Ordered per-unit tip SHAs (bottom-up).          |

## How It Works

The model shells out to three pure CLIs — `git`, `gt` (Graphite), and `gh`
(GitHub) — and stores structured records via swamp's resource model. It does no
issue-tracker reconciliation and holds no service credentials; authentication is
whatever `gt` and `gh` already have configured in the working tree.

Parentage is always the ground truth: it is read from `git` (`rev-parse`,
`rev-list --count`, `HEAD^`) and compared against the declared plan. Restacks
use `git rebase --onto <newBase> <oldBase> <branch>` so they are deterministic
and independent of the installed `gt` version, and a failed rebase is aborted so
the worktree is left clean. Submission is idempotent: a conforming open draft PR
found via `gh pr list --head <branch>` is reused rather than re-created, so a
re-run after an interruption submits only the missing units.

**Prerequisites:** a working `git` repository with the stack branches present,
plus authenticated `gt` and `gh` CLIs on `PATH` for `submitStack`.

## License

MIT — see LICENSE for details.
