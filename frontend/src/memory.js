const STORAGE_KEY = 'personalized-ai-assistant-memory-v1';
const MAX_MEMORY_ITEMS = 24;

function validItem(item) {
  return item
    && typeof item.question === 'string'
    && item.question.trim()
    && typeof item.answer === 'string'
    && item.answer.trim();
}

export function mergeMemory(existing, incoming) {
  const merged = new Map();
  [...existing, ...incoming].filter(validItem).forEach((item) => {
    const normalized = item.question.trim().toLocaleLowerCase();
    merged.set(normalized, {
      question: item.question.trim(),
      answer: item.answer.trim(),
    });
  });
  return [...merged.values()].slice(-MAX_MEMORY_ITEMS);
}

export function readMemory() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? mergeMemory([], parsed) : [];
  } catch {
    return [];
  }
}

export function writeMemory(memory) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage can be unavailable in privacy mode; the in-memory session still works.
  }
}
