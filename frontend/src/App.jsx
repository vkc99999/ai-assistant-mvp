import { useEffect, useRef, useState } from 'react';
import { Brain, Send, Square, Trash2, X, Check, ArrowRight } from 'lucide-react';
import './App.css';
import { mergeMemory, readMemory, writeMemory } from './memory.js';
import { readChats, writeChats, newChat, historyFor } from './chats.js';

const API = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
async function request(path, body, signal) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(typeof data.detail === 'string' ? data.detail : `Request failed (${res.status})`);
  return data;
}
function Stats({ data }) {
  if (!data) return null;
  return <div className="answer-meta">{data.model || data.provider || 'Council'} · {data.seconds ?? '—'}s · {typeof data.cost === 'number' ? `$${data.cost.toFixed(5)}` : 'Cost unavailable'}{data.truncated ? ' · Output limit reached' : ''}</div>;
}
function Review({ review }) {
  return <section className="review-card" aria-label="Answer review">
    <h3>{review.status === 'complete' ? 'Reviewed answer' : 'Review incomplete'}</h3>
    <p>{review.reply || 'The full review could not finish. Your original answer has not been replaced.'}</p>
    <Stats data={review} />
    {review.warnings?.map((w,i) => <p className="provider-note" key={i}>{w}</p>)}
    <small>Model review, not independent source verification.</small>
    <details><summary>See model responses and critiques</summary>
      {[['Independent answer',review.independent],['Critique',review.reviews]].flatMap(([label,items]) => (items || []).map((r,i) => <div className="review-detail" key={`${label}-${i}`}><strong>{label} · {r.model}</strong><p>{r.text}</p><Stats data={r} /></div>))}
    </details>
  </section>;
}
export default function App() {
  const [state, setState] = useState(readChats);
  const [storageError, setStorageError] = useState(false);
  const [memory, setMemory] = useState(readMemory);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState('idle');
  const [pending, setPending] = useState(null);
  const [selections, setSelections] = useState({});
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState(null);
  const controller = useRef(null);
  const advancing = useRef(false);
  const end = useRef(null);
  const chat = state.chats.find(c => c.id === state.active);
  const messages = chat?.messages || [];
  const busy = ['clarifying','answering','reviewing'].includes(phase);
  const locked = phase !== 'idle';
  useEffect(() => { setStorageError(!writeChats(state)); }, [state]);
  useEffect(() => { writeMemory(memory); }, [memory]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [state, phase]);
  function updateChat(id, fn) { setState(s => ({ ...s, chats: s.chats.map(c => c.id === id ? fn(c) : c) })); }
  function updateMessage(chatId, id, changes) { updateChat(chatId, c => ({ ...c, messages: c.messages.map(m => m.id === id ? { ...m, ...changes } : m) })); }
  function reset() { setDraft(''); setPending(null); setError(''); setSelections({}); setPhase('idle'); }
  function createChat() { if (locked) return; const c = newChat(); setState(s => ({ chats: [c,...s.chats], active: c.id })); reset(); }
  function switchChat(id) { if (locked) return; setState(s => ({ ...s, active: id })); reset(); }
  async function answer(task, selected=[]) {
    const chatId = state.active;
    const id = crypto.randomUUID();
    selected = mergeMemory(task.confirmed || [], selected);
    const context = mergeMemory(task.memory || [], selected);
    const ac = new AbortController(); controller.current = ac;
    setPhase('answering'); setError(''); setPending(null);
    updateChat(chatId, c => ({ ...c, messages: [...c.messages, { id, prompt: task.message, context: selected, fullContext: context, history: task.history, route: task.route, answer: '', status: 'loading' }] }));
    try {
      const data = await request('/chat', { message: task.message, context, history: task.history, personalize: !!task.personalizing }, ac.signal);
      updateMessage(chatId,id,{ answer: data.reply, metadata: data.metadata, status: 'complete' });
    } catch(e) {
      updateMessage(chatId,id,{ answer: e.name === 'AbortError' ? 'Response stopped.' : 'No response was returned.', status: e.name === 'AbortError' ? 'stopped' : 'failed', failure: e.name === 'AbortError' ? '' : e.message });
    } finally { if (controller.current === ac) { controller.current = null; setPhase('idle'); } }
  }
  async function ask(event) {
    event?.preventDefault(); if (locked || !draft.trim()) return;
    const candidateMemory = mergeMemory(messages.at(-1)?.fullContext || [], memory);
    const message = draft.trim(); const history = historyFor(messages); const task = { message, history, memory: [], route: {} };
    const ac = new AbortController(); controller.current = ac;
    setDraft(''); setError(''); setPhase('clarifying'); setPending(task);
    updateChat(state.active, c => ({ ...c, title: c.title === 'New chat' ? message.slice(0,48) : c.title }));
    try {
      const data = await request('/clarify',{message,memory:candidateMemory,history},ac.signal);
      if (ac.signal.aborted) return;
      const next = { ...task, route: data, memory: (data.relevant_memory || []).map(i => candidateMemory[i]).filter(Boolean) };
      if (!data.questions?.length) { await answer(next); return; }
      setPending(next); setSelections({}); setRemember(false); setPhase('choosing'); controller.current = null;
    } catch(e) { if (e.name !== 'AbortError') { setError(e.message); setPhase('idle'); controller.current = null; } }
  }
  async function personalize(entry) {
    if (locked) return;
    const candidateMemory = mergeMemory(memory, entry.fullContext || []);
    const task = { message: entry.prompt, history: entry.history || [], memory: [], route: {}, personalizing: true };
    const ac = new AbortController(); controller.current = ac;
    setPhase('clarifying'); setPending(task); setError('');
    try {
      const data = await request('/clarify', { message: entry.prompt, memory: candidateMemory, history: task.history, personalize: true }, ac.signal);
      if (ac.signal.aborted) return;
      const next = { ...task, route: data, memory: (data.relevant_memory || []).map(i => candidateMemory[i]).filter(Boolean) };
      if (!data.questions?.length) { await answer(next); return; }
      setPending(next); setSelections({}); setRemember(false); setPhase('choosing'); controller.current = null;
    } catch(e) { if(e.name !== 'AbortError') { setError(e.message); setPhase('idle'); controller.current = null; } }
  }
  function stop() { controller.current?.abort(); controller.current = null; if (phase === 'clarifying') { setDraft(pending?.message || ''); setPending(null); } setPhase('idle'); }
  async function continueAnswer(values=selections) {
    if (phase !== 'choosing' || advancing.current) return;
    advancing.current = true;
    const selected = (pending.route.questions || []).flatMap(q => values[q.question]?.trim() ? [{question:q.question, answer:values[q.question].trim()}] : []);
    const confirmed = mergeMemory(pending.confirmed || [], selected);
    if (remember) setMemory(m => mergeMemory(m,selected));
    try {
      if (pending.route.resolve_intent && !pending.detailRound && !pending.personalizing) {
        const task = { ...pending, confirmed, detailRound: true };
        const ac = new AbortController(); controller.current = ac;
        setPending(task); setPhase('clarifying'); setError('');
        try {
          const candidates = mergeMemory(memory, task.memory || []);
          const data = await request('/clarify', {message:task.message, memory:candidates, confirmed, history:task.history, detail_round:true}, ac.signal);
          if (ac.signal.aborted) return;
          const next = {...task, route:data, memory:(data.relevant_memory || []).map(i=>candidates[i]).filter(Boolean)};
          if (data.questions?.length) {
            setPending(next); setSelections({}); setPhase('choosing'); controller.current=null;
          } else await answer(next,confirmed);
        } catch(e) {
          if(e.name !== 'AbortError') {setError(e.message);setPhase('idle');controller.current=null;}
        }
      } else await answer(pending, confirmed);
    } finally { advancing.current = false; }
  }
  function selectOption(question, value) {
    const next = {...selections, [question]:value};
    setSelections(next);
    if (pending.route.questions.every(q=>next[q.question]?.trim())) void continueAnswer(next);
  }
  function finishCustomAnswer() {
    if (pending.route.questions.every(q=>selections[q.question]?.trim())) void continueAnswer(selections);
  }
  async function challenge(entry) {
    if (locked) return;
    const chatId = state.active; const ac = new AbortController(); controller.current = ac;
    setPhase('reviewing'); updateMessage(chatId,entry.id,{reviewing:true,reviewError:''});
    try {
      const review = await request('/challenge',{message:entry.prompt,context:entry.fullContext || entry.context || [],history:entry.history || [],original_answer:entry.answer},ac.signal);
      updateMessage(chatId,entry.id,{review,reviewing:false});
    } catch(e) { updateMessage(chatId,entry.id,{reviewing:false,reviewError:e.name === 'AbortError' ? 'Review stopped; provider work may already have incurred charges.' : e.message}); }
    finally { if(controller.current === ac) {controller.current=null;setPhase('idle');} }
  }
  return <div className="workspace-shell">
    <aside className="chat-sidebar" aria-label="Saved chats">
      <div className="sidebar-heading">Your conversations</div>
      <button className="primary-button new-chat" disabled={locked} onClick={createChat}>+ New chat</button>
      <div className="saved-chats">{state.chats.map(c => <div className={`chat-row ${c.id===state.active?'active':''}`} key={c.id}>
        <button className="chat-select" disabled={locked} onClick={()=>switchChat(c.id)}>{c.title}</button>
        <button className="chat-action" disabled={locked} aria-label={`Rename ${c.title}`} onClick={()=>{setEditing(c.id);setTitle(c.title);}}>✎</button>
        <button className="chat-action" disabled={locked} aria-label={`Delete ${c.title}`} onClick={()=>setDeleting(c.id)}>×</button>
      </div>)}</div>
      <p className="sidebar-note">Chats are saved in this browser. Model requests use cloud providers.</p>
    </aside>
    <div className="app-shell">
      <header className="topbar"><div className="brand"><span className="brand-mark">A</span><div><h1>AI Assistant</h1><span className="status-label">Context, memory & second opinions</span></div></div>
        <button className="tool-button" onClick={()=>setMemoryOpen(true)} aria-label={`Open memory, ${memory.length} saved items`}><Brain size={18}/><span>Memory</span><span className="count">{memory.length}</span></button>
      </header>
      <main className="conversation" aria-live="polite">
        {storageError && <div className="error-banner">Browser storage is unavailable or full. Changes may not survive a reload.</div>}
        {!messages.length && phase !== 'choosing' && <div className="empty-state"><p className="empty-kicker">Context before answers</p><h2>How can I help?</h2></div>}
        {messages.map(entry => <article className="exchange" key={entry.id}>
          <div className="user-message"><p>{entry.prompt}</p>{entry.context?.length>0 && <div className="context-list">{entry.context.map((c,i)=><span key={i}>{c.answer}</span>)}</div>}</div>
          <div className={`assistant-message ${entry.status}`}>
            {entry.status==='loading'?<span className="thinking">Thinking</span>:<><p>{entry.answer}</p><Stats data={entry.metadata}/></>}
            {entry.failure && <div className="error-banner">{entry.failure}</div>}
            {entry.metadata?.warnings?.map((w,i)=><small className="provider-note" key={i}>{w} Used a fallback.</small>)}
            {['failed','stopped'].includes(entry.status) && <button className="tool-button" disabled={locked} onClick={()=>answer({message:entry.prompt,history:entry.history || [],memory:entry.fullContext || [],route:entry.route || {}},entry.context || [])}>Retry answer</button>}
            {entry.status==='complete' && <div className="challenge-area">
              {entry.route?.challenge_recommended && <p className="review-hint">A second perspective may help. {entry.route.reason}</p>}
              <button className="tool-button" disabled={locked} onClick={()=>personalize(entry)}>Personalize this answer</button>
              <button className="tool-button" disabled={locked} onClick={()=>challenge(entry)}>{entry.reviewing?'Reviewing with two models…':entry.review?'Run review again':'Challenge this answer'}</button>
              {entry.reviewing && <p className="review-hint">Independent answers → critique → conclusion. This may take a minute or more.</p>}
              {entry.reviewError && <div className="error-banner">{entry.reviewError}</div>}
              {entry.review && <Review review={entry.review}/>}
            </div>}
          </div>
        </article>)}
        {phase==='clarifying' && <p className="thinking">Checking what context would help</p>}
        {error && <div className="error-banner"><span>{error}</span>{pending && !locked && <button onClick={()=>answer(pending)}>Answer directly</button>}</div>}
        {phase==='choosing' && pending && <section className="clarification-shell" aria-label="Clarifying questions">
          <div className="clarification-heading"><div><span>{pending.personalizing ? 'Personalize · optional' : 'Clarify'}</span><h2>{pending.message}</h2></div><button className="icon-button" aria-label="Cancel clarification" onClick={()=>{setDraft(pending.message);setPending(null);setPhase('idle');}}><X size={18}/></button></div>
          <div className="question-list">{pending.route.questions.map((q,i)=><fieldset className="question-group" key={q.question}><legend><span>{i+1}</span>{q.question}</legend>
            <div className="option-list">{q.options.map(option=><button className={selections[q.question]===option?'option selected':'option'} aria-pressed={selections[q.question]===option} key={option} onClick={()=>selectOption(q.question,option)}>{selections[q.question]===option && <Check size={15}/>}<span>{option}</span></button>)}</div>
            <input className="custom-answer" aria-label={`Your answer: ${q.question}`} placeholder="Or type an answer; press Enter when done" onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();finishCustomAnswer();}}} maxLength={500} value={selections[q.question] || ''} onChange={e=>setSelections(s=>({...s,[q.question]:e.target.value}))}/>
          </fieldset>)}</div>
          <div className="clarification-actions"><label className="remember-toggle"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/><span>Save selections to memory for future chats</span></label><div><button className="text-button" onClick={()=>answer(pending)}>Skip</button><button className="primary-button" disabled={!Object.values(selections).some(v=>v.trim())} onClick={()=>continueAnswer()}>Continue<ArrowRight size={17}/></button></div></div>
          <p className="review-hint">Selecting the final option advances automatically. For a typed answer, press Enter when done. Selections stay in this chat; saving to memory is optional.</p>
        </section>}
        <div ref={end}/>
      </main>
      {phase!=='choosing' && <form className="composer" onSubmit={ask}><div className="composer-inner"><textarea aria-label="Message" placeholder="Ask anything" rows={1} maxLength={10000} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ask();}}}/><button className={busy?'send-button stop':'send-button'} type={busy?'button':'submit'} onClick={busy?stop:undefined} disabled={!busy&&!draft.trim()} aria-label={busy?'Stop response':'Send message'}>{busy?<Square size={17}/>:<Send size={18}/>}</button></div></form>}
    </div>
    {editing && <div className="modal-backdrop"><form className="memory-dialog" role="dialog" aria-label="Rename chat" onSubmit={e=>{e.preventDefault();if(title.trim()){updateChat(editing,c=>({...c,title:title.trim()}));setEditing(null);}}}><h2>Rename chat</h2><input className="custom-answer" aria-label="Chat name" maxLength={80} value={title} onChange={e=>setTitle(e.target.value)}/><div className="clarification-actions"><button type="button" className="text-button" onClick={()=>setEditing(null)}>Cancel</button><button className="primary-button">Save</button></div></form></div>}
    {deleting && <div className="modal-backdrop"><section className="memory-dialog" role="dialog" aria-label="Delete chat"><h2>Delete this chat?</h2><p>This removes the conversation from this browser. Saved memories stay available.</p><div className="clarification-actions"><button className="text-button" onClick={()=>setDeleting(null)}>Cancel</button><button className="primary-button" onClick={()=>{setState(s=>{let chats=s.chats.filter(c=>c.id!==deleting);if(!chats.length)chats=[newChat()];return {chats,active:s.active===deleting?chats[0].id:s.active};});setDeleting(null);reset();}}>Delete chat</button></div></section></div>}
    {memoryOpen && <div className="modal-backdrop"><section className="memory-dialog" role="dialog" aria-label="Memory"><header><div><span>Browser local</span><h2>Memory</h2></div><button className="icon-button" aria-label="Close memory" onClick={()=>setMemoryOpen(false)}><X size={18}/></button></header><div className="memory-list">{!memory.length?<p className="empty-memory">Nothing remembered yet. Saving is always optional.</p>:memory.map(m=><div className="memory-item" key={m.question}><div><span>{m.question}</span><strong>{m.answer}</strong></div><button className="icon-button danger" aria-label={`Forget ${m.question}`} onClick={()=>setMemory(items=>items.filter(i=>i.question!==m.question))}><Trash2 size={16}/></button></div>)}</div>{memory.length>0 && <button className="clear-memory" onClick={()=>setMemory([])}>Clear memory</button>}</section></div>}
  </div>;
}
