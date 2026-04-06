# Lobster Studio

Lobster Studio is the v0.2.0 in-repo web editor for authoring `.lobster` workflow files.

## Commands

- `pnpm build:studio` — compile the app and copy static assets into `dist/apps/lobster-studio/`
- `pnpm studio:serve` — build the app and serve `dist/apps/lobster-studio/` locally

## Scope

- Ordered task-card authoring UI
- Workflow `args` / `env`
- Task `run` / `command` / `pipeline`
- Task `approval`, `stdin`, `when` / `condition`
- Copy / download `.lobster` export
- Generated-draft handoff URLs from the MCP server

## Non-goals

- Running workflows from the UI
- Importing existing `.lobster` files
- Direct AI / OpenClaw invocation
