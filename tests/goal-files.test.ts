import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGoal, type GoalRecord, type GoalTaskList } from "../extensions/goal-record.ts";
import { resolveRerunTarget, scanArchivedGoalFiles } from "../extensions/storage/goal-files.ts";
import {
	activePathForGoal,
	archiveGoalFile,
	archivedPathForGoal,
	parseGoalFile,
	readActiveGoalFiles,
	readActiveGoalPool,
	serializeGoalFile,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";

function tempCtx(): { cwd: string } {
	return { cwd: mkdtempSync(path.join(tmpdir(), "pi-goal-files-")) };
}

function cleanup(ctx: { cwd: string }): void {
	rmSync(ctx.cwd, { recursive: true, force: true });
}

test("serializeGoalFile and parseGoalFile round-trip metadata while allowing prompt body edits", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "=== Goal ===\nObjective: original",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 0, 2, 3, 4, 5));
		const filePath = path.join(ctx.cwd, "goal.md");
		const edited = serializeGoalFile(goal).replace(
			"=== Goal ===\nObjective: original\n\n## Progress",
			"=== Goal ===\nObjective: edited on disk\n\n## Progress",
		);
		writeFileSync(filePath, edited, "utf8");

		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.equal(parsed.id, goal.id);
		assert.equal(parsed.objective, "=== Goal ===\nObjective: edited on disk");
		assert.equal(parsed.status, "active");
	} finally {
		cleanup(ctx);
	}
});

test("goal file paths stay under active and archive roots even with unsafe metadata", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "Persist safely",
			autoContinue: true,
			sisyphus: true,
		}, Date.UTC(2026, 0, 2, 3, 4, 5));
		const unsafe = { ...goal, activePath: "../escape.md", archivedPath: ".pi/goals/not-archive.md" };

		assert.match(activePathForGoal(ctx, unsafe), /^\.pi\/goals\/active_goal_/);
		assert.match(archivedPathForGoal(ctx, unsafe), /^\.pi\/goals\/archived\/goal_/);

		const active = writeActiveGoalFile(ctx, unsafe);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		const activeFile = path.join(ctx.cwd, active.activePath ?? "missing");
		assert.match(readFileSync(activeFile, "utf8"), /# Goal Prompt/);
		assert.equal(pathExists(path.join(ctx.cwd, "..", "escape.md")), false);

		const archived = archiveGoalFile(ctx, active);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

test("readActiveGoalFiles scans deterministic safe active goal files only", () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi/goals"), { recursive: true });
		const first = writeActiveGoalFile(ctx, {
			...createGoal({ objective: "First", autoContinue: true, sisyphus: false }, Date.UTC(2026, 0, 2, 3, 4, 5)),
			id: "b-goal",
		});
		const second = writeActiveGoalFile(ctx, {
			...createGoal({ objective: "Second", autoContinue: true, sisyphus: true }, Date.UTC(2026, 0, 1, 3, 4, 5)),
			id: "a-goal",
		});
		writeFileSync(path.join(ctx.cwd, ".pi/goals", "active_goal_invalid.md"), "not json", "utf8");
		writeFileSync(path.join(ctx.cwd, ".pi/goals", "note.md"), serializeGoalFile(first), "utf8");
		try {
			symlinkSync(path.join(ctx.cwd, first.activePath ?? "missing"), path.join(ctx.cwd, ".pi/goals", "active_goal_symlink.md"));
		} catch {}

		const goals = readActiveGoalFiles(ctx);
		assert.deepEqual(goals.map((goal) => goal.id), ["a-goal", "b-goal"]);
		assert.deepEqual(goals.map((goal) => goal.activePath), [second.activePath, first.activePath]);

		const pool = readActiveGoalPool(ctx);
		assert.deepEqual(Array.from(pool.keys()).sort(), ["a-goal", "b-goal"]);
	} finally {
		cleanup(ctx);
	}
});

test("writeActiveGoalFile no longer auto-archives for complete status (deferred archival)", () => {
	const ctx = tempCtx();
	try {
		const goal = createGoal({
			objective: "Complete goal defer archival",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 1, 12, 0, 0));
		const active = writeActiveGoalFile(ctx, goal);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(active.archivedPath, undefined);

		// Now mark it complete BUT write via writeActiveGoalFile — should NOT archive
		const completeGoal = { ...active, status: "complete" as const };
		const result = writeActiveGoalFile(ctx, completeGoal);
		// Should still be an active file (not archived)
		assert.match(result.activePath ?? "", /^\.pi\/goals\/active_goal_/, "complete goal should still have activePath when written via writeActiveGoalFile");
		assert.equal(result.archivedPath, undefined, "complete goal should NOT be auto-archived by writeActiveGoalFile");
		// The active file should exist on disk with status complete in metadata
		const raw = readFileSync(path.join(ctx.cwd, result.activePath ?? "missing"), "utf8");
		assert.ok(raw.includes('"status": "complete"'), "file on disk must have status complete");

		// archiveGoalFile should still work when called explicitly
		const archived = archiveGoalFile(ctx, result);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
	} finally {
		cleanup(ctx);
	}
});

function pathExists(filePath: string): boolean {
	try {
		readFileSync(filePath);
		return true;
	} catch {
		return false;
	}
}

test("serializeGoalFile includes ## Tasks section when taskList is present", () => {
	const goal = createGoal({ objective: "Do stuff", autoContinue: true, sisyphus: false });
	const taskList: GoalTaskList = {
		tasks: [
			{ id: "t1", title: "Write tests", status: "complete", evidence: "all pass" },
			{ id: "t2", title: "Add migration", status: "pending" },
			{ id: "t3", title: "Update docs", status: "skipped", skipReason: "superseded" },
		],
		blockCompletion: true,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};
	goal.taskList = taskList;

	const serialized = serializeGoalFile(goal);
	assert.ok(serialized.includes("## Tasks"), "should include Tasks section");
	assert.ok(serialized.includes("[x] t1: Write tests"), "complete task uses [x]");
	assert.ok(serialized.includes("[ ] t2: Add migration"), "pending task uses [ ]");
	assert.ok(serialized.includes("[~] t3: Update docs"), "skipped task uses [~]");
	assert.ok(serialized.includes("blockCompletion: true"), "should include blockCompletion in comment");
	assert.ok(serialized.includes("evidence: all pass"), "should include evidence for complete task");
	assert.ok(serialized.includes("skipped: superseded"), "should include skipReason for skipped task");
});

test("serializeGoalFile omits ## Tasks section when no taskList", () => {
	const goal = createGoal({ objective: "Simple goal", autoContinue: true, sisyphus: false });
	const serialized = serializeGoalFile(goal);
	assert.equal(serialized.includes("## Tasks"), false);
});

test("parseGoalFile round-trips taskList through JSON header", () => {
	const goal = createGoal({ objective: "Stuff", autoContinue: true, sisyphus: false });
	goal.taskList = {
		tasks: [
			{ id: "t1", title: "Task 1", status: "complete" },
			{ id: "t2", title: "Task 2", status: "pending" },
		],
		blockCompletion: false,
		proposedAt: "2026-05-27T00:00:00.000Z",
	};

	const serialized = serializeGoalFile(goal);
	const tmpDir = mkdtempSync(path.join(tmpdir(), "goal-test-"));
	try {
		const filePath = path.join(tmpDir, "test-goal.md");
		writeFileSync(filePath, serialized, "utf8");
		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.ok(parsed.taskList);
		assert.equal(parsed.taskList.tasks.length, 2);
		assert.equal(parsed.taskList.tasks[0]!.id, "t1");
		assert.equal(parsed.taskList.tasks[0]!.status, "complete");
		assert.equal(parsed.taskList.tasks[1]!.id, "t2");
		assert.equal(parsed.taskList.tasks[1]!.status, "pending");
		assert.equal(parsed.taskList.blockCompletion, false);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("parseGoalFile parses goal without taskList unchanged", () => {
	const goal = createGoal({ objective: "Simple task", autoContinue: true, sisyphus: false });
	const serialized = serializeGoalFile(goal);
	const tmpDir = mkdtempSync(path.join(tmpdir(), "goal-test-"));
	try {
		const filePath = path.join(tmpDir, "test-goal.md");
		writeFileSync(filePath, serialized, "utf8");
		const parsed = parseGoalFile(filePath);
		assert.ok(parsed);
		assert.equal(parsed.taskList, undefined);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

function archiveAs(ctx: { cwd: string }, overrides: Partial<GoalRecord>, now = Date.UTC(2026, 0, 2, 3, 4, 5)): GoalRecord {
	const goal = createGoal({ objective: overrides.objective ?? "rerunnable work", autoContinue: true, sisyphus: false }, now);
	// Archived rerunnable records carry status "complete"; overrides may downgrade (e.g. cleared goals).
	return archiveGoalFile(ctx, { ...goal, status: "complete", ...overrides });
}

test("scanArchivedGoalFiles returns only complete goals with relative archivedPath", () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true });
		const complete = archiveAs(ctx, { objective: "finished work" });
		// /goal-clear archives non-complete goals; those are never rerunnable.
		archiveAs(ctx, { objective: "cleared goal", status: "paused" });

		const scanned = scanArchivedGoalFiles(ctx);
		assert.equal(scanned.length, 1);
		assert.equal(scanned[0]!.id, complete.id);
		assert.match(scanned[0]!.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_.*\.md$/);
		assert.equal(scanned[0]!.activePath, undefined);
	} finally {
		cleanup(ctx);
	}
});

test("scanArchivedGoalFiles skips malformed and foreign files without throwing", () => {
	const ctx = tempCtx();
	try {
		const archivedDir = path.join(ctx.cwd, ".pi", "goals", "archived");
		mkdirSync(archivedDir, { recursive: true });
		archiveAs(ctx, { objective: "the only complete goal" });
		writeFileSync(path.join(archivedDir, "goal_broken.md"), "not json at all", "utf8");
		writeFileSync(path.join(archivedDir, "goal_no_objective.md"), JSON.stringify({ id: "x", status: "complete" }), "utf8");
		writeFileSync(path.join(archivedDir, "notes.md"), "irrelevant", "utf8");

		const scanned = scanArchivedGoalFiles(ctx);
		assert.equal(scanned.length, 1);
		assert.match(scanned[0]!.objective, /only complete/);
	} finally {
		cleanup(ctx);
	}
});

test("scanArchivedGoalFiles returns [] for a symlinked or missing archived root", () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true });
		archiveAs(ctx, { objective: "hidden behind symlink" });
		const realDir = mkdtempSync(path.join(tmpdir(), "goal-archived-real-"));
		rmSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true, force: true });
		symlinkSync(realDir, path.join(ctx.cwd, ".pi", "goals", "archived"));
		assert.deepEqual(scanArchivedGoalFiles(ctx), []);
		rmSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true, force: true });
		rmSync(realDir, { recursive: true, force: true });
		assert.deepEqual(scanArchivedGoalFiles(ctx), []);
	} finally {
		cleanup(ctx);
	}
});

test("scanArchivedGoalFiles sorts newest first by archive timestamp", async () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true });
		// Archive filenames carry the record's updatedAt stamp, so give the two records distinct times.
		const older = archiveAs(ctx, { objective: "older" }, Date.UTC(2026, 0, 2, 3, 4, 5));
		const newer = archiveAs(ctx, { objective: "newer" }, Date.UTC(2026, 0, 2, 3, 4, 6));
		const scanned = scanArchivedGoalFiles(ctx);
		assert.equal(scanned.length, 2);
		assert.equal(scanned[0]!.id, newer.id);
		assert.equal(scanned[1]!.id, older.id);
	} finally {
		cleanup(ctx);
	}
});

test("resolveRerunTarget matches exact ids, substrings, ambiguity, tweak fallback, and empty archives", () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true });
		const alpha = archiveAs(ctx, { objective: "Export the CSV reports" }, Date.UTC(2026, 0, 2, 3, 4, 5));
		const beta = archiveAs(ctx, { objective: "Import the JSON fixtures" }, Date.UTC(2026, 0, 2, 3, 4, 6));

		// Empty argument → all complete goals, newest first.
		assert.deepEqual(resolveRerunTarget(ctx, undefined).matches.map((g) => g.id), [beta.id, alpha.id]);
		assert.equal(resolveRerunTarget(ctx, "").total, 2);

		// Exact id (case-sensitive) wins outright.
		assert.deepEqual(resolveRerunTarget(ctx, alpha.id).matches.map((g) => g.id), [alpha.id]);

		// Unique substrings of id and of objective.
		// Both ids share the same timestamp prefix (created in the same ms); use a prefix that reaches the random suffix.
		const alphaPrefix = alpha.id.slice(0, 12);
		assert.equal(resolveRerunTarget(ctx, alphaPrefix).matches.length, 1);
		assert.equal(resolveRerunTarget(ctx, "JSON fixtures").matches.length, 1);

		// Ambiguous substring → all matches (selector).
		assert.equal(resolveRerunTarget(ctx, "the").matches.length, 2);

		// No match → the argument is tweak text.
		const miss = resolveRerunTarget(ctx, "make it faster");
		assert.deepEqual(miss.matches, []);
		assert.equal(miss.tweak, "make it faster");
		assert.equal(miss.total, 2);
	} finally {
		cleanup(ctx);
	}
});

test("resolveRerunTarget reports zero total only when no complete archived goals exist", () => {
	const ctx = tempCtx();
	try {
		mkdirSync(path.join(ctx.cwd, ".pi", "goals", "archived"), { recursive: true });
		archiveAs(ctx, { objective: "cleared goal", status: "paused" });
		const withArg = resolveRerunTarget(ctx, "anything");
		assert.deepEqual(withArg.matches, []);
		assert.equal(withArg.total, 0);
		assert.deepEqual(resolveRerunTarget(ctx, undefined), { matches: [], all: [], total: 0 });
	} finally {
		cleanup(ctx);
	}
});
