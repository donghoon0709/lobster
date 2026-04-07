# MCP Server Reference

Lobster ships a local MCP server for external agents that want a narrow, deterministic workflow interface.

## Starting the server

```bash
lobster-mcp
# or
pnpm mcp:serve
```

The server speaks JSON-RPC over stdio and currently exposes a **three-tool MCP surface**:

1. `generate_workflow_draft`
2. `test_workflow`
3. `search_reference_docs`

This is intentionally smaller than earlier iterations. Workflow-editing MCP tools were removed so testing/diagnosis stays inside Lobster while mutation decisions stay with the calling agent.

## Tool list

### `search_reference_docs`

Search the Lobster documentation set for implemented behavior, especially:

- internal CLI / pipeline commands such as `llm.invoke`, `llm_task.invoke`, `approve`, and `exec`
- `.lobster` workflow-file syntax
- MCP server behavior and contracts

#### Input

```json
{
  "query": "llm.invoke approval stdin",
  "areas": ["commands", "syntax"],
  "maxResults": 5
}
```

#### Behavior

- Searches the markdown files under `docs/`
- Ranks matching sections by heading/title/body relevance
- Returns source path, heading, snippet, and score
- Keeps the search grounded in the checked-in docs rather than inferred memory

#### Areas

Supported `areas` values:

- `overview`
- `cli`
- `commands`
- `syntax`
- `mcp`

If `areas` is omitted, the tool searches the whole Lobster docs set.

### `generate_workflow_draft`

Generate a canonical `.lobster` workflow draft from a natural-language request.

#### Input

```json
{
  "request": "Generate a workflow that fetches PR info and summarizes it",
  "destination": "optional/path/to/file.lobster",
  "provider": "optional llm.invoke provider override",
  "model": "optional llm.invoke model override",
  "studioUrl": "optional Lobster Studio base URL override"
}
```

#### Behavior

- Runs a single draft-generation pass
- Returns canonical workflow text
- Optionally writes the generated file when `destination` is provided
- Returns a Lobster Studio handoff URL for immediate inspection

#### Notes

- `generate_workflow_draft` is **one-shot only**
- It no longer advertises or performs MCP-side validation / retry / self-repair loops
- Removed inputs from older revisions:
  - `validate`
  - `workflowArgs`
  - `maxRepairAttempts`

### `test_workflow`

Execute an existing `.lobster` file and report whether it completed successfully.

#### Input

```json
{
  "filePath": "/absolute/or/relative/path/to/workflow.lobster",
  "workflowArgs": {
    "optional": "workflow args passed to lobster run --args-json"
  }
}
```

#### Behavior

- Loads and executes the target workflow
- Uses Lobster runtime plus `lobster run --verbose` CLI evidence
- Never mutates the source file
- Never auto-invokes an edit tool
- Returns success/failure plus a `repairPlan` when the run does not complete cleanly
- Returns both:
  - `cliOutput`, a human-readable verbose CLI transcript
  - `verboseTrace`, a structured step-by-step trace

#### Success shape

Typical successful result:

```json
{
  "kind": "lobster.workflow.test",
  "filePath": "workflow.lobster",
  "success": true,
  "reachedFinalStep": true,
  "status": "success",
  "message": "Workflow reached the final step successfully.",
  "output": ["..."],
  "trace": [],
  "verboseTrace": [
    {
      "stepId": "hello",
      "stepType": "shell",
      "status": "succeeded"
    }
  ],
  "cliOutput": "Workflow step summary:\n\n- hello [shell] succeeded\n..."
}
```

#### Failure shape

Typical failure result:

```json
{
  "kind": "lobster.workflow.test",
  "filePath": "workflow.lobster",
  "success": false,
  "reachedFinalStep": false,
  "status": "error",
  "message": "Workflow test blocked by missing workflow args: repo",
  "repairPlan": {
    "classification": "missing_inputs",
    "summary": "Workflow test blocked by missing workflow args: repo",
    "evidence": {
      "runtimeStatus": "failed",
      "cliOutput": "..."
    },
    "suggestedEditRequest": "Update workflow.lobster so the workflow test passes. ...",
    "missingArgs": ["repo"]
  }
}
```

## `repairPlan` contract

When `test_workflow` fails, it returns a structured `repairPlan` with these fields:

- `classification`
- `summary`
- `evidence`
- `suggestedEditRequest`
- `missingArgs` when relevant
- `missingEnv` when relevant

### Classification values

Current classifications:

- `parse`
- `missing_inputs`
- `runtime`
- `cli`
- `approval`
- `cancelled`

### Intent of the repair plan

The repair plan is meant to help an external agent decide what to fix next. It is **diagnostic guidance**, not an automatic mutation path.

## `cliOutput` and `verboseTrace`

`test_workflow` now captures the output of:

```bash
lobster run --file <workflow> --verbose
```

and returns it as `cliOutput`.

Use the two fields like this:

- `cliOutput`: human-readable transcript for debugging and copy/paste inspection
- `verboseTrace`: structured step records for programmatic analysis

## Studio relationship

Lobster Studio's `/api/test-workflow` path is aligned with the same workflow-testing core, so Studio and MCP testing share the same broad pass/fail and repair-plan semantics.

## Migration notes

If you were using an older Lobster MCP integration, update callers as follows:

### Removed tools

- `edit_existing_workflow`
- `apply_existing_workflow_edit`

### Removed generate-draft inputs

- `validate`
- `workflowArgs`
- `maxRepairAttempts`

### New preferred flow

1. Call `generate_workflow_draft` to create or rewrite a workflow draft
2. Call `test_workflow` to verify execution and collect diagnostics
3. Let your outer agent decide how to edit or regenerate based on the returned `repairPlan`

## Source-of-truth files

If this document drifts, trust the implementation and tests:

- `src/mcp/server.ts`
- `src/mcp/reference_docs.ts`
- `src/workflows/generate_draft.ts`
- `src/workflows/test_workflow.ts`
- `apps/lobster-studio/scripts/studio-api.mjs`
- `test/mcp_server.test.ts`
- `test/mcp_generate_workflow.test.ts`
- `test/reference_docs.test.ts`
- `test/test_workflow.test.ts`
