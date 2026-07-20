// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @module graphite-stack
 *
 * A swamp model for the composition lifecycle of a Graphite (`gt`) multi-PR
 * stack. A stack is an ordered, strictly LINEAR chain of PR units — each unit
 * is exactly one commit ahead of its declared parent, plus a composed head the
 * whole stack validates against. The single-commit / single-PR contract is kept
 * PER UNIT (a stack of N units is N commits, each on its own branch and its own
 * PR); a length-1 stack degenerates to an ordinary single-PR flow.
 *
 * Every base relation is a declared FIELD (`baseUnit`), never inferred from
 * `gt log` or a branch-name convention. Live parentage is always read from git
 * and compared against the declared plan — it is never trusted from Graphite's
 * own view. That invariant is what lets the model reject a drifted, collapsed,
 * or non-linear stack instead of silently shipping it.
 *
 * The five methods form a lifecycle:
 *   1. `validateStackPlan`        — validate + persist the declared plan.
 *   2. `finalizeStackUnitCommit`  — assert one unit is exactly one commit ahead.
 *   3. `restackAbove`             — cascade a rebase after a lower unit is patched.
 *   4. `validateComposedHead`     — prove the whole stack is linear + composed.
 *   5. `submitStack`              — submit gated, idempotent, ordered draft PRs.
 *
 * The model wraps the pure `git`, `gt`, and `gh` CLIs; it carries no service
 * integration and no issue-tracker reconciliation.
 */

import { z } from "npm:zod@4";
import type {
  DataHandle,
  MethodContext,
  MethodResult,
} from "jsr:@systeminit/swamp-testing@0.20260604.20";

/**
 * Global arguments for the graphite-stack model. `defaultBaseBranch` is the
 * repository base branch used when a `submitStack` call does not specify one
 * (the branch the bottom unit of a stack is based on).
 */
export const GlobalArgsSchema: z.ZodObject<{
  defaultBaseBranch: z.ZodDefault<z.ZodString>;
}> = z.object({
  defaultBaseBranch: z.string().min(1).default("main"),
});

/**
 * A path-safe stack identifier. Names all persisted records for one stack
 * (e.g. `stack-plan-<stack>`), so it must be safe to embed in a resource name.
 */
export const StackIdSchema: z.ZodString = z.string().min(1).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  "stack identifier must be path-safe",
);

/** An absolute filesystem path (a working tree the git/gt/gh CLIs run in). */
export const AbsolutePathSchema: z.ZodString = z.string().min(1).regex(
  /^\//,
  "repoPath must be absolute",
);

/** A full 40-character Git SHA-1 commit hash. */
export const CommitShaSchema: z.ZodString = z.string().regex(
  /^[0-9a-f]{40}$/,
  "commit SHA must be a full 40-character Git SHA-1",
);

/**
 * The live/expected shape of a pull request as returned by
 * `gh pr list --json url,number,isDraft,headRefName,headRefOid,baseRefName`.
 */
export const GitHubPullRequestSchema: z.ZodObject<{
  url: z.ZodString;
  number: z.ZodNumber;
  isDraft: z.ZodBoolean;
  headRefName: z.ZodString;
  headRefOid: z.ZodString;
  baseRefName: z.ZodString;
}> = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
});

/**
 * One declared unit of a stack plan. `baseUnit` is the index of the parent
 * unit, or `null` ONLY for the bottom unit (whose base is the repo base
 * branch). It is a field — order is declared, never inferred.
 */
export const StackUnitPlanSchema: z.ZodObject<{
  index: z.ZodNumber;
  key: z.ZodString;
  title: z.ZodString;
  baseUnit: z.ZodNullable<z.ZodNumber>;
  branch: z.ZodString;
  acceptanceCriterionIds: z.ZodArray<z.ZodString>;
  scope: z.ZodString;
}> = z.object({
  index: z.number().int().nonnegative(),
  key: z.string().min(1),
  title: z.string().min(1),
  baseUnit: z.number().int().nonnegative().nullable(),
  branch: z.string().min(1),
  acceptanceCriterionIds: z.array(z.string().min(1)),
  scope: z.string().min(1),
}).strict();

/**
 * A declared stack plan: the repo base branch plus an ordered linear chain of
 * units. `validateStackShape` enforces the strict linear-chain invariant.
 */
export const StackPlanSchema: z.ZodObject<{
  baseBranch: z.ZodString;
  policyVersion: z.ZodLiteral<"1">;
  units: z.ZodArray<typeof StackUnitPlanSchema>;
}> = z.object({
  baseBranch: z.string().min(1),
  policyVersion: z.literal("1"),
  units: z.array(StackUnitPlanSchema).min(1),
}).strict();

/**
 * Per-unit commit evidence, pinned to the unit's base and head SHA. `stale`
 * marks a unit whose evidence a restack cascade invalidated (regenerate it
 * before the composed-head gate).
 */
export const StackUnitEvidenceSchema: z.ZodObject<{
  stack: z.ZodString;
  index: z.ZodNumber;
  branch: z.ZodString;
  baseBranch: z.ZodString;
  unitBaseSha: typeof CommitShaSchema;
  unitHeadSha: typeof CommitShaSchema;
  success: z.ZodBoolean;
  stale: z.ZodBoolean;
  summary: z.ZodString;
  policyVersion: z.ZodLiteral<"1">;
  recordedAt: z.ZodString;
}> = z.object({
  stack: z.string().min(1),
  index: z.number().int().nonnegative(),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  unitBaseSha: CommitShaSchema,
  unitHeadSha: CommitShaSchema,
  success: z.boolean(),
  stale: z.boolean(),
  summary: z.string().min(1),
  policyVersion: z.literal("1"),
  recordedAt: z.string().min(1),
}).strict();

/**
 * One submitted (or reused) draft PR in the stack. `reused:true` means a
 * conforming open draft PR already existed at the unit's expected head+base and
 * was NOT re-submitted (idempotency — no duplicate PR on resume).
 */
export const StackDraftPrSchema: z.ZodObject<{
  stack: z.ZodString;
  index: z.ZodNumber;
  branch: z.ZodString;
  baseBranch: z.ZodString;
  commitSha: typeof CommitShaSchema;
  prNumber: z.ZodNumber;
  prUrl: z.ZodString;
  reused: z.ZodBoolean;
  policyVersion: z.ZodLiteral<"1">;
  recordedAt: z.ZodString;
}> = z.object({
  stack: z.string().min(1),
  index: z.number().int().nonnegative(),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  commitSha: CommitShaSchema,
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
  reused: z.boolean(),
  policyVersion: z.literal("1"),
  recordedAt: z.string().min(1),
}).strict();

/**
 * The composed ordered list of all stack draft PRs plus the collapse-guard
 * assertion (`declaredUnitCount === submittedPrCount`).
 */
export const StackDraftPrsSchema: z.ZodObject<{
  stack: z.ZodString;
  baseBranch: z.ZodString;
  declaredUnitCount: z.ZodNumber;
  submittedPrCount: z.ZodNumber;
  units: z.ZodArray<typeof StackDraftPrSchema>;
  success: z.ZodBoolean;
  summary: z.ZodString;
  policyVersion: z.ZodLiteral<"1">;
  recordedAt: z.ZodString;
}> = z.object({
  stack: z.string().min(1),
  baseBranch: z.string().min(1),
  declaredUnitCount: z.number().int().positive(),
  submittedPrCount: z.number().int().positive(),
  units: z.array(StackDraftPrSchema).min(1),
  success: z.boolean(),
  summary: z.string().min(1),
  policyVersion: z.literal("1"),
  recordedAt: z.string().min(1),
}).strict();

/**
 * The composed-head validation: proof the whole stack works as a whole. Pins
 * the composed head SHA AND the ordered per-unit tip SHAs, and rejects any
 * mismatch between them and the restacked reality (no mixed/stale SHA).
 */
export const ComposedHeadValidationSchema: z.ZodObject<{
  stack: z.ZodString;
  baseBranch: z.ZodString;
  composedHeadSha: typeof CommitShaSchema;
  unitTipShas: z.ZodArray<typeof CommitShaSchema>;
  linear: z.ZodBoolean;
  success: z.ZodBoolean;
  summary: z.ZodString;
  policyVersion: z.ZodLiteral<"1">;
  recordedAt: z.ZodString;
}> = z.object({
  stack: z.string().min(1),
  baseBranch: z.string().min(1),
  composedHeadSha: CommitShaSchema,
  unitTipShas: z.array(CommitShaSchema).min(1),
  linear: z.boolean(),
  success: z.boolean(),
  summary: z.string().min(1),
  policyVersion: z.literal("1"),
  recordedAt: z.string().min(1),
}).strict();

/**
 * The restack audit trail: old->new SHA per restacked unit after a patch to a
 * lower unit forced a cascade. Records which units were marked stale.
 */
export const StackRestackSchema: z.ZodObject<{
  stack: z.ZodString;
  patchedIndex: z.ZodNumber;
  units: z.ZodArray<
    z.ZodObject<{
      index: z.ZodNumber;
      branch: z.ZodString;
      oldSha: typeof CommitShaSchema;
      newSha: typeof CommitShaSchema;
      stale: z.ZodBoolean;
    }>
  >;
  success: z.ZodBoolean;
  summary: z.ZodString;
  policyVersion: z.ZodLiteral<"1">;
  recordedAt: z.ZodString;
}> = z.object({
  stack: z.string().min(1),
  patchedIndex: z.number().int().nonnegative(),
  units: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      branch: z.string().min(1),
      oldSha: CommitShaSchema,
      newSha: CommitShaSchema,
      stale: z.boolean(),
    }).strict(),
  ).min(1),
  success: z.boolean(),
  summary: z.string().min(1),
  policyVersion: z.literal("1"),
  recordedAt: z.string().min(1),
}).strict();

/** The result of running one external command. */
export type CommandResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

/**
 * The runtime context each method executes with: the swamp `MethodContext`
 * plus a strongly typed `writeResource` that accepts a tag override.
 */
export type RuntimeContext =
  & Omit<
    MethodContext<z.infer<typeof GlobalArgsSchema>>,
    "writeResource"
  >
  & {
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
      overrides?: { tags?: Record<string, string> },
    ) => Promise<DataHandle>;
  };

/**
 * Run an external command in `cwd` and capture its exit status and streams.
 * Used to shell out to `git`, `gt`, and `gh`.
 */
export async function runCommand(
  command: string[],
  cwd: string,
): Promise<CommandResult> {
  const output = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/**
 * Enforce the strict linear-chain invariant of a stack plan. Throws (writing
 * nothing) on any duplicate index, gap in `0..n-1`, duplicate branch, a bottom
 * unit whose `baseUnit` is not `null`, or any unit `k>0` whose `baseUnit` is
 * not exactly `k-1`. A branching DAG is out of scope — order is always declared
 * explicitly, never inferred.
 */
export function validateStackShape(
  plan: z.infer<typeof StackPlanSchema>,
): void {
  const parsed = StackPlanSchema.parse(plan);
  const n = parsed.units.length;
  const seen = new Set<number>();
  for (const unit of parsed.units) {
    if (seen.has(unit.index)) {
      throw new Error(`duplicate unit index ${unit.index} in stack plan`);
    }
    seen.add(unit.index);
  }
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) {
      throw new Error(
        `stack plan has a gap: index ${i} is missing (indices must be 0..${
          n - 1
        })`,
      );
    }
  }
  const byIndex = new Map(parsed.units.map((u) => [u.index, u]));
  const branches = new Set<string>();
  for (const unit of parsed.units) {
    if (branches.has(unit.branch)) {
      throw new Error(`duplicate branch ${unit.branch} in stack plan`);
    }
    branches.add(unit.branch);
    if (unit.index === 0) {
      if (unit.baseUnit !== null) {
        throw new Error(
          `bottom unit (index 0) must declare baseUnit:null; got ${unit.baseUnit}`,
        );
      }
      continue;
    }
    if (unit.baseUnit !== unit.index - 1) {
      throw new Error(
        `unit ${unit.index} declares baseUnit ${unit.baseUnit}; a linear chain requires baseUnit === ${
          unit.index - 1
        } (base relations are explicit, never inferred)`,
      );
    }
    if (!byIndex.has(unit.baseUnit)) {
      throw new Error(
        `unit ${unit.index} references missing parent unit ${unit.baseUnit}`,
      );
    }
  }
}

/**
 * The graphite-stack swamp model: five methods that validate, finalize,
 * restack, compose, and submit a Graphite multi-PR stack, plus the per-unit and
 * whole-stack resource records each method persists.
 */
export const model = {
  type: "@mgreten/graphite-stack",
  version: "2026.07.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    stackPlan: {
      description:
        "A declared multi-PR stack plan: an ordered linear chain of units each with an explicit baseUnit (never inferred), a branch, a complete non-overlapping acceptance-criterion partition, and the repo base branch; keyed by stack id; a one-unit plan degenerates to the single-PR flow",
      schema: StackPlanSchema,
      lifetime: "90d" as const,
      garbageCollection: 40,
    },
    stackUnitEvidence: {
      description:
        "Per-unit commit evidence for one stack unit: pinned to the unit's base and head SHA, asserting exactly one commit ahead of its declared parent; keyed by stack id and unit index; stale:true marks evidence a restack cascade invalidated",
      schema: StackUnitEvidenceSchema,
      lifetime: "90d" as const,
      garbageCollection: 40,
    },
    stackRestack: {
      description:
        "The restack audit trail after a patch to a lower unit forced a cascade: old->new SHA per restacked unit and which units were marked stale for regeneration; keyed by stack id",
      schema: StackRestackSchema,
      lifetime: "90d" as const,
      garbageCollection: 40,
    },
    composedHeadValidation: {
      description:
        "The composed-head validation proving the whole stack works as a whole: the composed head SHA and the ordered per-unit tip SHAs, with live parentage asserted against the DECLARED plan; rejects any mixed/stale SHA; keyed by stack id",
      schema: ComposedHeadValidationSchema,
      lifetime: "90d" as const,
      garbageCollection: 40,
    },
    stackDraftPr: {
      description:
        "One submitted-or-reused draft PR in a stack: pinned to the unit's commitSha/branch/baseBranch/prNumber/prUrl; reused:true means a conforming open draft PR already existed and was not re-submitted; keyed by stack id and unit index",
      schema: StackDraftPrSchema,
      lifetime: "90d" as const,
      garbageCollection: 40,
    },
    stackDraftPrs: {
      description:
        "The composed ordered list of all stack draft PRs plus the collapse-guard assertion (declaredUnitCount === submittedPrCount); keyed by stack id",
      schema: StackDraftPrsSchema,
      lifetime: "90d" as const,
      garbageCollection: 40,
    },
  },
  methods: {
    validateStackPlan: {
      description:
        "Validate a declared multi-PR stack plan and persist it as the stack-plan-<stack> resource: enforces a strict linear chain via validateStackShape (base relations are explicit fields, never inferred) AND a complete, non-overlapping acceptance-criterion partition (every criterion maps to exactly one unit). Throws-and-writes-nothing on any inferred/ambiguous/cyclic/gapped/duplicate ordering or a criterion assigned to two units or to none; a degenerate one-unit plan is legal and matches the single-PR shape",
      arguments: z.object({
        stack: StackIdSchema,
        plan: StackPlanSchema,
      }),
      execute: async (
        args: {
          stack: string;
          plan: z.infer<typeof StackPlanSchema>;
        },
        context: RuntimeContext,
      ): Promise<MethodResult> => {
        context.logger.info("Validating stack plan for {stack}", {
          stack: args.stack,
        });
        validateStackShape(args.plan);

        const criterionToUnit = new Map<string, number>();
        for (const unit of args.plan.units) {
          for (const criterionId of unit.acceptanceCriterionIds) {
            if (criterionToUnit.has(criterionId)) {
              throw new Error(
                `acceptance criterion ${criterionId} is assigned to units ${
                  criterionToUnit.get(criterionId)
                } and ${unit.index}; each criterion must map to exactly one unit`,
              );
            }
            criterionToUnit.set(criterionId, unit.index);
          }
        }
        if (criterionToUnit.size === 0) {
          throw new Error(
            "stack plan assigns no acceptance criteria; the partition must be complete",
          );
        }

        const handle = await context.writeResource(
          "stackPlan",
          `stack-plan-${args.stack}`,
          args.plan,
          {
            tags: {
              stack: args.stack,
              unitCount: String(args.plan.units.length),
              baseBranch: args.plan.baseBranch,
            },
          },
        );
        context.logger.info("Validated stack plan for {stack}", {
          stack: args.stack,
          unitCount: args.plan.units.length,
        });
        return { dataHandles: [handle] };
      },
    },

    finalizeStackUnitCommit: {
      description:
        "Finalize one stack unit's commit: reuses the single-commit invariant PER UNIT — asserts the worktree is clean, HEAD^ === unitBaseSha (the unit's declared parent head, or the repo base for unit 0), and exactly one commit ahead (git rev-list --count unitBaseSha..HEAD === 1) — then persists a per-unit stack-unit-<stack>-<index> evidence record pinned to the unit's base and head SHA. Fail-closed on a multi-commit unit (must be re-scoped into two units) or a unit whose parent SHA differs from its declared baseUnit head",
      arguments: z.object({
        stack: StackIdSchema,
        index: z.number().int().nonnegative(),
        repoPath: AbsolutePathSchema,
        unitBaseSha: CommitShaSchema,
        expectedBranch: z.string().min(1),
        baseBranch: z.string().min(1),
      }),
      execute: async (
        args: {
          stack: string;
          index: number;
          repoPath: string;
          unitBaseSha: string;
          expectedBranch: string;
          baseBranch: string;
        },
        context: RuntimeContext,
      ): Promise<MethodResult> => {
        context.logger.info(
          "Finalizing stack unit {index} for {stack}",
          { index: args.index, stack: args.stack },
        );
        const branch = await runCommand(
          ["git", "rev-parse", "--abbrev-ref", "HEAD"],
          args.repoPath,
        );
        const status = await runCommand(
          ["git", "status", "--porcelain", "--untracked-files=all"],
          args.repoPath,
        );
        const head = await runCommand(
          ["git", "rev-parse", "HEAD"],
          args.repoPath,
        );
        const parent = await runCommand(
          ["git", "rev-parse", "HEAD^"],
          args.repoPath,
        );
        const ahead = await runCommand(
          ["git", "rev-list", "--count", `${args.unitBaseSha}..HEAD`],
          args.repoPath,
        );

        const errors: string[] = [];
        if (!branch.success || branch.stdout !== args.expectedBranch) {
          errors.push(
            `unit ${args.index} is not on the declared branch ${args.expectedBranch} (on ${branch.stdout})`,
          );
        }
        if (!status.success || status.stdout !== "") {
          errors.push(
            `unit ${args.index} worktree is not clean after commit`,
          );
        }
        if (!parent.success || parent.stdout !== args.unitBaseSha) {
          errors.push(
            `unit ${args.index} parent ${parent.stdout} does not match its declared base ${args.unitBaseSha}`,
          );
        }
        if (
          !ahead.success || Number.parseInt(ahead.stdout, 10) !== 1
        ) {
          errors.push(
            `unit ${args.index} is not exactly one commit ahead of its base ${args.unitBaseSha} (got ${ahead.stdout}); a multi-commit unit must be re-scoped`,
          );
        }

        const unitHeadSha = head.success ? head.stdout : args.unitBaseSha;
        const evidence = {
          stack: args.stack,
          index: args.index,
          branch: args.expectedBranch,
          baseBranch: args.baseBranch,
          unitBaseSha: args.unitBaseSha,
          unitHeadSha,
          success: errors.length === 0,
          stale: false,
          summary: errors.length === 0
            ? `unit ${args.index} is exactly one commit ahead of ${args.unitBaseSha} at ${unitHeadSha}`
            : errors.join("; "),
          policyVersion: "1" as const,
          recordedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "stackUnitEvidence",
          `stack-unit-${args.stack}-${args.index}`,
          evidence,
          {
            tags: {
              stack: args.stack,
              index: String(args.index),
              success: String(evidence.success),
              stale: String(evidence.stale),
            },
          },
        );
        if (errors.length > 0) throw new Error(evidence.summary);

        context.logger.info(
          "Finalized stack unit {index} for {stack}",
          {
            index: args.index,
            stack: args.stack,
            unitHeadSha,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    restackAbove: {
      description:
        "Restack every unit above a patched unit: after a patch to unit k rewrites its head SHA, rebases each unit k+1..n onto its (new) parent head via `git rebase --onto` (gt-version-independent), asserts each restacked unit is STILL exactly one commit ahead of its new parent and the chain stays linear, recomputes each unit's head SHA, and records a stack-restack-<stack> audit trail of old->new SHA per unit, marking unit k and every restacked unit stale so their evidence is regenerated. The cascade is bounded by the declared unit count (no infinite restack); a restack that produces a non-linear or multi-commit unit is rejected",
      arguments: z.object({
        stack: StackIdSchema,
        patchedIndex: z.number().int().nonnegative(),
        plan: StackPlanSchema,
        repoPath: AbsolutePathSchema,
      }),
      execute: async (
        args: {
          stack: string;
          patchedIndex: number;
          plan: z.infer<typeof StackPlanSchema>;
          repoPath: string;
        },
        context: RuntimeContext,
      ): Promise<MethodResult> => {
        validateStackShape(args.plan);
        const ordered = [...args.plan.units].sort((a, b) => a.index - b.index);
        if (
          args.patchedIndex < 0 || args.patchedIndex >= ordered.length
        ) {
          throw new Error(
            `patchedIndex ${args.patchedIndex} is out of range for a ${ordered.length}-unit stack`,
          );
        }
        context.logger.info(
          "Restacking above unit {patchedIndex} for {stack}",
          { patchedIndex: args.patchedIndex, stack: args.stack },
        );

        const oldHeads = new Map<number, string>();
        for (const unit of ordered) {
          const rev = await runCommand(
            ["git", "rev-parse", unit.branch],
            args.repoPath,
          );
          if (!rev.success) {
            throw new Error(
              `cannot read head of unit ${unit.index} branch ${unit.branch}: ${
                rev.stderr || rev.stdout
              }`,
            );
          }
          oldHeads.set(unit.index, rev.stdout);
        }

        const auditUnits: {
          index: number;
          branch: string;
          oldSha: string;
          newSha: string;
          stale: boolean;
        }[] = [];
        const patchedUnit = ordered[args.patchedIndex];
        const patchedHead = oldHeads.get(patchedUnit.index)!;
        auditUnits.push({
          index: patchedUnit.index,
          branch: patchedUnit.branch,
          oldSha: patchedHead,
          newSha: patchedHead,
          stale: true,
        });

        for (let i = args.patchedIndex + 1; i < ordered.length; i++) {
          const unit = ordered[i];
          const parent = ordered[i - 1];
          const oldParentHead = oldHeads.get(parent.index)!;
          const newParentHead = await runCommand(
            ["git", "rev-parse", parent.branch],
            args.repoPath,
          );
          if (!newParentHead.success) {
            throw new Error(
              `cannot read restacked head of parent unit ${parent.index}`,
            );
          }
          const rebase = await runCommand(
            [
              "git",
              "rebase",
              "--onto",
              newParentHead.stdout,
              oldParentHead,
              unit.branch,
            ],
            args.repoPath,
          );
          if (!rebase.success) {
            await runCommand(["git", "rebase", "--abort"], args.repoPath);
            throw new Error(
              `restack of unit ${unit.index} (${unit.branch}) failed: ${
                rebase.stderr || rebase.stdout
              }`,
            );
          }
          const newHead = await runCommand(
            ["git", "rev-parse", "HEAD"],
            args.repoPath,
          );
          const parentSha = await runCommand(
            ["git", "rev-parse", "HEAD^"],
            args.repoPath,
          );
          const ahead = await runCommand(
            ["git", "rev-list", "--count", `${newParentHead.stdout}..HEAD`],
            args.repoPath,
          );
          if (
            !parentSha.success || parentSha.stdout !== newParentHead.stdout
          ) {
            throw new Error(
              `restacked unit ${unit.index} parent ${parentSha.stdout} is not the new parent head ${newParentHead.stdout} (non-linear restack)`,
            );
          }
          if (!ahead.success || Number.parseInt(ahead.stdout, 10) !== 1) {
            throw new Error(
              `restacked unit ${unit.index} is not exactly one commit ahead of its new parent (got ${ahead.stdout}); a multi-commit unit must be re-scoped`,
            );
          }
          auditUnits.push({
            index: unit.index,
            branch: unit.branch,
            oldSha: oldHeads.get(unit.index)!,
            newSha: newHead.stdout,
            stale: true,
          });
        }

        const restack = {
          stack: args.stack,
          patchedIndex: args.patchedIndex,
          units: auditUnits,
          success: true,
          summary:
            `restacked ${auditUnits.length} unit(s) above (and including) patched unit ${args.patchedIndex}; all marked stale for evidence regeneration`,
          policyVersion: "1" as const,
          recordedAt: new Date().toISOString(),
        };
        const restackHandle = await context.writeResource(
          "stackRestack",
          `stack-restack-${args.stack}`,
          restack,
          {
            tags: {
              stack: args.stack,
              patchedIndex: String(args.patchedIndex),
              restackedCount: String(auditUnits.length),
            },
          },
        );

        const handles: DataHandle[] = [restackHandle];
        for (const unit of auditUnits) {
          const planUnit = ordered[unit.index];
          const baseBranch = unit.index === 0
            ? args.plan.baseBranch
            : ordered[unit.index - 1].branch;
          const baseRev = await runCommand(
            [
              "git",
              "rev-parse",
              unit.index === 0 ? args.plan.baseBranch : baseBranch,
            ],
            args.repoPath,
          );
          const staleEvidence = {
            stack: args.stack,
            index: unit.index,
            branch: planUnit.branch,
            baseBranch,
            unitBaseSha: baseRev.success ? baseRev.stdout : unit.oldSha,
            unitHeadSha: unit.newSha,
            success: false,
            stale: true,
            summary:
              `unit ${unit.index} evidence invalidated by a restack cascade from patched unit ${args.patchedIndex}; regenerate before the composed-head gate`,
            policyVersion: "1" as const,
            recordedAt: new Date().toISOString(),
          };
          const handle = await context.writeResource(
            "stackUnitEvidence",
            `stack-unit-${args.stack}-${unit.index}`,
            staleEvidence,
            {
              tags: {
                stack: args.stack,
                index: String(unit.index),
                success: "false",
                stale: "true",
              },
            },
          );
          handles.push(handle);
        }

        context.logger.info(
          "Restacked {count} unit(s) for {stack}",
          { count: auditUnits.length, stack: args.stack },
        );
        return { dataHandles: handles };
      },
    },

    validateComposedHead: {
      description:
        "Validate that the whole stack works as a whole: asserts the live stack is linear and each unit's actual parent matches the DECLARED plan baseUnit (parentage read from git, compared to the plan — never `gt log`), computes the composed head = the topmost unit's tip, asserts the supplied unitTipShas equals the restacked reality in order (rejecting any mixed/stale SHA), and persists a composed-head-validation-<stack> artifact pinning composedHeadSha AND the ordered unitTipShas. A degenerate one-unit stack's composed head equals that unit's head",
      arguments: z.object({
        stack: StackIdSchema,
        plan: StackPlanSchema,
        repoPath: AbsolutePathSchema,
        unitTipShas: z.array(CommitShaSchema).min(1),
      }),
      execute: async (
        args: {
          stack: string;
          plan: z.infer<typeof StackPlanSchema>;
          repoPath: string;
          unitTipShas: string[];
        },
        context: RuntimeContext,
      ): Promise<MethodResult> => {
        validateStackShape(args.plan);
        const ordered = [...args.plan.units].sort((a, b) => a.index - b.index);
        context.logger.info("Validating composed head for {stack}", {
          stack: args.stack,
        });

        const errors: string[] = [];
        if (args.unitTipShas.length !== ordered.length) {
          errors.push(
            `unitTipShas has ${args.unitTipShas.length} entries but the plan declares ${ordered.length} units`,
          );
        }

        const liveTips: string[] = [];
        let linear = true;
        for (const unit of ordered) {
          const head = await runCommand(
            ["git", "rev-parse", unit.branch],
            args.repoPath,
          );
          if (!head.success) {
            errors.push(
              `cannot read head of unit ${unit.index} branch ${unit.branch}`,
            );
            linear = false;
            liveTips.push("");
            continue;
          }
          liveTips.push(head.stdout);
          const parentBranch = unit.index === 0
            ? args.plan.baseBranch
            : ordered[unit.index - 1].branch;
          const parentRev = await runCommand(
            ["git", "rev-parse", parentBranch],
            args.repoPath,
          );
          const actualParent = await runCommand(
            ["git", "rev-parse", `${unit.branch}^`],
            args.repoPath,
          );
          if (
            !parentRev.success || !actualParent.success ||
            actualParent.stdout !== parentRev.stdout
          ) {
            linear = false;
            errors.push(
              `unit ${unit.index} actual parent ${actualParent.stdout} does not match its declared base ${parentBranch} (${parentRev.stdout}); parentage must match the declared plan`,
            );
          }
          const ahead = await runCommand(
            ["git", "rev-list", "--count", `${parentBranch}..${unit.branch}`],
            args.repoPath,
          );
          if (!ahead.success || Number.parseInt(ahead.stdout, 10) !== 1) {
            linear = false;
            errors.push(
              `unit ${unit.index} is not exactly one commit ahead of its declared parent (got ${ahead.stdout})`,
            );
          }
        }

        for (let i = 0; i < ordered.length; i++) {
          if (args.unitTipShas[i] !== liveTips[i]) {
            errors.push(
              `unit ${ordered[i].index} tip ${
                args.unitTipShas[i]
              } does not match the live head ${
                liveTips[i]
              } (stale/mixed SHA; regenerate after the restack)`,
            );
          }
        }

        const composedHeadSha = liveTips.length > 0
          ? liveTips[liveTips.length - 1]
          : "";
        const success = errors.length === 0 && linear &&
          composedHeadSha !== "";
        const validation = {
          stack: args.stack,
          baseBranch: args.plan.baseBranch,
          composedHeadSha: success ? composedHeadSha : args.unitTipShas[
            args.unitTipShas.length - 1
          ],
          unitTipShas: args.unitTipShas,
          linear,
          success,
          summary: success
            ? `composed head ${composedHeadSha} validated over ${ordered.length} linear unit(s); tips match the restacked reality`
            : errors.join("; "),
          policyVersion: "1" as const,
          recordedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource(
          "composedHeadValidation",
          `composed-head-validation-${args.stack}`,
          validation,
          {
            tags: {
              stack: args.stack,
              success: String(success),
              linear: String(linear),
              unitCount: String(ordered.length),
            },
          },
        );
        if (!success) throw new Error(validation.summary);

        context.logger.info("Validated composed head for {stack}", {
          stack: args.stack,
          composedHeadSha,
        });
        return { dataHandles: [handle] };
      },
    },

    submitStack: {
      description:
        "Submit a validated stack as gated, idempotent, ordered draft PRs: bottom-up per unit, `gt track <branch> --parent <parentBranch> --no-interactive` with the parent read from the DECLARED plan (never inferred); then checks `gh pr list --head <branch>` ground truth — if a conforming OPEN DRAFT PR already exists at the unit's expected head+base it is recorded as reused (skip submit, no duplicate), else `gt submit --draft` and the resulting PR is verified per unit (headRefName/headRefOid/baseRefName/isDraft, with a retry-lookup to dodge GitHub eventual-consistency). Persists a per-unit stack-draft-pr-<stack>-<index> and a composed ordered stack-draft-prs-<stack>; asserts the submitted-or-reused PR count equals the declared-unit count (collapse guard) and fails otherwise. Re-running after an interruption submits only the missing units and never duplicates a PR",
      arguments: z.object({
        stack: StackIdSchema,
        repoPath: AbsolutePathSchema,
        baseBranch: z.string().min(1).default("main"),
        plan: StackPlanSchema,
        unitTipShas: z.array(CommitShaSchema).min(1),
      }),
      execute: async (
        args: {
          stack: string;
          repoPath: string;
          baseBranch: string;
          plan: z.infer<typeof StackPlanSchema>;
          unitTipShas: string[];
        },
        context: RuntimeContext,
      ): Promise<MethodResult> => {
        validateStackShape(args.plan);
        const ordered = [...args.plan.units].sort((a, b) => a.index - b.index);
        if (args.unitTipShas.length !== ordered.length) {
          throw new Error(
            `unitTipShas has ${args.unitTipShas.length} entries but the plan declares ${ordered.length} units`,
          );
        }
        const repoBase = args.baseBranch.replace(/^origin\//, "");
        context.logger.info("Submitting stack for {stack}", {
          stack: args.stack,
          unitCount: ordered.length,
        });

        const lookupPr = async (
          branch: string,
        ): Promise<z.infer<typeof GitHubPullRequestSchema> | null> => {
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
            const list = await runCommand(
              [
                "gh",
                "pr",
                "list",
                "--head",
                branch,
                "--state",
                "open",
                "--json",
                "url,number,isDraft,headRefName,headRefOid,baseRefName",
              ],
              args.repoPath,
            );
            if (!list.success) continue;
            try {
              const arr = JSON.parse(list.stdout);
              if (Array.isArray(arr) && arr.length > 0) {
                const parsed = GitHubPullRequestSchema.safeParse(arr[0]);
                if (parsed.success) return parsed.data;
              } else if (Array.isArray(arr)) {
                return null;
              }
            } catch {
              // fall through to retry
            }
          }
          return null;
        };

        const handles: DataHandle[] = [];
        const submittedUnits: z.infer<typeof StackDraftPrSchema>[] = [];
        const errors: string[] = [];

        for (let i = 0; i < ordered.length; i++) {
          const unit = ordered[i];
          const expectedHeadSha = args.unitTipShas[i];
          const parentBranch = unit.index === 0
            ? repoBase
            : ordered[unit.index - 1].branch;

          const liveHead = await runCommand(
            ["git", "rev-parse", unit.branch],
            args.repoPath,
          );
          if (!liveHead.success || liveHead.stdout !== expectedHeadSha) {
            throw new Error(
              `unit ${unit.index} live head ${liveHead.stdout} does not match its validated tip ${expectedHeadSha}; refusing to submit an unvalidated commit`,
            );
          }

          const existing = await lookupPr(unit.branch);
          const conforming = existing !== null &&
            existing.headRefName === unit.branch &&
            existing.headRefOid === expectedHeadSha &&
            existing.baseRefName === parentBranch &&
            existing.isDraft === true;

          let prInfo: z.infer<typeof GitHubPullRequestSchema> | null = null;
          let reused = false;
          if (conforming) {
            prInfo = existing;
            reused = true;
          } else {
            const track = await runCommand(
              [
                "gt",
                "track",
                unit.branch,
                "--parent",
                parentBranch,
                "--no-interactive",
              ],
              args.repoPath,
            );
            const submit = track.success
              ? await runCommand(
                ["gt", "submit", "-q", "--no-edit", "--no-verify", "--draft"],
                args.repoPath,
              )
              : { success: false, code: 1, stdout: "", stderr: "" };
            if (!track.success) {
              errors.push(
                `unit ${unit.index} gt track failed: ${
                  track.stderr || track.stdout
                }`,
              );
            } else if (!submit.success) {
              errors.push(
                `unit ${unit.index} gt submit failed: ${
                  submit.stderr || submit.stdout
                }`,
              );
            } else {
              prInfo = await lookupPr(unit.branch);
            }
          }

          const unitErrors: string[] = [];
          if (!prInfo) {
            unitErrors.push(
              `unit ${unit.index}: GitHub did not return a pull request for ${unit.branch}`,
            );
          } else {
            if (prInfo.headRefName !== unit.branch) {
              unitErrors.push(
                `unit ${unit.index} PR head is ${prInfo.headRefName}, expected ${unit.branch}`,
              );
            }
            if (prInfo.headRefOid !== expectedHeadSha) {
              unitErrors.push(
                `unit ${unit.index} PR does not point at the validated commit`,
              );
            }
            if (prInfo.baseRefName !== parentBranch) {
              unitErrors.push(
                `unit ${unit.index} PR base is ${prInfo.baseRefName}, expected ${parentBranch}`,
              );
            }
            if (prInfo.isDraft !== true) {
              unitErrors.push(`unit ${unit.index} PR is not a draft`);
            }
          }
          errors.push(...unitErrors);

          if (prInfo && unitErrors.length === 0) {
            const draftPr = {
              stack: args.stack,
              index: unit.index,
              branch: unit.branch,
              baseBranch: parentBranch,
              commitSha: expectedHeadSha,
              prNumber: prInfo.number,
              prUrl: prInfo.url,
              reused,
              policyVersion: "1" as const,
              recordedAt: new Date().toISOString(),
            };
            submittedUnits.push(draftPr);
            const handle = await context.writeResource(
              "stackDraftPr",
              `stack-draft-pr-${args.stack}-${unit.index}`,
              draftPr,
              {
                tags: {
                  stack: args.stack,
                  index: String(unit.index),
                  reused: String(reused),
                },
              },
            );
            handles.push(handle);
          }
        }

        const collapsed = submittedUnits.length !== ordered.length;
        if (collapsed) {
          errors.push(
            `collapse guard: ${submittedUnits.length} PR(s) for ${ordered.length} declared unit(s); refusing a collapsed stack`,
          );
        }

        const composed = {
          stack: args.stack,
          baseBranch: repoBase,
          declaredUnitCount: ordered.length,
          submittedPrCount: Math.max(submittedUnits.length, 1),
          units: submittedUnits.length > 0 ? submittedUnits : [
            {
              stack: args.stack,
              index: ordered[0].index,
              branch: ordered[0].branch,
              baseBranch: repoBase,
              commitSha: args.unitTipShas[0],
              prNumber: 1,
              prUrl: "https://invalid.invalid/none",
              reused: false,
              policyVersion: "1" as const,
              recordedAt: new Date().toISOString(),
            },
          ],
          success: errors.length === 0,
          summary: errors.length === 0
            ? `submitted ${submittedUnits.length} draft PR(s) bottom-up (${
              submittedUnits.filter((u) => u.reused).length
            } reused) for ${ordered.length} declared unit(s)`
            : errors.join("; "),
          policyVersion: "1" as const,
          recordedAt: new Date().toISOString(),
        };
        if (submittedUnits.length > 0) {
          const composedHandle = await context.writeResource(
            "stackDraftPrs",
            `stack-draft-prs-${args.stack}`,
            { ...composed, units: submittedUnits },
            {
              tags: {
                stack: args.stack,
                success: String(composed.success),
                declaredUnitCount: String(ordered.length),
                submittedPrCount: String(submittedUnits.length),
              },
            },
          );
          handles.push(composedHandle);
        }
        if (errors.length > 0) {
          throw new Error(
            errors.join("; "),
          );
        }

        context.logger.info("Submitted stack for {stack}", {
          stack: args.stack,
          prCount: submittedUnits.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
