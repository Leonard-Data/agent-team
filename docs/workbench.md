# Workbench and Collaboration

[Previous: Creating teams](./creating-teams.md) · [Documentation index](./README.md) · [Next: Workspace](./workspace.md)

The full-screen workbench opens after team creation. Switch teams on the left, use member conversations in the center, and open the shared Workspace on the right.

![Multi-member workbench](../demo/4.png)

## Member Tabs

- Click a tab to show or hide that conversation column.
- A crown identifies the Leader.
- Status indicators show idle, running, waiting, error, or offline state.
- Hover a non-Leader tab to remove that member.
- **Add assistant** opens the reusable assistant picker.
- **Manage team** opens member and lifecycle controls.

Hiding a column does not stop the member or clear its context.

## Conversation Columns

Every column is an independent Harness session with user messages, Markdown responses, collapsible Think content, tool activity, team messages, Question/Approval cards, member status, and stop controls. Double-click the header to expand a conversation into an overlay.

## Send Messages

- `Enter` sends a message and `Shift+Enter` inserts a new line.
- Confirming an IME composition does not send the message.
- A message sent while the member runs is queued according to Harness behavior.
- The stop button affects only the current member.

Describe the full goal to the Leader first, then message a specialist directly when implementation details need clarification.

## Add and Mention Files

Use the paperclip to select local files. They are copied into `.agent-team/uploads/` inside the Workspace and their Agent-readable paths are inserted into the message.

Type `@` to search Workspace files. Continue typing to filter, use arrow keys to select, and press Enter or Tab to insert. Paths containing spaces are quoted automatically. A mention supplies context but does not modify the file.

## Invoke Skills

Type `/` to list user-invocable Skills allowed for the current member. Filter by name, use arrow keys to select, Enter or Tab to insert, and Esc to close. The sent `/skill-name` literal is handled by the Harness Skill boundary. Model-only Skills are not shown.

## Session Permissions

- **Read only** for analysis, review, retrieval, and planning.
- **Workspace write** to modify the current Workspace.
- **Full access** only when the task requires broader permissions.

Runtime changes affect only the current member session and do not edit its template or other members.

## Reasoning Mode and Context

The reasoning selector shows levels supported by the current model. Changes apply on the next turn. The information icon lists loaded Skills, while the context ring shows usage. Hover over the ring for context window, input/output token, and cache statistics.

Use **Clear tasks and context** when the entire team needs new sessions.

## Agent Communication

Members do not read one another's chat history. The Leader creates and assigns tasks, assigned members report status and results, and updates are delivered back to the Leader. Direct team messages handle clarification. Stable member IDs distinguish duplicate names and rejoined members.

Switching teams in the left navigator does not stop members still running in the background.
