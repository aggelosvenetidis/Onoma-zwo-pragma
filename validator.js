// =====================================================================
// validator.js — Επαλήθευση λέξης σε στάδια (όλα στον server).
//
// Αποτέλεσμα: {
//   valid: boolean,
//   status: 'empty' | 'invalid' | 'ok' | 'uncertain',
//   reason: string,
//   source: 'rules' | 'dictionary' | 'llm' | 'fallback',
//   key: string   // κανονική μορφή για σύγκριση "ίδιας λέξης" μεταξύ παικτών
// }
// =====================================================================
const config = require('./config');
const { normalize } = require('./normalize');
const { Dictionary } = require('./dictionary');
const { startsWithLetter, gibberishReason, isProfane } = require('./checks');
const llm = require('./llm');

const categoriesById = Object.fromEntries(config.CATEGORIES.map((c) => [c.id, c]));
const dictionary = new Dictionary(config.CATEGORIES.map((c) => c.id));

const result = (valid, status, reason, source, key) => ({ valid, status, reason, source, key });

async function validateWord(rawWord, letter, categoryId) {
  // 1. Κανονικοποίηση
  const norm = normalize(rawWord);
  if (!norm) return result(false, 'empty', 'Κενό', 'rules', '');

  // 2. Αρχικό γράμμα (με δίψηφα)
  if (!startsWithLetter(norm, letter)) {
    return result(false, 'invalid', `Δεν ξεκινά από ${letter}`, 'rules', norm);
  }

  // 3. Μήκος & τυχαίο string
  const gib = gibberishReason(norm);
  if (gib) return result(false, 'invalid', gib, 'rules', norm);

  // Φίλτρο ακατάλληλου περιεχομένου
  if (isProfane(norm)) return result(false, 'invalid', 'Ακατάλληλη λέξη', 'rules', norm);

  // 4. Λεξικό κατηγορίας (με κλιτικούς τύπους)
  const lemma = dictionary.findInCategory(categoryId, norm);
  if (lemma) return result(true, 'ok', 'Στο λεξικό', 'dictionary', lemma);

  // 5. LLM για ό,τι δεν βρέθηκε (με cache)
  const category = categoriesById[categoryId];
  const safeWord = rawWord.replace(/[^\p{Script=Greek}\s-]/gu, '').trim() || norm;
  const ai = await llm.checkCategory(norm, safeWord, category, letter);
  if (ai) {
    return result(ai.valid, ai.valid ? 'ok' : 'invalid', ai.reason || (ai.valid ? 'Έγκυρη' : 'Άκυρη'), 'llm', norm);
  }

  // Χωρίς LLM: γενικό λεξικό ή πολιτική αποδοχής
  const general = dictionary.findInGeneral(norm);
  if (general) return result(true, 'uncertain', 'Υπάρχει στο λεξικό (χωρίς έλεγχο κατηγορίας)', 'fallback', general);
  if (config.VALIDATION.ACCEPT_UNKNOWN_WITHOUT_LLM) {
    return result(true, 'uncertain', 'Δεν επιβεβαιώθηκε — αμφισβητήστε αν διαφωνείτε', 'fallback', norm);
  }
  return result(false, 'invalid', 'Δεν βρέθηκε στο λεξικό', 'fallback', norm);
}

module.exports = { validateWord };
