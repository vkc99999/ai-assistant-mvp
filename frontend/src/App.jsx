import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Brain,
  Check,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import './App.css';
import { mergeMemory, readMemory, writeMemory } from './memory.js';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

function requestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

async function requestJson(path, body, signal) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `Request failed with status ${response.status}`);
  }
  return payload;
}

function App() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [selections, setSelections] = useState({});
  const [pendingPrompt, setPendingPrompt] = useState('');
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [memory, setMemory] = useState(readMemory);
  const [rememberChoices, setRememberChoices] = useState(true);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const abortControllerRef = useRef(null);
  const conversationEndRef = useRef(null);
  const inputRef = useRef(null);

  const isRequesting = phase === 'clarifying' || phase === 'answering';
  const isChoosing = phase === 'choosing';
  const selectedCount = Object.keys(selections).length;

  useEffect(() => {
    writeMemory(memory);
  }, [memory]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, questions, phase]);

  async function requestAnswer(message, selectedContext, memorySnapshot = memory) {
    const controller = new AbortController();
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;

    const id = requestId();
    const context = mergeMemory(memorySnapshot, selectedContext);
    setQuestions([]);
    setSelections({});
    setError('');
    setPhase('answering');
    setMessages((current) => [
      ...current,
      { id, prompt: message, context: selectedContext, answer: '', status: 'loading' },
    ]);

    try {
      const data = await requestJson('/chat', { message, context }, controller.signal);
      setMessages((current) =>
        current.map((entry) =>
          entry.id === id
            ? { ...entry, answer: data.reply, status: 'complete' }
            : entry,
        ),
      );
    } catch (requestError) {
      const stopped = requestError.name === 'AbortError';
      setMessages((current) =>
        current.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                answer: stopped ? 'Response stopped.' : 'No response was returned.',
                status: stopped ? 'stopped' : 'failed',
              }
            : entry,
        ),
      );
      if (!stopped) setError(requestError.message);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setPendingPrompt('');
      setPhase('idle');
      inputRef.current?.focus();
    }
  }

  async function handleAsk(event) {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || isRequesting || isChoosing) return;

    const controller = new AbortController();
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;
    setDraft('');
    setPendingPrompt(message);
    setQuestions([]);
    setSelections({});
    setError('');
    setPhase('clarifying');

    try {
      const data = await requestJson(
        '/clarify',
        { message, memory },
        controller.signal,
      );
      if (controller.signal.aborted) return;

      if (data.questions.length === 0) {
        await requestAnswer(message, [], memory);
        return;
      }
      setQuestions(data.questions);
      setPhase('choosing');
      abortControllerRef.current = null;
    } catch (requestError) {
      if (requestError.name === 'AbortError') return;
      setDraft(message);
      setError(requestError.message);
      setPhase('idle');
      abortControllerRef.current = null;
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (phase === 'clarifying') setDraft(pendingPrompt);
    setQuestions([]);
    setSelections({});
    setPhase('idle');
    inputRef.current?.focus();
  }

  function cancelClarifications() {
    setDraft(pendingPrompt);
    setPendingPrompt('');
    setQuestions([]);
    setSelections({});
    setPhase('idle');
    inputRef.current?.focus();
  }

  function chooseOption(question, answer) {
    setSelections((current) => ({ ...current, [question]: answer }));
  }

  function continueWithContext() {
    const selectedContext = questions.flatMap(({ question }) =>
      selections[question] ? [{ question, answer: selections[question] }] : [],
    );
    const nextMemory = rememberChoices
      ? mergeMemory(memory, selectedContext)
      : memory;
    if (rememberChoices) setMemory(nextMemory);
    requestAnswer(pendingPrompt, selectedContext, nextMemory);
  }

  function answerDirectly() {
    requestAnswer(pendingPrompt, [], memory);
  }

  function removeMemory(question) {
    setMemory((current) => current.filter((item) => item.question !== question));
  }

  function clearConversation() {
    abortControllerRef.current?.abort();
    setMessages([]);
    setQuestions([]);
    setSelections({});
    setPendingPrompt('');
    setError('');
    setPhase('idle');
    inputRef.current?.focus();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div>
            <h1>AI Assistant</h1>
            <span className="status-label">Personal memory MVP</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="tool-button"
            type="button"
            onClick={() => setMemoryOpen(true)}
            title="Open memory"
            aria-label={`Open memory, ${memory.length} saved items`}
          >
            <Brain size={18} aria-hidden="true" />
            <span>Memory</span>
            <span className="count">{memory.length}</span>
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={clearConversation}
            disabled={messages.length === 0 && !isChoosing}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="conversation" aria-live="polite">
        {messages.length === 0 && !isChoosing && (
          <div className="empty-state">
            <p className="empty-kicker">Context before answers</p>
            <h2>How can I help?</h2>
          </div>
        )}

        {messages.map((entry) => (
          <article className="exchange" key={entry.id}>
            <div className="user-message">
              <p>{entry.prompt}</p>
              {entry.context.length > 0 && (
                <div className="context-list" aria-label="Selected context">
                  {entry.context.map((item) => (
                    <span key={`${item.question}-${item.answer}`}>{item.answer}</span>
                  ))}
                </div>
              )}
            </div>
            <div className={`assistant-message ${entry.status}`}>
              {entry.status === 'loading' ? (
                <span className="thinking">Thinking</span>
              ) : (
                <p>{entry.answer}</p>
              )}
            </div>
          </article>
        ))}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            {pendingPrompt && !isRequesting && !isChoosing && (
              <button type="button" onClick={answerDirectly}>Answer directly</button>
            )}
          </div>
        )}

        {isChoosing && (
          <section className="clarification-shell" aria-label="Clarifying questions">
            <div className="clarification-heading">
              <div>
                <span>Clarify</span>
                <h2>{pendingPrompt}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={cancelClarifications}
                title="Cancel clarification"
                aria-label="Cancel clarification"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="question-list">
              {questions.map(({ question, options }, index) => (
                <fieldset className="question-group" key={question}>
                  <legend><span>{index + 1}</span>{question}</legend>
                  <div className="option-list">
                    {options.map((option) => {
                      const selected = selections[question] === option;
                      return (
                        <button
                          className={selected ? 'option selected' : 'option'}
                          type="button"
                          key={option}
                          onClick={() => chooseOption(question, option)}
                          aria-pressed={selected}
                        >
                          {selected && <Check size={15} aria-hidden="true" />}
                          <span>{option}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>

            <div className="clarification-actions">
              <label className="remember-toggle">
                <input
                  type="checkbox"
                  checked={rememberChoices}
                  onChange={(event) => setRememberChoices(event.target.checked)}
                />
                <span>Remember selections</span>
              </label>
              <div>
                <button className="text-button" type="button" onClick={answerDirectly}>
                  Skip
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={continueWithContext}
                  disabled={selectedCount === 0}
                >
                  Continue
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>
        )}

        <div ref={conversationEndRef} />
      </main>

      {!isChoosing && (
        <form className="composer" onSubmit={handleAsk}>
          <div className="composer-inner">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleAsk(event);
                }
              }}
              placeholder="Ask anything"
              rows="1"
              maxLength="10000"
              aria-label="Message"
            />
            <button
              className={isRequesting ? 'send-button stop' : 'send-button'}
              type={isRequesting ? 'button' : 'submit'}
              onClick={isRequesting ? handleStop : undefined}
              disabled={!isRequesting && !draft.trim()}
              title={isRequesting ? 'Stop response' : 'Send message'}
              aria-label={isRequesting ? 'Stop response' : 'Send message'}
            >
              {isRequesting
                ? <Square size={17} fill="currentColor" aria-hidden="true" />
                : <Send size={18} aria-hidden="true" />}
            </button>
          </div>
        </form>
      )}

      {memoryOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-title">
            <header>
              <div>
                <span>Browser local</span>
                <h2 id="memory-title">Memory</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setMemoryOpen(false)}
                title="Close memory"
                aria-label="Close memory"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <div className="memory-list">
              {memory.length === 0 ? (
                <p className="empty-memory">Nothing remembered yet.</p>
              ) : memory.map((item) => (
                <div className="memory-item" key={item.question}>
                  <div>
                    <span>{item.question}</span>
                    <strong>{item.answer}</strong>
                  </div>
                  <button
                    className="icon-button danger"
                    type="button"
                    onClick={() => removeMemory(item.question)}
                    title="Forget this memory"
                    aria-label={`Forget ${item.question}`}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            {memory.length > 0 && (
              <button className="clear-memory" type="button" onClick={() => setMemory([])}>
                <Trash2 size={16} aria-hidden="true" />
                Clear memory
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;
