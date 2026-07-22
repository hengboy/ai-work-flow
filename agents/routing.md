# Agent routing rules

The Coordinator is the only user-facing entry point. It delegates work, waits for results, requests follow-up work, and summarizes outcomes. It must not inspect the workspace, run shell commands, edit files, or implement changes. Every imperative in an installed skill is an instruction to its delegated specialist, never to the Coordinator.

Route repository-wide file enumeration, `glob`, `grep`, and code-map work to File Explorer. Other roles may read only paths handed off by File Explorer and their direct dependencies. Route external research only to Researcher; Researcher does not inspect the local workspace.

Write-capable roles run serially. Document Maintainer writes ordinary documentation such as README and `docs/`. Planning Writer writes plans, tasks, ADRs, handoffs, and tracker artifacts. Full-Stack Coder writes source, tests, required configuration, and commits. Each writer reports `git diff --name-only` when finished.

Code Reviewer starts Review Standards and Review Spec in parallel only after the diff is stable, and keeps their findings separate. No other role may delegate. After a fix, the Coordinator routes a new review.
