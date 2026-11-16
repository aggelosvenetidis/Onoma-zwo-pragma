// =====================================================================
// dictionary.js — Φόρτωση λεξικών και υποστήριξη κλιτικών τύπων.
//
// Λεξικά κατηγοριών: server/data/dictionaries/<categoryId>.txt
// Γενικό λεξικό (προαιρετικό): server/data/dictionaries/words.txt
// Μία λέξη ανά γραμμή, με ή χωρίς τόνους — κανονικοποιούνται στη φόρτωση.
// Γραμμές που ξεκινούν με # αγνοούνται.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { normalize } = require('./normalize');

const DIR = __dirname;

/** Διαβάζει ένα αρχείο λέξεων και επιστρέφει Set κανονικοποιημένων λέξεων. */
function loadList(file) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) return new Set();
  const set = new Set();
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const n = normalize(t);
    if (n) set.add(n);
  }
  return set;
}

// Κανόνες κλίσης: [κατάληξη κλιτικού τύπου, πιθανές καταλήξεις λήμματος].
// Οι μεγαλύτερες καταλήξεις πρώτα. Δεν είναι πλήρης μορφολογία —
// καλύπτει τους συνηθισμένους πληθυντικούς/γενικές που γράφουν οι παίκτες.
const INFLECTION_RULES = [
  ['ΟΥΔΕΣ', ['ΟΥ']],          // παπούδες -> παππού(ς)
  ['ΑΔΕΣ',  ['Α', 'ΑΣ']],     // γιαγιάδες -> γιαγιά, ψαράδες -> ψαράς
  ['ΗΔΕΣ',  ['Η', 'ΗΣ']],     // μανάβηδες -> μανάβης
  ['ΕΔΕΣ',  ['ΕΣ']],          // καφέδες -> καφές
  ['ΑΤΩΝ',  ['Α']],           // πραγμάτων -> πράγμα
  ['ΑΤΑ',   ['Α']],           // πράγματα -> πράγμα
  ['ΑΤΟΣ',  ['Α']],
  ['ΙΩΝ',   ['Ι', 'Ο', 'Α']], // παιδιών -> παιδί
  ['ΙΟΥ',   ['Ι']],
  ['ΙΑ',    ['Ι', 'Ο']],      // παιδιά -> παιδί, χωριά -> χωριό
  ['ΟΙ',    ['ΟΣ']],          // λύκοι -> λύκος
  ['ΩΝ',    ['ΟΣ', 'Ο', 'Α', 'Η', 'ΑΣ', 'ΗΣ']],
  ['ΟΥ',    ['ΟΣ', 'Ο']],     // λύκου -> λύκος
  ['ΕΣ',    ['Α', 'Η', 'ΑΣ', 'ΗΣ']], // γάτες -> γάτα
  ['ΑΣ',    ['Α']],           // γάτας -> γάτα
  ['ΗΣ',    ['Η']],           // βελόνης -> βελόνη
  ['ΟΝ',    ['Ο', 'ΟΣ']],
  ['Ε',     ['ΟΣ']],          // κλητική: Γιώργο/Πέτρε
  ['Α',     ['Ο', 'ΑΣ']],     // μήλα -> μήλο
  ['Ο',     ['ΟΣ']],          // αιτιατική: τον λύκο
  ['Η',     ['ΗΣ']],
];

/** Επιστρέφει όλα τα πιθανά λήμματα μιας κανονικοποιημένης λέξης (περιλαμβάνει την ίδια). */
function lemmaCandidates(norm) {
  const out = new Set([norm]);
  // Για πολυλεκτικά (π.χ. "ΝΕΑ ΥΟΡΚΗ") κλίνουμε μόνο αν είναι μία λέξη
  if (norm.includes(' ')) return out;
  for (const [suffix, repls] of INFLECTION_RULES) {
    if (norm.length > suffix.length + 1 && norm.endsWith(suffix)) {
      const stem = norm.slice(0, -suffix.length);
      for (const r of repls) out.add(stem + r);
    }
  }
  return out;
}

class Dictionary {
  constructor(categoryIds) {
    this.byCategory = {};
    for (const id of categoryIds) this.byCategory[id] = loadList(`${id}.txt`);
    this.general = loadList('words.txt');
    const counts = Object.entries(this.byCategory).map(([k, v]) => `${k}:${v.size}`).join(' ');
    console.log(`[λεξικό] ${counts} γενικό:${this.general.size}`);
  }

  /** Αν η λέξη (ή κλιτικός τύπος της) υπάρχει στο λεξικό της κατηγορίας, επιστρέφει το λήμμα. */
  findInCategory(categoryId, norm) {
    const set = this.byCategory[categoryId];
    if (!set) return null;
    for (const c of lemmaCandidates(norm)) if (set.has(c)) return c;
    return null;
  }

  /** Υπάρχει στο γενικό λεξικό; */
  findInGeneral(norm) {
    for (const c of lemmaCandidates(norm)) if (this.general.has(c)) return c;
    return null;
  }
}

module.exports = { Dictionary, lemmaCandidates };
