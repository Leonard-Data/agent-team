# Troubleshooting

[Previous: Team management](./team-management.md) · [Documentation index](./README.md)

## `pnpm not found on PATH`

Harness uses pnpm to manage Profile plugins:

```bash
npm install -g pnpm
pnpm --version
```

Retry installation after a version is printed.

## npm Uses a Third-Party Registry

Check and switch the user-level registry:

```bash
npm config get registry
npm config set registry=https://registry.npmjs.org/ --location=user
```

## `EADDRINUSE 127.0.0.1:3080`

Another Harness process owns the port. Stop it with `Ctrl+C`, then run `npx @deepseek-ai/dsh web` again. On macOS or Linux, inspect the listener with `lsof -nP -iTCP:3080 -sTCP:LISTEN`.

## Team Entry Is Missing

Verify that installation used `--profile web`, Harness was fully restarted, the browser was refreshed, `@limuyang2/dsh-agent-team` appears under **Settings → Plugins**, and the running Harness instance uses the same Profile.

## Assistant or Team Lists Keep Refreshing

Look for a lost event connection notice, inspect the Harness terminal for plugin load errors, refresh the browser, and wait for reconnection. Restart Harness if `assistant.list` or `team.list` continues to time out. Model catalog loading should not block saved lists.

## Model List Is Incomplete

Agent Team shows only Providers and models configured in the active Harness Profile. Verify Provider settings and credentials, refresh the assistant catalog, and reselect the Provider and model when editing.

## Reasoning Mode Is Missing

Reasoning levels come from Harness model capabilities. When a Provider does not declare them, the plugin uses the model default. Correct or update the Profile configuration, then refresh the catalog.

## Permission Stays Read Only

Template permission is only the initial default. Change the current member session from the permission control in its composer. This does not modify the template.

## Messages Fail or Stop Does Nothing

Check the event connection and API status, wait for member state to refresh, and avoid repeatedly clicking Send while the network recovers. Stopping one member does not affect other columns.

## Enter Sends during IME Composition

The composer detects IME composition: candidate confirmation should not send, regular Enter sends, and Shift+Enter inserts a line. If this fails, report the operating system, browser, and input method.

## Assistant Cannot Be Deleted

The template is still referenced. Remove its members from every team or dissolve those teams, then delete it from **Settings → Agent Team**.

## Workspace Does Not Refresh

Use the refresh icon after browser sleep, bulk file changes, or event reconnection to reload the directory and Git state immediately.

## Changes Says the Workspace Is Not a Git Repository

The selected Workspace root must contain `.git`. A repository nested inside a normal folder is not treated as the Workspace repository.

## Selected Files Appear under `.agent-team/uploads/`

The browser cannot safely give a Host Agent arbitrary absolute paths. Copying files into the Workspace keeps them readable without crossing its security boundary.

## Old Logs Remain after Clearing or Dissolving

Harness has no public API for physically deleting one session log. Agent Team detaches and stops restoring or displaying old sessions, but Harness may retain the underlying logs.

## Report an Issue

Open a [GitHub issue](https://github.com/limuyang2/agent-team/issues) with Harness and plugin versions, Provider/model names without credentials, reproducible steps, sanitized terminal errors and screenshots, and whether refresh or restart recovers the problem.
