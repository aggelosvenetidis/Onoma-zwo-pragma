// Τεστ λογικής (χωρίς δίκτυο): node --test tests/
const test = require('node:test');
const assert = require('node:assert');
delete process.env.ANTHROPIC_API_KEY; // χωρίς LLM στα τεστ

const { normalize } = require('./normalize');
const { validateWord } = require('./validator');
const { gibberishReason, startsWithLetter } = require('./checks');
const { scoreRound } = require('./scoring');

test('κανονικοποίηση', () => {
  assert.strictEqual(normalize('  Άρης!! '), 'ΑΡΗΣ');
  assert.strictEqual(normalize('αρης'), normalize('Άρης'));
  assert.strictEqual(normalize('Πτολεμαΐδα'), 'ΠΤΟΛΕΜΑΙΔΑ');
  assert.strictEqual(normalize('νέα   υόρκη'), 'ΝΕΑ ΥΟΡΚΗ');
});

test('αρχικό γράμμα & δίψηφα', () => {
  assert.ok(startsWithLetter('ΟΡΕΣΤΗΣ', 'Ο'));
  assert.ok(!startsWithLetter('ΟΥΡΑΝΙΑ', 'Ο'));
  assert.ok(!startsWithLetter('ΛΥΚΟΣ', 'Κ'));
});

test('τυχαία strings', () => {
  for (const w of ['ΑΑΑΑΑ', 'ΚΚΚΚ', 'ΑΣΔΦ', 'ΚΤΡΣΒ', 'Α']) assert.ok(gibberishReason(w), w);
  for (const w of ['ΛΥΚΟΣ', 'ΑΝΝΑ', 'ΕΚΣΤΡΑΤΕΙΑ', 'ΖΩΗ']) assert.strictEqual(gibberishReason(w), null, w);
});

test('επαλήθευση λέξεων', async () => {
  assert.strictEqual((await validateWord('λύκος', 'Λ', 'animal')).status, 'ok');
  assert.strictEqual((await validateWord('ΛΥΚΟΙ', 'Λ', 'animal')).key, 'ΛΥΚΟΣ'); // κλιτικός τύπος
  assert.strictEqual((await validateWord('Γιώργο', 'Γ', 'name')).key, 'ΓΙΩΡΓΟΣ');
  assert.strictEqual((await validateWord('γάτα', 'Λ', 'animal')).valid, false);
  assert.strictEqual((await validateWord('', 'Λ', 'animal')).status, 'empty');
  assert.strictEqual((await validateWord('μαλάκα', 'Μ', 'thing')).valid, false);
  const unknown = await validateWord('Λαγωνικό', 'Λ', 'animal');
  assert.strictEqual(unknown.status, 'uncertain'); // χωρίς LLM: δεκτή με "?"
});

test('βαθμολογία', () => {
  const v = (key) => ({ valid: true, status: 'ok', key });
  const answers = {
    a: { animal: { submittedAt: 1000, validation: v('ΛΥΚΟΣ') }, plant: { submittedAt: 5000, validation: v('ΛΕΜΟΝΙ') } },
    b: { animal: { submittedAt: 3000, validation: v('ΛΥΚΟΣ') }, plant: { submittedAt: 2000, validation: { valid: false, status: 'invalid', key: 'Χ' } } },
  };
  // γύρος ξεκίνησε στο 0, διάρκεια 10.000 ms
  const { perPlayer } = scoreRound(['a', 'b'], ['animal', 'plant'], answers, 0, 10000);
  assert.deepStrictEqual(perPlayer.a.cats.animal, { base: 5, speed: 9, first: 3, points: 17, valid: true });
  assert.deepStrictEqual(perPlayer.b.cats.animal, { base: 5, speed: 7, first: 0, points: 12, valid: true });
  assert.strictEqual(perPlayer.a.cats.plant.points, 10 + 5 + 3);
  assert.strictEqual(perPlayer.b.cats.plant.points, 0);

  // Αμφισβήτηση: αντιστροφή
  answers.b.plant.flipped = true;
  const r2 = scoreRound(['a', 'b'], ['animal', 'plant'], answers, 0, 10000).perPlayer;
  assert.ok(r2.b.cats.plant.valid);
});
