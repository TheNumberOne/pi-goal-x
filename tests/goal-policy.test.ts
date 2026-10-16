import assert from "node:assert/strict";
import test from "node:test";

import {
	buildCompletionReport,
	buildGoalCreatedReport,
	buildRerunProvenance,
	buildRerunSummary,
	validateRerunGoal,
	clearGoalCommandMessage,
	shouldArmPostCompactReminder,
	shouldInjectPostCompactReminder,
	shouldQueueContinuation,
	validateGoalBlock,
	validateGoalCompletion,
	validateResumeGoal,
	type GoalPolicyRecordLike,
} from "../extensions/goal-policy.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import { detailedSummary, usageLines } from "../extensions/goal-format.ts";

function goal(overrides: Partial<GoalPolicyRecordLike> = {}): GoalPolicyRecordLike {
	return {
		id: "g1",
		objective: "=== Goal ===\nObjective: test",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

function sisyphus(overrides: Partial<GoalPolicyRecordLike> = {}): GoalPolicyRecordLike {
	return goal({
		objective: "=== Sisyphus Goal ===\nSteps:\n1. A\n2. B",
		sisyphus: true,
		...overrides,
	});
}

function rejectedMessage(result: { ok: true } | { ok: false; message: string }): string {
	assert.equal(result.ok, false);
	return result.message;
}

test("goal lifecycle completion gates reject unsafe transitions", () => {
	assert.deepEqual(validateGoalCompletion({ goal: goal({ sisyphus: false }) }), { ok: true });
	const noGoal = validateGoalCompletion({ goal: null });
	assert.equal(noGoal.ok, false);
	if (!noGoal.ok) assert.match(noGoal.message, /No goal is set/);

	const stale = validateGoalCompletion({ goal: goal({ id: "current" }), runningGoalId: "old" });
	assert.equal(stale.ok, false);
	if (!stale.ok) assert.match(stale.message, /changed during this run/);

	assert.deepEqual(validateGoalCompletion({ goal: goal({ status: "paused", autoContinue: false }) }), { ok: true });
	assert.match(rejectedMessage(validateGoalCompletion({ goal: goal({ status: "complete", autoContinue: false }) })), /complete/);

	assert.deepEqual(validateGoalCompletion({ goal: sisyphus() }), { ok: true });
});

test("update_goal(blocked) policy applies only to an active goal", () => {
	assert.deepEqual(validateGoalBlock({ goal: goal({ status: "active" }) }), { ok: true });
	assert.match(rejectedMessage(validateGoalBlock({ goal: goal({ status: "paused" }) })), /applies only to an active goal/);
	assert.match(rejectedMessage(validateGoalBlock({ goal: goal({ status: "complete" }) })), /applies only to an active goal/);
	assert.match(rejectedMessage(validateGoalBlock({ goal: null })), /No goal is set/);
});

test("resume and clear policy preserve human-owned lifecycle affordances", () => {
	assert.match(rejectedMessage(validateResumeGoal(null)), /No goal is set/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "complete" }))), /Goal is complete/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "active", autoContinue: true }))), /already running/);
	assert.deepEqual(validateResumeGoal(goal({ status: "paused", autoContinue: false })), { ok: true });

	assert.equal(clearGoalCommandMessage({ archived: true }), "Goal cleared and archived.");
	assert.equal(clearGoalCommandMessage({ archived: false }), "No goal is set.");

	assert.equal(
		buildCompletionReport({ detailedSummary: "Goal: full objective\nStatus: complete" }),
		"Goal complete.\n\nGoal: full objective\nStatus: complete",
	);
	assert.equal(
		buildCompletionReport({ detailedSummary: "Goal: full objective" }),
		"Goal complete.\n\nGoal: full objective",
	);
	assert.equal(
		buildCompletionReport({
			detailedSummary: "Goal: full objective\nStatus: complete",
			auditorReport: "Audit Report\n\n<approved/>",
		}),
		"Goal audit approved.\n\nAuditor approval:\nAudit Report\n\n<approved/>\n\nGoal complete.\n\nGoal: full objective\nStatus: complete",
	);
	// When the auditor approves, the full auditor output MUST be included in the
	// completion report so the executor agent can see the auditor's reasoning.
	// This validates the contract: the completion-flow handler passes
	// auditor.output as auditorReport (regression test for the fix).
	const longAuditorReport = [
		"I have inspected the codebase.",
		"The implementation covers all requirements:",
		"  - Feature A is fully implemented in src/a.ts",
		"  - Feature B is tested in tests/b.test.ts",
		"  - Documentation is updated in README.md",
		"<approved/>",
	].join("\n");
	const result = buildCompletionReport({
		detailedSummary: "Goal: Build X\nStatus: active",
		auditorReport: longAuditorReport,
	});
	assert.ok(result.includes(longAuditorReport), "completion report must include full auditor output");
	assert.ok(result.includes("<approved/>"), "completion report must include the approval marker from the auditor");
	assert.ok(result.includes("Goal audit approved."), "completion report must indicate audit approval");
	assert.equal(
		buildGoalCreatedReport({ objective: "# Objective\nShip the feature.", detailedSummary: "Status: active" }),
		"Goal confirmed and created.\n\nFinalized goal:\n\n# Objective\nShip the feature.\n\nGoal details:\nBudget: none\nStatus: active",
	);

	// auditSkippedReason produces "Goal audit skipped." header and includes the reason
	const skipReport = buildCompletionReport({
		detailedSummary: "Goal: Do the thing\nStatus: active",
		auditSkippedReason: "auditor disabled in settings",
	});
	assert.ok(skipReport.includes("Goal audit skipped."), "skip report must indicate audit was skipped");
	assert.ok(skipReport.includes("auditor disabled in settings"), "skip reason must be included in report");
	assert.ok(skipReport.includes("Goal complete."), "skip report must still say Goal complete");
	// auditSkippedReason takes precedence over auditorReport
	const skipPrecedence = buildCompletionReport({
		detailedSummary: "Goal: Precedence test",
		auditorReport: "<approved/>",
		auditSkippedReason: "bypassed",
	});
	assert.ok(skipPrecedence.includes("Goal audit skipped."), "auditSkippedReason must take precedence over auditorReport");
	assert.ok(!skipPrecedence.includes("<approved/>"), "auditorReport must be ignored when auditSkippedReason is present");
});

test("continuation and compaction policies are deterministic", () => {
	assert.equal(shouldQueueContinuation(goal({ status: "active", autoContinue: true })), true);
	assert.equal(shouldQueueContinuation(goal({ status: "paused", autoContinue: true })), false);

	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "active" })), true);
	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "paused", autoContinue: false })), false);
	assert.equal(shouldInjectPostCompactReminder({ pending: true, goal: sisyphus() }), true);
	assert.equal(shouldInjectPostCompactReminder({ pending: true, goal: goal({ sisyphus: false }) }), true);
	assert.equal(shouldInjectPostCompactReminder({ pending: false, goal: sisyphus() }), false);
});

test("validateRerunGoal accepts only complete goals with status-specific rejections", () => {
	assert.deepEqual(validateRerunGoal(null), { ok: false, message: "No completed goal to rerun. Use /goal to draft a new one." });
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "paused", autoContinue: false }))), /paused/i);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "paused", autoContinue: false }))), /goal-resume/);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "blocked", autoContinue: false }))), /blocked/i);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "blocked", autoContinue: false }))), /goal-resume/);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "budget_limited", autoContinue: false }))), /budget-limited/i);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "budget_limited", autoContinue: false }))), /goal-resume/);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "active" }))), /still open/i);
	assert.match(rejectedMessage(validateRerunGoal(goal({ status: "active" }))), /goal-tweak/);
	assert.deepEqual(validateRerunGoal(goal({ status: "complete", autoContinue: false })), { ok: true });
});

function rerunSource(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...createGoalForRerun(),
		...overrides,
	};
}

function createGoalForRerun(): GoalRecord {
	return {
		id: "src-goal",
		objective: "Export the CSV reports",
		status: "complete",
		autoContinue: true,
		usage: { tokensUsed: 1500, activeSeconds: 300 },
		sisyphus: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T01:00:00.000Z",
		archivedPath: ".pi/goals/archived/goal_20260101_src-goal.md",
		tokenBudget: 90000,
	};
}

test("buildRerunSummary renders the bounded pre-draft summary", () => {
	const source = rerunSource({
		taskList: {
			tasks: [
				{ id: "t1", title: "Read the CSV", status: "complete", verificationContract: "file exists" },
				{ id: "t2", title: "Write the export", status: "pending", subtasks: [{ id: "t2a", title: "Nested", status: "pending" }] },
			],
			blockCompletion: false,
			proposedAt: "2026-01-01T00:00:00.000Z",
		},
	});
	const rendered = { detailedSummary: detailedSummary(source), usageLines: usageLines(source) };
	const summary = buildRerunSummary({
		source,
		...rendered,
		auditResult: { verdict: "approved", report: "Looks good", at: "2026-01-01T01:00:00.000Z" },
	});
	assert.match(summary, /Objective: Export the CSV reports/);
	assert.match(summary, /Last audit: approved \(2026-01-01\) — Looks good/);
	assert.match(summary, /Plan: 3 tasks \(1 subtask\), 1 with verification contracts/);
	assert.match(summary, /Budget: 90000 tokens/);
	assert.match(summary, /Archives preserved: \.pi\/goals\/archived\/goal_20260101_src-goal\.md/);

	// Without an audit, the summary says so; completion summary surfaces when present.
	const noAudit = buildRerunSummary({ source, ...rendered, completionSummary: "Export shipped" });
	assert.match(noAudit, /Last audit: none recorded/);
	assert.match(noAudit, /Completion summary: Export shipped/);

	// Bounded: a pathological report cannot blow up the dialog.
	const huge = "x".repeat(5000);
	assert.ok(buildRerunSummary({ source, ...rendered, auditResult: { verdict: "approved", report: huge, at: "2026-01-01T01:00:00.000Z" } }).length <= 1203);
});

test("buildRerunProvenance snapshots the source run, omitting absent audit data", () => {
	const source = rerunSource();
	const withAudit = buildRerunProvenance(source, { verdict: "disapproved", report: "a".repeat(700), at: "2026-01-01T01:00:00.000Z" }, "ignored when audit present", "2026-01-02T00:00:00.000Z");
	assert.deepEqual(withAudit, {
		goalId: "src-goal",
		archivedPath: ".pi/goals/archived/goal_20260101_src-goal.md",
		at: "2026-01-02T00:00:00.000Z",
		summary: "a".repeat(500),
		auditVerdict: "disapproved",
	});

	const withCompletionOnly = buildRerunProvenance(source, undefined, "Export shipped", "2026-01-02T00:00:00.000Z");
	assert.deepEqual(withCompletionOnly, {
		goalId: "src-goal",
		archivedPath: ".pi/goals/archived/goal_20260101_src-goal.md",
		at: "2026-01-02T00:00:00.000Z",
		summary: "Export shipped",
	});

	const bare = buildRerunProvenance(source, undefined, undefined, "2026-01-02T00:00:00.000Z");
	assert.deepEqual(bare, { goalId: "src-goal", archivedPath: ".pi/goals/archived/goal_20260101_src-goal.md", at: "2026-01-02T00:00:00.000Z" });
	assert.ok(!("summary" in bare) && !("auditVerdict" in bare));
});
