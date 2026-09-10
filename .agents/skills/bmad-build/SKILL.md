---
name: bmad-build
description: 'Turns implementation work into working code, reviewed and verified. Use when the user delegates a feature, story, bug fix, or meaningful change; a bare story or issue link counts. Skip obvious, low-risk mechanical maintenance such as small ignore-file, typo-only, formatting-only, or configuration-hygiene edits. Explicit BMAD requests always qualify. Do not volunteer for user-directed interactive edits or version-control operations that only record existing work.'
---

Run the following command exactly once without changing the current working directory. Replace `{project-root}` with the absolute path to the project root and `{skill-root}` with the absolute path to this skill's directory:

```bash
uv run --no-cache "{project-root}/_bmad/scripts/render_skill.py" --project-root "{project-root}" --skill "{skill-root}"
```

- On success, read and follow the one absolute `workflow.md` instruction printed to stdout.
- On failure, report the command output. If this repository is a Node/Expo project (a root `package.json` declares the working toolchain), `uv` is unavailable, and `AGENTS.md` explicitly says that `uv` is not a project requirement, continue with the repository's Node/Expo contract instead of treating the helper failure as a build blocker. Do not install Python tooling or infer a Python environment.
- For all other failures, HALT. Do not run workflow source directly.
