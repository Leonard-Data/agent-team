# Workspace and Git Changes

[Previous: Workbench](./workbench.md) · [Documentation index](./README.md) · [Next: Team management](./team-management.md)

Every team member sees the same Workspace and file changes, although each may use different permissions.

## Open the Panel

Use the **Workspace** button at the top right of the workbench. Collapsing the panel changes only the layout and does not affect member access.

## Files

The **Files** tab displays a directory tree. Expand folders, refresh manually, or let host-side file watching update the view. Only safe paths within the Workspace are shown. Absolute paths, `..`, and symlink traversal outside the Workspace are rejected.

## Changes

For a Git Workspace, **Changes** groups conflicted, staged, modified, and untracked files. Click a file for a read-only unified or split diff preview.

If the Workspace root is not a Git repository, the tab says so while file browsing remains available. A repository nested inside a non-Git Workspace is not treated as the Workspace repository; select the repository root when creating the team.

## Refresh Behavior

The host tracks file changes and refreshes directory and Git state through the team event connection. Refresh manually after very large external writes, coalesced filesystem events, browser sleep, or connection recovery.

## Files Selected from the Composer

Browsers cannot safely pass arbitrary absolute local paths to a Host Agent. Selected files are uploaded into `.agent-team/uploads/`, and a Workspace-relative path is inserted into the message. A reusable safe filename is preferred; a new sanitized name is generated only when necessary to avoid a collision.

## Coordinate Concurrent Edits

Multiple members can modify one Workspace at the same time. Reduce conflicts by assigning files or modules explicitly, documenting ownership in tasks, coordinating before editing shared core files, and having the Leader review the final Git diff.
