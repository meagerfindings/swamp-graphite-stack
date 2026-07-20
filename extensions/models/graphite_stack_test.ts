import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import {
  ComposedHeadValidationSchema,
  model,
  StackDraftPrsSchema,
  StackPlanSchema,
  StackRestackSchema,
  StackUnitEvidenceSchema,
  validateStackShape,
} from "./graphite_stack.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

function runtimeContext() {
  const test = createModelTestContext({
    globalArgs: { defaultBaseBranch: "main" },
  });
  return {
    ...test,
    context: Object.assign(test.context, {
      globalArgs: { defaultBaseBranch: "main" },
    }),
  };
}

function stackPlan(
  count: number,
  overrides: Partial<z.infer<typeof StackPlanSchema>> = {},
): z.infer<typeof StackPlanSchema> {
  const units = Array.from({ length: count }, (_, i) => ({
    index: i,
    key: `unit-${i}`,
    title: `Unit ${i}`,
    baseUnit: i === 0 ? null : i - 1,
    branch: `demo-200-${i}`,
    acceptanceCriterionIds: [`criterion-${i}`],
    scope: `scope for unit ${i}`,
  }));
  return { baseBranch: "main", policyVersion: "1", units, ...overrides };
}

Deno.test("StackPlanSchema: a valid multi-unit linear chain parses and validateStackShape accepts it", () => {
  const plan = StackPlanSchema.parse(stackPlan(3));
  assertEquals(plan.units.length, 3);
  assertEquals(plan.units[0].baseUnit, null);
  assertEquals(plan.units[1].baseUnit, 0);
  assertEquals(plan.units[2].baseUnit, 1);
  validateStackShape(plan);
});

Deno.test("validateStackShape: a degenerate one-unit plan (baseUnit:null) is legal", () => {
  const plan = StackPlanSchema.parse(stackPlan(1));
  validateStackShape(plan);
  assertEquals(plan.units.length, 1);
  assertEquals(plan.units[0].baseUnit, null);
});

Deno.test("validateStackShape: a non-adjacent baseUnit (unit 2 -> baseUnit 0) is rejected (not a linear chain)", () => {
  const plan = stackPlan(3);
  plan.units[2].baseUnit = 0;
  assertThrows(
    () => validateStackShape(plan),
    Error,
    "linear chain requires baseUnit === 1",
  );
});

Deno.test("validateStackShape: a cycle (unit 0 baseUnit points at another unit) is rejected", () => {
  const plan = stackPlan(2);
  plan.units[0].baseUnit = 1;
  assertThrows(
    () => validateStackShape(plan),
    Error,
    "index 0) must declare baseUnit:null",
  );
});

Deno.test("validateStackShape: a gap in indices (0,1,3) is rejected", () => {
  const plan = stackPlan(3);
  plan.units[2].index = 3;
  plan.units[2].baseUnit = 2;
  assertThrows(
    () => validateStackShape(plan),
    Error,
    "gap",
  );
});

Deno.test("validateStackShape: a duplicate index is rejected", () => {
  const plan = stackPlan(3);
  plan.units[2].index = 1;
  assertThrows(
    () => validateStackShape(plan),
    Error,
    "duplicate unit index 1",
  );
});

Deno.test("validateStackPlan: a valid multi-unit plan persists stack-plan-<stack> with base relations intact", async () => {
  const test = runtimeContext();
  await model.methods.validateStackPlan.execute(
    { stack: "demo-200", plan: stackPlan(3) },
    test.context,
  );
  const written = test.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].name, "stack-plan-demo-200");
  const persisted = StackPlanSchema.parse(written[0].data);
  assertEquals(persisted.units[0].baseUnit, null);
  assertEquals(persisted.units[1].baseUnit, 0);
  assertEquals(persisted.units[2].baseUnit, 1);
});

Deno.test("validateStackPlan: a degenerate one-unit plan persists and matches the single-PR shape (baseUnit:null)", async () => {
  const test = runtimeContext();
  await model.methods.validateStackPlan.execute(
    { stack: "demo-200", plan: stackPlan(1) },
    test.context,
  );
  const written = test.getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(StackPlanSchema.parse(written[0].data).units[0].baseUnit, null);
});

Deno.test("validateStackPlan: rejects an inferred (non-adjacent) ordering and writes nothing", async () => {
  const test = runtimeContext();
  const plan = stackPlan(3);
  plan.units[2].baseUnit = 0;
  await assertRejects(
    () =>
      model.methods.validateStackPlan.execute(
        { stack: "demo-200", plan },
        test.context,
      ),
    Error,
    "linear chain requires baseUnit === 1",
  );
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("validateStackPlan: rejects a cyclic plan and writes nothing", async () => {
  const test = runtimeContext();
  const plan = stackPlan(2);
  plan.units[0].baseUnit = 1;
  await assertRejects(
    () =>
      model.methods.validateStackPlan.execute(
        { stack: "demo-200", plan },
        test.context,
      ),
    Error,
    "baseUnit:null",
  );
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("validateStackPlan: rejects a gapped plan and writes nothing", async () => {
  const test = runtimeContext();
  const plan = stackPlan(3);
  plan.units[2].index = 3;
  plan.units[2].baseUnit = 2;
  await assertRejects(
    () =>
      model.methods.validateStackPlan.execute(
        { stack: "demo-200", plan },
        test.context,
      ),
    Error,
    "gap",
  );
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("validateStackPlan: rejects a duplicate-index plan and writes nothing", async () => {
  const test = runtimeContext();
  const plan = stackPlan(3);
  plan.units[2].index = 1;
  await assertRejects(
    () =>
      model.methods.validateStackPlan.execute(
        { stack: "demo-200", plan },
        test.context,
      ),
    Error,
    "duplicate unit index",
  );
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("validateStackPlan: rejects a criterion assigned to two units (overlap) and writes nothing", async () => {
  const test = runtimeContext();
  const plan = stackPlan(3);
  plan.units[1].acceptanceCriterionIds = ["criterion-0"]; // also on unit 0
  await assertRejects(
    () =>
      model.methods.validateStackPlan.execute(
        { stack: "demo-200", plan },
        test.context,
      ),
    Error,
    "criterion criterion-0 is assigned to units 0 and 1",
  );
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("validateStackPlan: rejects a plan that assigns no criteria (incomplete partition) and writes nothing", async () => {
  const test = runtimeContext();
  const plan = stackPlan(2);
  for (const unit of plan.units) unit.acceptanceCriterionIds = [];
  await assertRejects(
    () =>
      model.methods.validateStackPlan.execute(
        { stack: "demo-200", plan },
        test.context,
      ),
    Error,
    "partition must be complete",
  );
  assertEquals(test.getWrittenResources().length, 0);
});

// Build a real N-unit linear stack in a temp repo: unit 0 branches off the base
// branch and adds exactly one commit; unit k>0 branches off unit k-1's head and
// adds exactly one commit. Returns per-unit branch/base/head SHAs.
async function stackFixture(root: string, count: number): Promise<{
  repo: string;
  baseBranch: string;
  baseSha: string;
  units: { index: number; branch: string; baseSha: string; headSha: string }[];
}> {
  const repo = `${root}/repo`;
  await Deno.mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Runtime Test");
  await git(repo, "config", "user.email", "runtime@example.com");
  await Deno.writeTextFile(`${repo}/README.md`, "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "chore: base");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  const units: {
    index: number;
    branch: string;
    baseSha: string;
    headSha: string;
  }[] = [];
  let parentSha = baseSha;
  for (let i = 0; i < count; i++) {
    const branch = `demo-200-${i}`;
    await git(repo, "checkout", "-b", branch, parentSha);
    await Deno.writeTextFile(`${repo}/unit-${i}.ts`, `unit ${i}\n`);
    await git(repo, "add", `unit-${i}.ts`);
    await git(repo, "commit", "-m", `feat: unit ${i}`);
    const headSha = await git(repo, "rev-parse", "HEAD");
    units.push({ index: i, branch, baseSha: parentSha, headSha });
    parentSha = headSha;
  }
  return {
    repo: await Deno.realPath(repo),
    baseBranch: "main",
    baseSha,
    units,
  };
}

Deno.test("finalizeStackUnitCommit: a clean one-commit unit persists per-unit evidence pinned to its base and head SHA", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 2);
    const unit = fixture.units[1];
    await git(fixture.repo, "checkout", unit.branch);
    const test = runtimeContext();
    await model.methods.finalizeStackUnitCommit.execute(
      {
        stack: "demo-200",
        index: 1,
        repoPath: fixture.repo,
        unitBaseSha: unit.baseSha,
        expectedBranch: unit.branch,
        baseBranch: fixture.units[0].branch,
      },
      test.context,
    );
    const written = test.getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name, "stack-unit-demo-200-1");
    const evidence = StackUnitEvidenceSchema.parse(written[0].data);
    assertEquals(evidence.success, true);
    assertEquals(evidence.stale, false);
    assertEquals(evidence.unitBaseSha, unit.baseSha);
    assertEquals(evidence.unitHeadSha, unit.headSha);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("finalizeStackUnitCommit: a two-commit unit is rejected (must be re-scoped) and records a non-success evidence", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 1);
    const unit = fixture.units[0];
    await git(fixture.repo, "checkout", unit.branch);
    await Deno.writeTextFile(`${fixture.repo}/extra.ts`, "extra\n");
    await git(fixture.repo, "add", "extra.ts");
    await git(fixture.repo, "commit", "-m", "feat: second commit");
    const test = runtimeContext();
    await assertRejects(
      () =>
        model.methods.finalizeStackUnitCommit.execute(
          {
            stack: "demo-200",
            index: 0,
            repoPath: fixture.repo,
            unitBaseSha: unit.baseSha,
            expectedBranch: unit.branch,
            baseBranch: fixture.baseBranch,
          },
          test.context,
        ),
      Error,
      "must be re-scoped",
    );
    const written = test.getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(StackUnitEvidenceSchema.parse(written[0].data).success, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("finalizeStackUnitCommit: a unit whose parent SHA differs from its declared baseUnit head is rejected", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 2);
    const unit = fixture.units[1];
    await git(fixture.repo, "checkout", unit.branch);
    const test = runtimeContext();
    // Pass the WRONG declared base (the repo base rather than unit 0's head).
    await assertRejects(
      () =>
        model.methods.finalizeStackUnitCommit.execute(
          {
            stack: "demo-200",
            index: 1,
            repoPath: fixture.repo,
            unitBaseSha: fixture.baseSha,
            expectedBranch: unit.branch,
            baseBranch: fixture.units[0].branch,
          },
          test.context,
        ),
      Error,
      "does not match its declared base",
    );
    assertEquals(
      StackUnitEvidenceSchema.parse(
        test.getWrittenResources()[0].data,
      ).success,
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// Amend the given unit's single commit in place (rewriting its head SHA),
// simulating a verified-finding patch. Returns the new head SHA. The units
// ABOVE it are now stale (still parented on the old head) until a restack.
async function patchUnit(
  repo: string,
  branch: string,
  content: string,
): Promise<string> {
  await git(repo, "checkout", branch);
  await Deno.writeTextFile(`${repo}/patch.ts`, content);
  await git(repo, "add", "patch.ts");
  await git(repo, "commit", "--amend", "--no-edit");
  return await git(repo, "rev-parse", "HEAD");
}

Deno.test("restackAbove: patching unit 1 of a 3-unit stack restacks 1,2 with new SHAs and leaves unit 0 untouched", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 3);
    const unit0OldHead = fixture.units[0].headSha;
    const unit2OldHead = fixture.units[2].headSha;
    const newUnit1Head = await patchUnit(
      fixture.repo,
      fixture.units[1].branch,
      "patched unit 1\n",
    );
    const test = runtimeContext();
    await model.methods.restackAbove.execute(
      {
        stack: "demo-200",
        patchedIndex: 1,
        plan: stackPlan(3),
        repoPath: fixture.repo,
      },
      test.context,
    );
    const written = test.getWrittenResources();
    const audit = StackRestackSchema.parse(
      written.find((r) => r.name === "stack-restack-demo-200")!.data,
    );
    assertEquals(audit.patchedIndex, 1);
    assertEquals(audit.units.map((u) => u.index), [1, 2]);
    assert(audit.units.every((u) => u.stale));
    // Unit 0 was never restacked (not in the audit) and its head is unchanged.
    assertEquals(
      await git(fixture.repo, "rev-parse", fixture.units[0].branch),
      unit0OldHead,
    );
    // Unit 2 got a NEW head SHA.
    const unit2New = await git(
      fixture.repo,
      "rev-parse",
      fixture.units[2].branch,
    );
    assert(unit2New !== unit2OldHead);
    // Unit 2 is now parented on unit 1's new (patched) head — a linear chain.
    assertEquals(
      await git(fixture.repo, "rev-parse", `${fixture.units[2].branch}^`),
      newUnit1Head,
    );
    // Every affected unit's per-unit evidence was invalidated (stale, success:false).
    for (const index of [1, 2]) {
      const ev = StackUnitEvidenceSchema.parse(
        written.find((r) => r.name === `stack-unit-demo-200-${index}`)!.data,
      );
      assertEquals(ev.stale, true);
      assertEquals(ev.success, false);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("restackAbove: a bounded cascade — patching the TOP unit restacks only itself (no units above)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 3);
    await patchUnit(fixture.repo, fixture.units[2].branch, "patched top\n");
    const test = runtimeContext();
    await model.methods.restackAbove.execute(
      {
        stack: "demo-200",
        patchedIndex: 2,
        plan: stackPlan(3),
        repoPath: fixture.repo,
      },
      test.context,
    );
    const audit = StackRestackSchema.parse(
      test.getWrittenResources().find(
        (r) => r.name === "stack-restack-demo-200",
      )!.data,
    );
    // Only the patched unit itself — the cascade is bounded, never a loop.
    assertEquals(audit.units.map((u) => u.index), [2]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("restackAbove: a restack that produces a conflict (non-clean rebase) is rejected and aborts", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 2);
    // Make unit 1 touch the SAME file unit 0 owns so a rebase onto a patched
    // unit 0 conflicts.
    await git(fixture.repo, "checkout", fixture.units[1].branch);
    await Deno.writeTextFile(`${fixture.repo}/conflict.ts`, "unit 1 line\n");
    await git(fixture.repo, "add", "conflict.ts");
    await git(fixture.repo, "commit", "--amend", "--no-edit");
    // Patch unit 0 to write a DIFFERENT conflict.ts so the rebase collides.
    await git(fixture.repo, "checkout", fixture.units[0].branch);
    await Deno.writeTextFile(`${fixture.repo}/conflict.ts`, "unit 0 line\n");
    await git(fixture.repo, "add", "conflict.ts");
    await git(fixture.repo, "commit", "--amend", "--no-edit");
    const test = runtimeContext();
    await assertRejects(
      () =>
        model.methods.restackAbove.execute(
          {
            stack: "demo-200",
            patchedIndex: 0,
            plan: stackPlan(2),
            repoPath: fixture.repo,
          },
          test.context,
        ),
      Error,
      "restack of unit 1",
    );
    // The worktree is left clean (rebase aborted) — no in-progress rebase.
    const status = await git(fixture.repo, "status", "--porcelain");
    assertEquals(status, "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validateComposedHead: a clean linear stack validates and pins composed head + ordered tips", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 3);
    const tips = fixture.units.map((u) => u.headSha);
    const test = runtimeContext();
    await model.methods.validateComposedHead.execute(
      {
        stack: "demo-200",
        plan: stackPlan(3),
        repoPath: fixture.repo,
        unitTipShas: tips,
      },
      test.context,
    );
    const written = test.getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name, "composed-head-validation-demo-200");
    const validation = ComposedHeadValidationSchema.parse(written[0].data);
    assertEquals(validation.success, true);
    assertEquals(validation.linear, true);
    // Composed head = the topmost unit's tip.
    assertEquals(validation.composedHeadSha, tips[2]);
    assertEquals(validation.unitTipShas, tips);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validateComposedHead: a degenerate one-unit stack's composed head equals that unit's head", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 1);
    const test = runtimeContext();
    await model.methods.validateComposedHead.execute(
      {
        stack: "demo-200",
        plan: stackPlan(1),
        repoPath: fixture.repo,
        unitTipShas: [fixture.units[0].headSha],
      },
      test.context,
    );
    const validation = ComposedHeadValidationSchema.parse(
      test.getWrittenResources()[0].data,
    );
    assertEquals(validation.success, true);
    assertEquals(validation.composedHeadSha, fixture.units[0].headSha);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validateComposedHead: a stack whose unit 2 parent differs from the declared baseUnit is rejected (parentage audit)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 3);
    // Re-point unit 2 onto unit 0 (skipping unit 1) so its actual parent no
    // longer matches the declared plan (baseUnit 1).
    await git(fixture.repo, "checkout", fixture.units[2].branch);
    await git(
      fixture.repo,
      "rebase",
      "--onto",
      fixture.units[0].branch,
      fixture.units[1].branch,
      fixture.units[2].branch,
    );
    const newTip = await git(fixture.repo, "rev-parse", "HEAD");
    const test = runtimeContext();
    await assertRejects(
      () =>
        model.methods.validateComposedHead.execute(
          {
            stack: "demo-200",
            plan: stackPlan(3),
            repoPath: fixture.repo,
            unitTipShas: [
              fixture.units[0].headSha,
              fixture.units[1].headSha,
              newTip,
            ],
          },
          test.context,
        ),
      Error,
      "parentage must match the declared plan",
    );
    assertEquals(
      ComposedHeadValidationSchema.parse(
        test.getWrittenResources()[0].data,
      ).linear,
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("validateComposedHead: a unitTipShas list that does not match the restacked reality is rejected (mixed-SHA guard)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const fixture = await stackFixture(root, 2);
    const test = runtimeContext();
    // Pin unit 1's tip to a STALE SHA (the base SHA) rather than its live head.
    await assertRejects(
      () =>
        model.methods.validateComposedHead.execute(
          {
            stack: "demo-200",
            plan: stackPlan(2),
            repoPath: fixture.repo,
            unitTipShas: [fixture.units[0].headSha, fixture.baseSha],
          },
          test.context,
        ),
      Error,
      "stale/mixed SHA",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// Install stack-shaped gt/gh shims on PATH. The gt shim logs argv to gt.log,
// tracks the last `track <branch>` as the "current" branch, and on `submit`
// creates a per-branch PR marker (`prs/<branch>`) AND appends `<branch>` to
// submits.log — modelling "submit the tracked branch". The gh shim synthesizes
// per-branch PR JSON from the ACTUAL worktree: `gh pr list --head <branch>`
// returns `[{...}]` (head SHA read live via git, base + number read from
// `prs/<branch>`) when a marker exists, else `[]`. Pre-seeding a marker before
// submitStack runs models an already-submitted unit for the reuse path.
async function installStackShims(root: string, repo: string): Promise<string> {
  const bin = `${root}/bin`;
  await Deno.mkdir(bin);
  await Deno.mkdir(`${root}/prs`);
  const gtLog = `${root}/gt.log`;
  const submitsLog = `${root}/submits.log`;
  const currentFile = `${root}/current-branch`;
  await Deno.writeTextFile(
    `${bin}/gt`,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${gtLog}'
if [ "$1" = "track" ]; then
  printf '%s' "$2" > '${currentFile}'
fi
if [ "$1" = "submit" ]; then
  br=$(cat '${currentFile}' 2>/dev/null)
  if [ -n "$br" ]; then
    printf '%s\\n' "$br" >> '${submitsLog}'
    base=$(cat '${currentFile}.base' 2>/dev/null)
    num=$(cat '${currentFile}.num' 2>/dev/null)
    printf '%s\\n%s\\n' "$base" "$num" > '${root}/prs/'"$br"
  fi
fi
exit 0
`,
  );
  await Deno.writeTextFile(
    `${bin}/gh`,
    `#!/bin/sh
# parse --head <branch>
branch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--head" ]; then branch="$a"; fi
  prev="$a"
done
marker='${root}/prs/'"$branch"
if [ -n "$branch" ] && [ -f "$marker" ]; then
  base=$(sed -n '1p' "$marker")
  num=$(sed -n '2p' "$marker")
  oid=$(git -C '${repo}' rev-parse "$branch" 2>/dev/null)
  printf '[{"url":"https://github.test/pr/%s","number":%s,"isDraft":true,"headRefName":"%s","headRefOid":"%s","baseRefName":"%s"}]' "$num" "$num" "$branch" "$oid" "$base"
else
  printf '[]'
fi
`,
  );
  await Deno.chmod(`${bin}/gt`, 0o755);
  await Deno.chmod(`${bin}/gh`, 0o755);
  return bin;
}

// When gt track runs, the shim needs to know the base+number for the branch it
// will submit. Since the gt shim can't know the plan, the TEST pre-writes a
// branch->{base,num} table the gt shim consults on track.
async function seedGtSubmitTable(
  root: string,
  entries: { branch: string; base: string; num: number }[],
): Promise<void> {
  const bin = `${root}/bin`;
  const table = entries.map((e) => `${e.branch} ${e.base} ${e.num}`).join("\n");
  await Deno.writeTextFile(`${root}/gt-table`, table + "\n");
  await Deno.writeTextFile(
    `${bin}/gt`,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/gt.log'
if [ "$1" = "track" ]; then
  printf '%s' "$2" > '${root}/current-branch'
fi
if [ "$1" = "submit" ]; then
  br=$(cat '${root}/current-branch' 2>/dev/null)
  if [ -n "$br" ]; then
    printf '%s\\n' "$br" >> '${root}/submits.log'
    line=$(grep "^$br " '${root}/gt-table')
    if [ -n "$line" ]; then
      base=$(printf '%s' "$line" | awk '{print $2}')
      num=$(printf '%s' "$line" | awk '{print $3}')
      printf '%s\\n%s\\n' "$base" "$num" > '${root}/prs/'"$br"
    fi
  fi
fi
exit 0
`,
  );
  await Deno.chmod(`${bin}/gt`, 0o755);
}

// Pre-seed an already-open draft PR for a branch (the reuse path).
async function seedExistingPr(
  root: string,
  branch: string,
  base: string,
  num: number,
): Promise<void> {
  await Deno.writeTextFile(`${root}/prs/${branch}`, `${base}\n${num}\n`);
}

async function readLines(path: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(path)).trim().split("\n").filter((l) => l);
  } catch {
    return [];
  }
}

function shimContext() {
  const test = createModelTestContext({
    globalArgs: { defaultBaseBranch: "main" },
  });
  return {
    ...test,
    context: Object.assign(test.context, {
      globalArgs: { defaultBaseBranch: "main" },
    }),
  };
}

Deno.test("submitStack: a fresh 3-unit stack submits 3 draft PRs bottom-up, exactly one submit per branch in order", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await stackFixture(root, 3);
    await installStackShims(root, fixture.repo);
    await seedGtSubmitTable(root, [
      { branch: fixture.units[0].branch, base: "main", num: 1 },
      {
        branch: fixture.units[1].branch,
        base: fixture.units[0].branch,
        num: 2,
      },
      {
        branch: fixture.units[2].branch,
        base: fixture.units[1].branch,
        num: 3,
      },
    ]);
    Deno.env.set("PATH", `${root}/bin:${previousPath ?? ""}`);
    const test = shimContext();
    await model.methods.submitStack.execute(
      {
        stack: "demo-200",
        repoPath: fixture.repo,
        baseBranch: "main",
        plan: stackPlan(3),
        unitTipShas: fixture.units.map((u) => u.headSha),
      },
      test.context,
    );
    // Exactly one submit per branch, bottom-up in order.
    assertEquals(await readLines(`${root}/submits.log`), [
      fixture.units[0].branch,
      fixture.units[1].branch,
      fixture.units[2].branch,
    ]);
    // Every tracked --parent read from the DECLARED plan.
    const gtLog = await readLines(`${root}/gt.log`);
    assert(
      gtLog.includes(
        `track ${fixture.units[0].branch} --parent main --no-interactive`,
      ),
    );
    assert(
      gtLog.includes(
        `track ${fixture.units[2].branch} --parent ${
          fixture.units[1].branch
        } --no-interactive`,
      ),
    );
    const written = test.getWrittenResources();
    const composed = StackDraftPrsSchema.parse(
      written.find((r) => r.name === "stack-draft-prs-demo-200")!.data,
    );
    assertEquals(composed.success, true);
    assertEquals(composed.declaredUnitCount, 3);
    assertEquals(composed.submittedPrCount, 3);
    assert(composed.units.every((u) => !u.reused));
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("submitStack: a partially-submitted stack reuses units 0-1 and submits only unit 2 (no duplicate)", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await stackFixture(root, 3);
    await installStackShims(root, fixture.repo);
    await seedGtSubmitTable(root, [
      {
        branch: fixture.units[2].branch,
        base: fixture.units[1].branch,
        num: 3,
      },
    ]);
    // Units 0-1 already have conforming open draft PRs.
    await seedExistingPr(root, fixture.units[0].branch, "main", 1);
    await seedExistingPr(
      root,
      fixture.units[1].branch,
      fixture.units[0].branch,
      2,
    );
    Deno.env.set("PATH", `${root}/bin:${previousPath ?? ""}`);
    const test = shimContext();
    await model.methods.submitStack.execute(
      {
        stack: "demo-200",
        repoPath: fixture.repo,
        baseBranch: "main",
        plan: stackPlan(3),
        unitTipShas: fixture.units.map((u) => u.headSha),
      },
      test.context,
    );
    // Only unit 2 was newly submitted — no duplicate for the reused units.
    assertEquals(await readLines(`${root}/submits.log`), [
      fixture.units[2].branch,
    ]);
    const written = test.getWrittenResources();
    const composed = StackDraftPrsSchema.parse(
      written.find((r) => r.name === "stack-draft-prs-demo-200")!.data,
    );
    assertEquals(composed.submittedPrCount, 3);
    assertEquals(
      composed.units.filter((u) => u.reused).map((u) => u.index),
      [0, 1],
    );
    assertEquals(
      composed.units.filter((u) => !u.reused).map((u) => u.index),
      [2],
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("submitStack: a unit whose live head differs from its validated tip is rejected", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await stackFixture(root, 2);
    await installStackShims(root, fixture.repo);
    await seedGtSubmitTable(root, [
      { branch: fixture.units[0].branch, base: "main", num: 1 },
    ]);
    Deno.env.set("PATH", `${root}/bin:${previousPath ?? ""}`);
    const test = shimContext();
    await assertRejects(
      () =>
        model.methods.submitStack.execute(
          {
            stack: "demo-200",
            repoPath: fixture.repo,
            baseBranch: "main",
            plan: stackPlan(2),
            // Unit 0's tip is WRONG (pinned to the repo base).
            unitTipShas: [fixture.baseSha, fixture.units[1].headSha],
          },
          test.context,
        ),
      Error,
      "does not match its validated tip",
    );
    // Nothing was submitted.
    assertEquals(await readLines(`${root}/submits.log`), []);
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("submitStack: a unit whose PR base differs from the declared parent is rejected (wrong-base)", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await stackFixture(root, 2);
    await installStackShims(root, fixture.repo);
    // Unit 0 fresh; unit 1 pre-seeded with a WRONG base (main, not unit 0).
    await seedGtSubmitTable(root, [
      { branch: fixture.units[0].branch, base: "main", num: 1 },
    ]);
    await seedExistingPr(root, fixture.units[1].branch, "main", 9);
    Deno.env.set("PATH", `${root}/bin:${previousPath ?? ""}`);
    const test = shimContext();
    await assertRejects(
      () =>
        model.methods.submitStack.execute(
          {
            stack: "demo-200",
            repoPath: fixture.repo,
            baseBranch: "main",
            plan: stackPlan(2),
            unitTipShas: fixture.units.map((u) => u.headSha),
          },
          test.context,
        ),
      Error,
      "PR base is main",
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("submitStack: a unit whose PR is not a draft is rejected", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await stackFixture(root, 1);
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.mkdir(`${root}/prs`);
    await Deno.writeTextFile(
      `${bin}/gt`,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/gt.log'\nexit 0\n`,
    );
    // gh shim always reports a NON-draft PR for the branch.
    await Deno.writeTextFile(
      `${bin}/gh`,
      `#!/bin/sh
branch=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--head" ]; then branch="$a"; fi
  prev="$a"
done
oid=$(git -C '${fixture.repo}' rev-parse "$branch" 2>/dev/null)
printf '[{"url":"https://github.test/pr/1","number":1,"isDraft":false,"headRefName":"%s","headRefOid":"%s","baseRefName":"main"}]' "$branch" "$oid"
`,
    );
    await Deno.chmod(`${bin}/gt`, 0o755);
    await Deno.chmod(`${bin}/gh`, 0o755);
    Deno.env.set("PATH", `${bin}:${previousPath ?? ""}`);
    const test = shimContext();
    await assertRejects(
      () =>
        model.methods.submitStack.execute(
          {
            stack: "demo-200",
            repoPath: fixture.repo,
            baseBranch: "main",
            plan: stackPlan(1),
            unitTipShas: [fixture.units[0].headSha],
          },
          test.context,
        ),
      Error,
      "is not a draft",
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("submitStack: a collapsed submission (a unit yields no PR) fails via the collapse guard", async () => {
  const root = await Deno.makeTempDir();
  const previousPath = Deno.env.get("PATH");
  try {
    const fixture = await stackFixture(root, 2);
    await installStackShims(root, fixture.repo);
    // Only seed unit 0 in the gt table; unit 1's submit produces no marker, so
    // `gh pr list` returns [] for it and it yields no PR -> collapse.
    await seedGtSubmitTable(root, [
      { branch: fixture.units[0].branch, base: "main", num: 1 },
    ]);
    Deno.env.set("PATH", `${root}/bin:${previousPath ?? ""}`);
    const test = shimContext();
    await assertRejects(
      () =>
        model.methods.submitStack.execute(
          {
            stack: "demo-200",
            repoPath: fixture.repo,
            baseBranch: "main",
            plan: stackPlan(2),
            unitTipShas: fixture.units.map((u) => u.headSha),
          },
          test.context,
        ),
      Error,
      "collapse guard",
    );
  } finally {
    previousPath === undefined
      ? Deno.env.delete("PATH")
      : Deno.env.set("PATH", previousPath);
    await Deno.remove(root, { recursive: true });
  }
});
