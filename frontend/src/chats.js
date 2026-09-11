export const CHAT_KEY = 'personalized-ai-assistant-chats-v1';
export function newChat() {
  return { id: globalThis.crypto.randomUUID(), title: 'New chat', messages: [], createdAt: Date.now() };
}
export function readChats() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_KEY));
    const chats = raw.chats.filter(c => typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.messages));
    if (!chats.length) throw Error();
    return { chats: chats.map(c => ({ ...c, messages: c.messages.map(m => ({ ...m,
      status: m.status === 'loading' ? 'stopped' : m.status,
      answer: m.status === 'loading' ? 'Interrupted. Please retry.' : m.answer,
      reviewing: false,
    })) })), active: chats.some(c => c.id === raw.active) ? raw.active : chats[0].id };
  } catch {
    const chat = newChat();
    return { chats: [chat], active: chat.id };
  }
}
export function writeChats(state) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(state)); return true; }
  catch { return false; }
}
export function historyFor(messages) {
  return messages.filter(m => m.status === 'complete').slice(-6).map(m => ({ prompt: m.prompt.slice(0,10000), answer: m.answer.slice(0,12000) }));
}
