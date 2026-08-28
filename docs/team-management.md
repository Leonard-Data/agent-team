# Team Management

[Previous: Workspace](./workspace.md) · [Documentation index](./README.md) · [Next: Troubleshooting](./troubleshooting.md)

Click **Manage team** in the workbench to manage members, the Leader, context, and lifecycle.

## Add Members

Select an assistant to create a new member snapshot and independent session attached to the team Workspace. Once ready, the member joins the workbench and the Leader receives its name, stable member ID, model, and status. The same assistant can be added more than once.

## Remove Members

Remove a regular member from its card, tab, or management dialog. The plugin stops and archives its session, removes it from active membership, notifies the Leader, and preserves Workspace output. Removal is blocked while the member owns unfinished tasks. Transfer the Leader role before removing the current Leader.

## Change the Leader

Click **Set as Leader** on a regular member. The old Leader becomes a regular member, the new Leader receives coordination rules, and both keep their existing sessions and context. The team always retains exactly one Leader.

## Clear Tasks and Context

Use this when context is too long, work must restart completely, or team state is confused. The operation stops every member, clears team tasks and pending messages, and creates a new session for every retained member. It preserves membership, the Leader, assistant snapshots, runtime settings, and every Workspace file.

This does not undo file edits or roll back Git changes.

## Dissolve a Team

| Deleted | Retained |
| --- | --- |
| Team settings | Assistant templates |
| Team tasks | Workspace files |
| Team messages and activity | Provider, model, Skill, and MCP configuration |
| Agent Team restoration links to old sessions | Session logs that Harness may retain |

Dissolving is irreversible and removes the team from the navigator. Its assistants remain reusable.

## Why Teams Are Not Paused

A team is a set of members and collaboration relationships, not a continuously running process. Idle members perform no work. To stop activity, stop a member's output, clear all tasks and context, remove unnecessary members, or dissolve the team.
