<action_safety>
This section takes precedence over the general requirements for testing, measurement, and verification in AGENTS.md. {{SCOPE}}
Do only what the task specifies: no incidental refactoring, unrelated code changes, or expansion of the investigation scope.
Write the most direct implementation: do not add try/except, argument validation, fallbacks, compatibility branches, or "just in case" checks unless the task requires them.
Do not add tests unless the task requires them; when required, add only the minimum cases needed to demonstrate this change.
Do not alter git history (no commit/push/reset/checkout/stash), and do not touch credentials. Put temporary files under {{OUT}}.
</action_safety>

<verification_loop>
Run only the verification commands specified by the task, and stop after one successful run. If none are specified: when code changes, run only the one test file directly related to the change; for read-only diagnosis, do not run tests and draw conclusions from reading the code.
Do not run the full test suite, run a baseline first, repeat runs, or perform extra benchmark reruns, audits, or before-and-after comparisons: Claude runs the full checks after merging.
If you fail to fix the same failure twice in a row, stop and report it.
Do not poll remote tasks in a loop: if you need to wait, use one blocking command; otherwise, start the task, explain how to check it, and finish.
</verification_loop>

<default_follow_through_policy>
When something is ambiguous, choose the most direct, low-risk interpretation, proceed, and explain it in one sentence in the report. Stop to ask only when missing information affects correctness or could lead to an irreversible operation.
The general process skills ({{SKIP_SKILLS}}) are already covered by these rules, so do not read their SKILL.md; use domain skills as needed.
</default_follow_through_policy>

<compact_output_contract>
In English, within 10 lines: what changed (file:function) or the conclusion, why, verification commands and actual results, and unresolved items.
Label inferences as inferences. No tables, no diffs, and no retelling the process.
</compact_output_contract>
