# Implementation handoff — rerun completed goals

Target: pi-goal-x v0.32.3 (fork HEAD `64c5ace`, `TheNumberOne/pi-goal-x`). All file:line references below were verified against that tree. Node 24 + `--experimental-strip-types`; run scripts from the repo root.

## Why this exists

User request (2026-10-16, rose): "modify a goal after it has already been completed and then go through the entire process again." No pi goal extension in the ecosystem supports re-running a completed goal (pi-goal-x, pi-codex-goal, pi-better-goal and others all treat `complete` as terminal). The related async-waiting half of the request was resolved out-of-tree (operator config `strictExecutionContract: true` plus prompt guidance) and needs no code change here.

## Current terminal-completion behavior (verified)

- Status set: `"active" | "paused" | "blocked" | "budget_limited" | "complete"` — `extensions/goal-policy.ts:5`.
- `complete` is rejected by resume: `validateResumeGoal` — `extensions/goal-policy.ts:75` ("Goal is complete. Use /goal to draft a new one…"); the scheduler path throws again — `extensions/goal-scheduler.ts:124` ("A completed or token-budget-limited goal cannot resume").
- Completion transition: `update_goal(complete)` → `core.goalService.apply({mutate: status: "complete"})` in `extensions/goal-completion.ts:95-98`, then the auditor flow (or the `complete_without_audit` user choice at :301). Archival is deferred to turn end.
- File move on completion: the service writes the archived file instead of the active file when status is `complete` — `extensions/goal-service.ts:242-243, 769, 775` → `archiveGoalFile` (`extensions/storage/goal-files.ts:468`). Active goals live under `.pi/goals/`, archives under `.pi/goals/archived/` (`extensions/storage/goal-files.ts:20-21`). `GoalRecord` carries `activePath`/`archivedPath` (`extensions/goal-record.ts:45`, normalization at :376).
- Ledger is append-only with a closed event union — `extensions/goal-ledger.ts:23` (`goal_archived` with `archivePath` is the closest existing shape).
- Completed tasks are immutable in every normal flow — `extensions/goal-task-tools.ts:218, 564`.
- Commands register in one block: `extensions/goal-commands.ts:717-815` (`goal-list` :749, `goal-clear` :799, `goal-resume` :811) — the rerun command slots in here.
- Per-goal locking: `extensions/storage/goal-lock.ts`, used by `GoalService.apply` (`expectedGoalId` + lease, conflict message "deleted or archived by another process" — `extensions/goal-service.ts:470`).
- Goal pool / open-goal listing: `extensions/goal-pool.ts` (`openGoals()`); the unfocused reminder and `/goal-list` derive from it, so an archived goal disappears from both and must reappear after rerun.

## Design

One new transition, user-owned, implemented as a core flow analogous to the existing agent-pause flow (`runGoalAgentPauseFlow`, `extensions/goal-core-tools.ts:454`):

1. **Resolve the target.** Focused goal or explicit id/name argument; must exist, have `status === "complete"`, and (for the focused case) still be focused. Resolve from the archived file when the goal is not in the active pool — reuse the `readActiveGoalFiles`/archive-reading helpers in `extensions/storage/goal-files.ts` (add a bounded archived-file listing/lookup if missing).
2. **Confirm.** Reuse the `/goal-clear`-style confirmation dialog showing the PRODUCT.md summary block (objective, last audit verdict, retained plan shape, budget/usage, preserved archives). Non-UI hosts reject with a message, like other confirmation-gated commands.
3. **Mutate through `GoalService.apply`** with `expectedGoalId` and the per-goal lock, so a concurrent session cannot race the transition:
   - `status: "active"`, `autoContinue: true`, `stopReason: undefined`, `pauseReason: undefined`, `pauseSuggestedAction: undefined`, `completedAt: null` (see `extensions/goal-state.ts:141-144, 249` for where `completedAt` is derived/cleared).
   - Task reset: recursively set every task/subtask `status: "pending"`, clear `evidence`, `skipReason`, `completedAt`-style fields, and set `currentTaskId: undefined`. **Retain** per-task `verificationContract`, titles and structure. Sisyphus: reset step progress per `sisyphusStepProgress` (`extensions/goal-policy.ts`).
   - Retain: `objective`, `verificationContract`, `sisyphus` mode, auditor settings, `tokenBudget`, lifetime usage accounting.
   - Scheduler: replace `goal.scheduler` with `newGoalScheduler(ownerOfThisSession)` (`extensions/goal-scheduler-state.ts`) — fresh owner, `phase: "idle"`, `used: 0`, no wait. This is the same shape `GoalScheduler.resume` writes (`extensions/goal-scheduler.ts:117-126`) minus the resume-only invariants.
   - Archive history: record the goal's prior `archivedPath` before moving it back. Record-shape choice is open decision D5 below (default: new field `previousArchives: string[]` on `GoalRecord`, normalized in `extensions/goal-record.ts` near :376, rendered in `get_goal` history).
   - `activePath`: assign a new active path (`makeActiveGoalPath`, `extensions/storage/goal-files.ts:304`) and let the service write the active file (`writeActiveGoalFile`, :455). The archived file stays on disk untouched.
   - Ledger: append `{ type: "goal_rerun", goalId, archivePath, at }` — add the variant to the union in `extensions/goal-ledger.ts` and to the exhaustive switches that render events (`extensions/goal-activity.ts`, `extensions/goal-compaction.ts` — both already carry `task_reopened`-style cases to copy).
4. **Post-commit.** `core.updateUI(ctx)`, then kickoff: mirror `GoalScheduler.resume`'s post-write path (`this.declared = this.inRun; this.schedule(ctx)` — `extensions/goal-scheduler.ts:127-131`) so the goal starts its first run in the invoking session. If the budget is already exhausted (`budgetReached`), the existing scheduler pause handles it — verify the goal lands at `budget_limited` with the standard recovery message rather than a silent active state.
5. **Surface.** `get_goal`/`/goal-status` already render from the record; ensure the new `previousArchives` shows in the history/detail block (`extensions/goal-format.ts`) and the new ledger event renders in activity/compaction text.

## Files to touch (expected)

- `extensions/goal-commands.ts` — register `goal-rerun`, wire to the new core flow.
- `extensions/goal-core.ts` / `extensions/goal-state.ts` — expose the rerun flow on `GoalCore` (see how `archiveCurrentGoal` and the pause flow are exposed, `extensions/goal-state.ts:795-803, 1062`).
- New module or extension of `extensions/goal-completion.ts` — the rerun transition itself (it owns the completion inverse; keep audit/completion and rerun in one place so their invariants stay visible).
- `extensions/goal-policy.ts` — `validateRerunGoal` (complete-only guard, mirroring `validateResumeGoal`/`validateGoalBlock`).
- `extensions/goal-service.ts` — reuse `apply` (no changes expected; the archive-vs-active write is status-driven at :242-243, so an active-status mutation writes the active file automatically).
- `extensions/goal-record.ts` — `previousArchives` normalization + `completedAt` handling if the record shape changes (D5).
- `extensions/goal-ledger.ts`, `extensions/goal-activity.ts`, `extensions/goal-compaction.ts` — `goal_rerun` event variant + rendering.
- `extensions/goal-format.ts` — history/detail rendering for archive history.
- `extensions/storage/goal-files.ts` — bounded archived-goal listing/lookup if not already present.
- `tests/` — see below.
- `specs/SPECS.yaml` — status as implementation proceeds (draft → ready_for_review → …).
- README/CHANGELOG: per repo AGENTS.md, do **not** expand the README for this feature; release notes belong in `CHANGELOG.md` at release time.

## Open design decisions (defaults proposed; confirm before implementing)

- **D1 — Budget/usage on rerun.** Default: retain lifetime budget and usage (the documented budget semantics are "a total lifetime limit, not an additional allocation" — `docs/advanced-usage.md`). Consequence: a rerun of a budget-exhausted goal lands at `budget_limited`; recovery is the existing `/goal-tweak set the token budget to N` flow. Alternative: reset usage for a fresh run — rejected by default because it silently defeats lifetime accounting.
- **D2 — Objective edit in the same call.** Default: no; rerun then `/goal-tweak` (reuses the confirmation UX, no new argument grammar). The user's literal ask ("modify a goal after it has already been completed") is satisfied by this two-step flow since tweak works on the now-active goal.
- **D3 — Eligibility.** Default: `complete` only. `budget_limited` goals are `complete`-adjacent but are resume territory; keep the transition sets disjoint to preserve the "blocked/budget goals recover via /goal-resume" mental model.
- **D4 — Task contracts on reset.** Default: retain per-task verification contracts (the whole point of rerunning is re-verification). Discarding them would turn a rerun into an unverified repeat.
- **D5 — Archive history shape.** Default: `previousArchives: string[]` on `GoalRecord` (append the prior `archivedPath` each rerun, keep the current `archivedPath` meaning as-is). Alternative: a single `previousArchivePath` (simpler, loses history after the second rerun). Verify `extensions/goal-record.ts` versioning/normalization behavior before choosing; both are additive and backward-compatible with existing files.
- **D6 — Kickoff timing.** Default: kick off immediately after the confirmed mutation (resume semantics). Alternative: leave the goal active-but-idle until the user says go — rejected by default for consistency with `/goal-resume`.

## Tests and validation

Unit tests in `tests/` follow the existing patterns (see `tests/goal-task-lifecycle.test.ts`, `tests/goal-core.test.ts` for the harness):

- Rerun of a completed goal: status `active` + `autoContinue`, all tasks/subtasks `pending` with contracts retained and evidence cleared, scheduler fresh for the invoking session, `goal_rerun` ledger event with the archive path, prior archive file untouched on disk, new active file written, goal present in `openGoals()`.
- Guard rejections: active/paused/blocked/budget_limited/no-goal targets each rejected with a message; cleared (absent) goal rejected; another session's ownership rejected via the lock.
- Task immutability regression: normal `update_goal_task` flows still refuse to reopen completed tasks (rerun reset happens only through the command).
- Budget-exhausted rerun (per D1): lands at `budget_limited` with the standard recovery path.
- Repeat rerun: a goal completed a second time reruns again; `previousArchives` accumulates (per D5).
- Widget/format: no crash rendering a rerun goal; `get_goal` history shows the `goal_rerun` event and archive list.

Commands (repo root):

```bash
npm run check        # tsc --noEmit
npm run lint         # eslint
npm test             # scripts/run-unit-tests.mjs (unit)
npm run test:all     # unit + integration
```

The repo also has context-size gates (`npm run context:gate`, `npm run context:provider-check`) and e2e/checkpoint-recovery scripts; run them if the change touches prompt payloads or session flows (a new command adds no prompt payload, so the context gate should be unchanged — verify, don't assume). Manual E2E: `/goal` a small goal → complete it (with auditor) → `/goal-rerun` → confirm dashboard, task tree and second audit cycle behave per PRODUCT.md.

## Provenance

- Requested 2026-10-16 by rose; researched across the pi goal-extension ecosystem (pi.dev catalog, ~64 goal-matching packages) — no off-the-shelf equivalent.
- Fork: `TheNumberOne/pi-goal-x` ← `tmonk/pi-goal-x` @ v0.32.3. If upstreamed later, PRODUCT.md is the pitch; note upstream maintainers' own spec conventions apply.
- Related history (upstream): #63 (strict execution contracts — the async-wait half of this request, resolved by configuration), #53/#55 (waiting-loop re-queue bugs, fixed), #49 (checkpoint vs forked subagents, fixed in 0.31.1).
