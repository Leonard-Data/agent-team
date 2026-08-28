import { useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InteractionResponseInput,
  PendingInteractionView,
  QuestionAnswerView,
} from '../../transport/contracts.js'
import css from './ConversationColumn.module.css'

export function PendingInteractionCard({
  interaction,
  onRespond,
}: {
  interaction: PendingInteractionView
  onRespond: (response: InteractionResponseInput) => Promise<void>
}): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, QuestionAnswerView>>(() => (
    interaction.kind === 'question'
      ? Object.fromEntries(interaction.questions.map(question => [question.id, {
        id: question.id,
        selected: [],
      }]))
      : {}
  ))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()

  async function submitResponse(response: InteractionResponseInput): Promise<void> {
    if (submitting || submitted) return
    setSubmitting(true)
    try {
      await onRespond(response)
      setSubmitted(true)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  if (interaction.kind === 'approval') {
    return (
      <article className={`${css.interactionCard} ${css.approvalCard}`} aria-live="polite">
        <header className={css.interactionHeader}>
          <strong>Approval required</strong>
          <span>{submitted ? 'Submitted' : 'Waiting for action'}</span>
        </header>
        <div className={css.approvalToolName}>{interaction.toolName}</div>
        {interaction.reason && <p className={css.interactionDescription}>{interaction.reason}</p>}
        <div className={css.interactionActions}>
          <button
            type="button"
            className={css.interactionSecondaryButton}
            disabled={submitting || submitted}
            onClick={() => { void submitResponse({ kind: 'approval', outcome: 'rejected' }) }}
          >
            Deny
          </button>
          <button
            type="button"
            className={css.interactionPrimaryButton}
            disabled={submitting || submitted}
            onClick={() => { void submitResponse({ kind: 'approval', outcome: 'allowed-once' }) }}
          >
            {submitting ? 'Submitting…' : submitted ? 'Allowed' : 'Allow once'}
          </button>
        </div>
        {error && <span className={css.interactionError}>{error}</span>}
      </article>
    )
  }

  const complete = interaction.questions.every(question => {
    const answer = answers[question.id]
    return answer !== undefined && (answer.selected.length > 0 || Boolean(answer.custom?.trim()))
  })

  function updateAnswer(questionId: string, update: (current: QuestionAnswerView) => QuestionAnswerView): void {
    setAnswers(current => {
      const answer = current[questionId] ?? { id: questionId, selected: [] }
      return { ...current, [questionId]: update(answer) }
    })
  }

  return (
    <form
      className={`${css.interactionCard} ${css.questionCard}`}
      aria-live="polite"
      onSubmit={event => {
        event.preventDefault()
        if (!complete) return
        void submitResponse({
          kind: 'question',
          answers: interaction.questions.map(question => answers[question.id]!),
        })
      }}
    >
      <header className={css.interactionHeader}>
        <strong>{interaction.questions.some(question => question.intent?.kind === 'plan-review') ? 'Review the plan' : 'Your answer is required'}</strong>
        <span>{interaction.questions.length} questions</span>
      </header>
      <div className={css.questionList}>
        {interaction.questions.map((question, index) => {
          const answer = answers[question.id] ?? { id: question.id, selected: [] }
          const inputType = question.multiSelect === true ? 'checkbox' : 'radio'
          return (
            <fieldset key={question.id} className={css.questionFieldset} disabled={submitting || submitted}>
              <legend>
                {question.header && <span>{question.header}</span>}
                <strong>{interaction.questions.length > 1 ? `${index + 1}. ${question.question}` : question.question}</strong>
              </legend>
              {question.detail && (
                <div className={css.questionDetail}><MarkdownText text={question.detail} /></div>
              )}
              {(question.options?.length ?? 0) > 0 && (
                <div className={css.questionOptions}>
                  {question.options?.map(option => (
                    <label key={option.label} className={css.questionOption}>
                      <input
                        type={inputType}
                        name={`${interaction.id}:${question.id}`}
                        checked={answer.selected.includes(option.label)}
                        onChange={event => {
                          updateAnswer(question.id, current => {
                            if (question.multiSelect === true) {
                              const selected = event.target.checked
                                ? [...current.selected, option.label]
                                : current.selected.filter(label => label !== option.label)
                              return { ...current, selected }
                            }
                            return { id: current.id, selected: [option.label] }
                          })
                        }}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <textarea
                className={css.questionCustomInput}
                value={answer.custom ?? ''}
                rows={2}
                placeholder={(question.options?.length ?? 0) > 0 ? 'Other answer (optional)' : 'Enter your answer'}
                onChange={event => {
                  const custom = event.target.value
                  updateAnswer(question.id, current => ({
                    id: current.id,
                    selected: question.multiSelect === true ? current.selected : [],
                    ...(custom.length === 0 ? {} : { custom }),
                  }))
                }}
              />
            </fieldset>
          )
        })}
      </div>
      <div className={css.interactionActions}>
        <button
          type="submit"
          className={css.interactionPrimaryButton}
          disabled={!complete || submitting || submitted}
        >
          {submitting ? 'Submitting…' : submitted ? 'Submitted' : 'Submit answers'}
        </button>
      </div>
      {error && <span className={css.interactionError}>{error}</span>}
    </form>
  )
}
