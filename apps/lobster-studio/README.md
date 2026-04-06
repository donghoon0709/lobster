# Lobster Studio

Lobster Studio is the in-repo web editor for maintaining `.lobster` workflow files.

## Commands

- `pnpm build:studio` — compile the Studio app plus the runtime modules needed by the local Studio API seam
- `pnpm studio:serve` — build the app and serve `dist/apps/lobster-studio/` locally with Studio API endpoints for parse/test

## Scope

- Open existing `.lobster` workflow files
- Ordered task-card editing UI
- Workflow `args` / `env`
- Task `run` / `command` / `pipeline`
- Task `approval`, `stdin`, `when` / `condition`
- Overwrite-save back to the opened `.lobster` file in a compatible browser
- Minimal in-Studio Test for the current working copy
- Copy / download `.lobster` export for draft workflows

## Supported assumptions

- Overwrite-save requires a browser with the File System Access API
- Test runs through the local preview server and executes the current working copy locally
- Test uses workflow default args only
- Approval-required workflows surface as unsupported in Studio for this patch
- `.lobster` is the only supported open/save entrypoint, but `.lobster` content may use YAML or JSON syntax

## Non-goals

- Opening `.yaml`, `.yml`, or `.json` files directly
- Autosave or recent-files history
- Approval / resume UI
- Detailed or streaming runtime logs
- Dedicated test-args UI
- Extra side-effect safety UX
- Direct AI / OpenClaw invocation from the Studio UI
