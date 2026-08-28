import { describe, expect, it } from 'vitest'
import {
  composerTriggerAt,
  matchingUserSkills,
  replaceComposerTrigger,
  scrollTopForActiveOption,
} from '../src/client/composer-triggers.js'

describe('composer triggers', () => {
  it('finds slash and file triggers at the caret', () => {
    expect(composerTriggerAt('Please run /doc', 15)).toEqual({
      kind: 'skill',
      start: 11,
      end: 15,
      query: 'doc',
    })
    expect(composerTriggerAt('Check @src/mai', 14)).toEqual({
      kind: 'file',
      start: 6,
      end: 14,
      query: 'src/mai',
    })
  })

  it('does not treat email addresses or quoted completed mentions as triggers', () => {
    expect(composerTriggerAt('a@example.com', 13)).toBeUndefined()
    expect(composerTriggerAt('@"docs/my plan.md"', 18)).toBeUndefined()
  })

  it('replaces the complete token and leaves the caret after a separator', () => {
    const trigger = composerTriggerAt('Use /docx-old now', 13)
    expect(trigger).toBeDefined()
    expect(replaceComposerTrigger('Use /docx-old now', trigger!, '/documents')).toEqual({
      value: 'Use /documents now',
      cursor: 14,
    })
  })

  it('offers only selected user-invocable Skills and ranks prefix matches first', () => {
    const skills = [
      { name: 'model-only', description: '', userInvocable: false },
      { name: 'review-docs', description: '', userInvocable: true },
      { name: 'docs', description: '', userInvocable: true },
      { name: 'unselected-docs', description: '', userInvocable: true },
    ]
    expect(matchingUserSkills(skills, new Set(['model-only', 'review-docs', 'docs']), 'doc'))
      .toEqual([skills[2], skills[1]])
  })

  it('keeps the keyboard-active option inside the scrolling viewport', () => {
    expect(scrollTopForActiveOption({
      viewportTop: 100,
      viewportBottom: 300,
      optionTop: 310,
      optionBottom: 350,
      scrollTop: 40,
    })).toBe(90)
    expect(scrollTopForActiveOption({
      viewportTop: 100,
      viewportBottom: 300,
      optionTop: 70,
      optionBottom: 110,
      scrollTop: 80,
    })).toBe(50)
    expect(scrollTopForActiveOption({
      viewportTop: 100,
      viewportBottom: 300,
      optionTop: 140,
      optionBottom: 180,
      scrollTop: 80,
    })).toBe(80)
  })
})
