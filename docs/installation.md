# Installation and Startup

[Documentation index](./README.md) · [Next: Assistant library](./assistants.md)

## Requirements

- Node.js `22.19.0+` or `24.0.0+`
- DeepSeek Harness `0.1.1-rc.2`
- Agent Team `0.1.4`
- `pnpm` available on `PATH`

Check installed versions:

```bash
node --version
pnpm --version
```

Install pnpm if necessary:

```bash
npm install -g pnpm
```

## Build This Repository

Clone the English fork and build it locally:

```bash
git clone https://github.com/Leonard-Data/agent-team.git
cd agent-team
npm install
npm run check
npm pack
```

The final command creates `limuyang2-dsh-agent-team-0.1.4.tgz`. The archive retains the existing npm package ID in its filename, but its contents are built from the current `Leonard-Data/agent-team` checkout.

## Install in Harness Web

Remove a previously installed upstream copy if necessary, then add the local archive:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @limuyang2/dsh-agent-team
npx @deepseek-ai/dsh plugin --profile web add ./limuyang2-dsh-agent-team-0.1.4.tgz
npx @deepseek-ai/dsh web
```

The remove command is only needed when another version is already installed. Open the URL printed in the terminal, normally <http://127.0.0.1:3080/>.

## Use the Official npm Registry

If npm displays a third-party registry during login or installation, switch the user-level registry back to npm:

```bash
npm config set registry=https://registry.npmjs.org/ --location=user
npm config get registry
```

The second command should print `https://registry.npmjs.org/`.

## Install in Harness Desktop

From the repository root after `npm pack`, run:

```bash
dsh plugin add ./limuyang2-dsh-agent-team-0.1.4.tgz
```

Quit and reopen DeepSeek Harness Desktop after installation. Replace the filename when building a different version.

## Verify Installation

After Harness starts, verify that:

1. A floating **Team** button appears on the left and opens the workbench.
2. **Settings → Agent Team** contains the assistant library.

## Restart after Installing or Updating

Stop a running Harness process with `Ctrl+C`, run `npx @deepseek-ai/dsh web` again, and refresh the browser if needed. The plugin never modifies Harness source code.

## Uninstall

Stop Harness, then run:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @limuyang2/dsh-agent-team
```

Restart Harness afterward. Uninstallation does not modify Harness source or delete Workspace files. Stored templates, team records, and session references remain only while the relevant Harness Profile data remains; back up that profile before manually removing its data.

Continue with the [Assistant library](./assistants.md) to create your first Leader and member.
