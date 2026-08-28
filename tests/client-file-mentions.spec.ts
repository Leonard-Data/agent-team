import { describe, expect, it } from 'vitest'
import { insertWorkspaceFileMention, workspaceFileMention } from '../src/client/file-mentions.js'

describe('Workspace file mentions', () => {
  it('quotes paths that contain whitespace', () => {
    expect(workspaceFileMention('docs/my plan.md')).toBe('@"docs/my plan.md"')
    expect(workspaceFileMention('src/main.ts')).toBe('@src/main.ts')
  })

  it('inserts a mention at the current cursor with readable spacing', () => {
    expect(insertWorkspaceFileMention('Check file', 10, 10, 'src/main.ts')).toEqual({
      value: 'Check file @src/main.ts',
      cursor: 23,
    })
  })

  it('replaces selected text and preserves surrounding content', () => {
    expect(insertWorkspaceFileMention('View old then edit', 5, 8, 'docs/my plan.md')).toEqual({
      value: 'View @"docs/my plan.md" then edit',
      cursor: 23,
    })
  })
})
