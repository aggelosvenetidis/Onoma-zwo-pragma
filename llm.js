// =====================================================================
// llm.js — Έλεγχος κατηγορίας μέσω Claude API (μόνο server-side).
// Cache ανά (κατηγορία + λέξη) και αποφυγή διπλών ταυτόχρονων κλήσεων.
// =====================================================================
const config = require('./config');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

const cache = new Map();     // "animal:ΛΥΚΟΣ" -> { valid, reason }
const inFlight = new Map();  // ίδιο κλειδί -> Promise (για να μη ρωτάμε 2 φορές)

function isEnabled() {
  return Boolean(API_KEY);
}

function remember(key, value) {
  cache.set(key, value);
  // Απλό όριο μεγέθους: σβήνουμε την παλαιότερη εγγραφή
  if (cache.size > config.VALIDATION.LLM_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

function buildPrompt(word, category, letter) {
  return (
    `Παιχνίδι "Όνομα, Ζώο, Φυτό, Πράγμα". Γράμμα γύρου: ${letter}.\n` +
    `Είναι η λέξη "${word}" έγκυρο/η ${category.llmLabel} στα ελληνικά; ` +
    `Δέξου και κλιτικούς τύπους, υποκοριστικά και γνωστές ορθογραφικές παραλλαγές. ` +
    `Αν είναι βρισιά ή απρεπής λέξη, απάντησε valid=false. ` +
    `Απάντησε ΜΟΝΟ με JSON: {"valid": true/false, "reason": "σύντομη αιτιολογία στα ελληνικά"}`
  );
}

/** Εξάγει το πρώτο JSON αντικείμενο από το κείμενο απάντησης. */
function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (typeof obj.valid !== 'boolean') return null;
    return { valid: obj.valid, reason: String(obj.reason || '').slice(0, 120) };
  } catch {
    return null;
  }
}

async function callApi(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.VALIDATION.LLM_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 100,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return parseJson(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ρωτά το LLM αν η λέξη ανήκει στην κατηγορία.
 * Επιστρέφει { valid, reason } ή null αν δεν υπάρχει key / αποτύχει.
 */
async function checkCategory(norm, displayWord, category, letter) {
  if (!isEnabled()) return null;
  const key = `${category.id}:${norm}`;
  if (cache.has(key)) return cache.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    try {
      const result = await callApi(buildPrompt(displayWord, category, letter));
      if (result) remember(key, result);
      return result;
    } catch (err) {
      console.warn('[llm] σφάλμα:', err.message);
      return null; // δεν το βάζουμε σε cache — θα ξαναδοκιμάσει
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

module.exports = { checkCategory, isEnabled };
