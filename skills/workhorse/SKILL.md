---
name: workhorse
description: (Claude Code only; Codex must not use this.) Hand coding, ops (deploys, remote runs) or review work to Codex with the `mcp__workhorse__run` tool, the way you would spawn a subagent. Use for any multi-file implementation, bug fix, refactor, deploy or regression run.
---

# workhorse: Codex as a subagent

Use `mcp__workhorse__run`. Fill `goal`, `context`, `done_when` (required) and `constraints` (optional), the four parts below, plus `mode` (`code`/`review`/`ops`), `dir` or `worktree`, `name`, `effort` (a free-form string), `model` as needed; use `resume` to follow up in the same thread and `to_code` to turn a review into a fix. The call returns at once, and the report arrives later as a message from workhorse: for a code job with the acceptance command to run, for a review job with a reminder to check its evidence. Don't poll. The mod refuses a brief without `done_when` or with gate phrases (baseline, full test suite, ...), asks before `mode: ops` and before resuming an ops job (unless `to_code` or another `mode` is set), and warns you when a job stalls or over-tests. While jobs run, a band above the prompt shows each one with its state, elapsed time and latest Codex event. The user can run `/workhorse-kill <name>` at any time.

Use the CLI below for inspecting and cleaning up jobs.

| Call | Effect |
|---|---|
| `workhorse --clean name` | after merging, remove that worktree and branch; refuses, leaving both in place, if the branch is not merged into the main checkout's HEAD or the worktree has uncommitted changes |
| `workhorse -s [name ...]` | job status as JSON (all running jobs when no name), including `activity` (the latest event in one line) and `files` (changed files) |
| `workhorse -l` | recent jobs: running ones with minutes, finished ones with the report's first line (exit, minutes, tokens, commands, test runs) |
| `workhorse -t [name]` | last commands, test runs so far, elapsed time and minutes since the last output (spots a stall) |
| `workhorse -k [name]` | stop a job and every command it started |

The report's first line has `tokens=` (new input plus output) and `cached=`, and `tests=N`: how many test commands Codex ran. Anything above 1–2 means it over-tested; tighten the next brief. The diff stat compares the tree before and after the job, including new files, so it is right even when the tree was already dirty; anything else that writes to that tree meanwhile is counted too, so give parallel jobs their own worktrees. Jobs older than 14 days are pruned. Jobs live in `~/.cache/workhorse/<name>/` (`prompt.md`, `events.jsonl`, `codex.log`, `final.md`, `report.txt`, `session.txt`). Models, efforts, the Fast-tier match and disabled MCP servers come from the plugin's settings, `~/.config/workhorse/config`, or `WORKHORSE_*` variables. Model, effort and sandbox are passed on every call, resumes included, so the user's Codex app settings never leak in. If a resume silently starts a new thread, the report says so.

workhorse wraps the brief in `<task>` and adds the blocks from OpenAI's own Codex prompting guide: `action_safety`, `verification_loop`, `default_follow_through_policy` and `compact_output_contract`. These carry the lean rules: do only what is asked, no defensive code, no unrequested tests, run only the named check once, no polling loops, keep going without routine questions, report in at most 10 lines. Don't repeat them in the brief.

## Write the brief

Use OpenAI's four parts and keep each to a few lines:
- **Goal**: the one change.
- **Context**: file and function, the evidence or error in one or two sentences, paths it needs.
- **Constraints**: only what is specific to this task. The general rules are already added.
- **Done when**: one acceptance command.

Rules:
- **One job, one change.** Unrelated asks go to separate jobs. OpenAI's guide lists mixed jobs as an anti-pattern.
- **Unknown root cause:** use `mode: review` first, then `resume` with `to_code: true`. Don't send an investigation and a fix in one brief.
- **No gates in the brief.** Leave out baselines, full suites, project-wide checks, benchmark reruns and before/after tables; Claude runs the gates once on the merged result. Ask for a measurement only when it is the acceptance criterion. Briefs that asked for all of these produced 500K–774K token, 50–84 min jobs.
- **Tighten the brief before raising effort.** OpenAI recommends starting astra at a low effort; a better contract beats more reasoning.
- **Parallel:** 2–3 jobs at once, each with `worktree: <task>` on disjoint files. Commit first, since worktrees start from HEAD. Always set `resume` to the job name. After merging, `workhorse --clean <task>`.
- **Long remote runs:** an ops job launches the run, or calls one script that runs, waits and collects in a single blocking command. Claude waits with Monitor, then uses `resume` to analyse.

## Supervise and review

- Stall and over-testing warnings arrive on their own. When the last output is old, or the commands repeat, `workhorse -k` and re-brief it smaller.
- Never accept unreviewed. Read the diff against the brief, run the acceptance command yourself, and send fixes back with `resume`.
- A failed job is reported to the user with its log tail. Don't quietly redo it yourself.
