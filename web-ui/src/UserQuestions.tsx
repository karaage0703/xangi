import { useEffect, useState } from 'react';
import type { PendingUserInput } from '../../src/user-input';
import { requestJson } from './api';
import { jsonInit } from './chatPresentation';

export function UserQuestions({
  sessionId,
  active,
}: {
  sessionId: string | null;
  active: boolean;
}) {
  const [request, setRequest] = useState<PendingUserInput>();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setRequest(undefined);
    setAnswers({});
    setFreeText({});
    setError('');
    if (!sessionId || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await requestJson<{ questions: PendingUserInput[] }>(
          `/api/user-input/${encodeURIComponent(sessionId)}`
        );
        if (!stopped) {
          setRequest((old) => (old?.id === result.questions[0]?.id ? old : result.questions[0]));
          setError('');
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : '質問を取得できません');
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId, active]);
  useEffect(() => {
    setAnswers({});
    setFreeText({});
  }, [request?.id]);
  if (!request) return error ? <p role="status">{error}</p> : null;
  const submit = async (cancelled: boolean) => {
    setSending(true);
    setError('');
    try {
      const values = Object.fromEntries(
        request.questions.map((q) => [
          q.id,
          freeText[q.id]?.trim() ? [freeText[q.id].trim()] : answers[q.id] || [],
        ])
      );
      await requestJson(
        `/api/user-input/${encodeURIComponent(sessionId!)}`,
        jsonInit('POST', {
          id: request.id,
          answer: cancelled ? { cancelled: true } : { answers: values },
        })
      );
      setRequest(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回答を送信できません');
    } finally {
      setSending(false);
    }
  };
  return (
    <section className="user-questions" aria-label="回答待ちの質問">
      <p>
        <strong>回答を待っています</strong>（回答期限:{' '}
        <time dateTime={new Date(request.expiresAt).toISOString()}>
          {new Date(request.expiresAt).toLocaleString()}
        </time>
        ）。
        {request.timeoutAction === 'stop'
          ? '期限後は作業を停止します。'
          : '期限後は未回答として作業を続けます。'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        {request.questions.map((q) => (
          <fieldset key={q.id} disabled={sending}>
            <legend>{q.question}</legend>
            {q.options.map((o, i) => (
              <label key={i} className="question-option">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`${request.id}-${q.id}`}
                  checked={(answers[q.id] || []).includes(o.label)}
                  onChange={(event) => {
                    setFreeText((current) => ({ ...current, [q.id]: '' }));
                    setAnswers((current) => ({
                      ...current,
                      [q.id]: q.multiSelect
                        ? event.target.checked
                          ? [...(current[q.id] || []), o.label]
                          : (current[q.id] || []).filter((v) => v !== o.label)
                        : [o.label],
                    }));
                  }}
                />{' '}
                <span>
                  {o.label}
                  {o.description && <small>{o.description}</small>}
                </span>
              </label>
            ))}
            {q.allowFreeText && (
              <label className="question-option">
                自由入力
                <textarea
                  value={freeText[q.id] || ''}
                  maxLength={2000}
                  onChange={(event) => {
                    setFreeText((current) => ({ ...current, [q.id]: event.target.value }));
                    setAnswers((current) => ({ ...current, [q.id]: [] }));
                  }}
                />
              </label>
            )}
          </fieldset>
        ))}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={sending}>
          回答を送信
        </button>{' '}
        <button type="button" disabled={sending} onClick={() => void submit(true)}>
          キャンセル
        </button>
      </form>
    </section>
  );
}
