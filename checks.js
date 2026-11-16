// =====================================================================
// checks.js — Γρήγοροι τοπικοί έλεγχοι: αρχικό γράμμα, μήκος,
// "τυχαίο string" και ακατάλληλες λέξεις.
// =====================================================================
const config = require('./config');
const { lemmaCandidates } = require('./dictionary');
const { normalize } = require('./normalize');

const VOWELS = new Set(['Α', 'Ε', 'Η', 'Ι', 'Ο', 'Υ', 'Ω']);

// Σειρές ελληνικού πληκτρολογίου (για "ασδφ", "ζχψω" κ.λπ.)
const KEYBOARD_ROWS = ['ΕΡΤΥΘΙΟΠ', 'ΑΣΔΦΓΗΞΚΛ', 'ΖΧΨΩΒΝΜ'];

/** Ξεκινά η λέξη από το γράμμα του γύρου (με εξαιρέσεις διψήφων); */
function startsWithLetter(norm, letter) {
  if (!norm.startsWith(letter)) return false;
  const excluded = config.DIGRAPH_EXCLUSIONS[letter] || [];
  return !excluded.some((dg) => norm.startsWith(dg));
}

/** Επιστρέφει λόγο απόρριψης αν μοιάζει με τυχαίο string, αλλιώς null. */
function gibberishReason(norm) {
  const letters = norm.replace(/\s/g, '');
  if (letters.length < config.VALIDATION.MIN_LENGTH) return 'Πολύ μικρή λέξη';

  if (/^(.)\1+$/.test(letters)) return 'Επαναλαμβανόμενο γράμμα';
  if (/(.)\1\1/.test(letters)) return 'Τρία ίδια γράμματα στη σειρά';

  const distinct = new Set(letters).size;
  if (letters.length >= 5 && distinct <= 2) return 'Μοιάζει με τυχαίο string';

  if (letters.length >= 3 && ![...letters].some((c) => VOWELS.has(c))) return 'Χωρίς φωνήεντα';
  if (/[^ΑΕΗΙΟΥΩ\s]{5,}/.test(norm)) return 'Πάρα πολλά σύμφωνα στη σειρά';

  if (letters.length >= 4) {
    for (const row of KEYBOARD_ROWS) {
      const rev = [...row].reverse().join('');
      if (row.includes(letters) || rev.includes(letters)) return 'Σειρά πληκτρολογίου';
    }
  }
  return null;
}

// Λίστα ακατάλληλων λέξεων (λήμματα). Επέκτεινέ την στο data/profanity.txt
const fs = require('fs');
const path = require('path');
const PROFANITY = new Set();
(function loadProfanity() {
  const f = path.join(__dirname, 'profanity.txt');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) PROFANITY.add(normalize(t));
  }
})();

/** Είναι ακατάλληλη (ή περιέχει ακατάλληλη λέξη αν είναι πολυλεκτική); */
function isProfane(norm) {
  for (const token of norm.split(' ')) {
    for (const c of lemmaCandidates(token)) if (PROFANITY.has(c)) return true;
  }
  return false;
}

module.exports = { startsWithLetter, gibberishReason, isProfane };
