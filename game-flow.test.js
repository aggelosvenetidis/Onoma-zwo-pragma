// Προσομοίωση ολόκληρου παιχνιδιού με ψεύτικα sockets (χωρίς δίκτυο).
const test = require('node:test');
const assert = require('node:assert');
delete process.env.ANTHROPIC_API_KEY;

const config = require('./config');
config.ROOM.COUNTDOWN_MS = 30;       // γρήγορο τεστ
config.ROOM.SUBMIT_GRACE_MS = 10;
const { RoomManager } = require('./rooms');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeIo() {
  const sent = [];
  return { sent, to: () => ({ emit: (ev, data) => sent.push({ ev, data }) }) };
}
let n = 0;
const fakeSocket = () => ({ id: `s${++n}`, data: {}, join() {}, leave() {} });
const lastState = (io) => [...io.sent].reverse().find((m) => m.ev === 'room:state').data;

test('πλήρης ροή: δημιουργία → γύρος → αμφισβήτηση → τέλος', async () => {
  const io = fakeIo();
  const rm = new RoomManager(io);
  const host = fakeSocket(), guest = fakeSocket();

  const c = rm.createRoom(host, { nick: 'Άγγελος<script>', settings: { rounds: 5, timeSec: 60, categories: ['animal', 'plant'] } });
  assert.ok(c.ok);
  assert.strictEqual(lastState(io).players[0].nick, 'Άγγελοςscript'); // sanitization

  const j = rm.joinRoom(guest, { code: c.code, nick: 'Μαρία' });
  assert.ok(j.ok);
  assert.strictEqual(rm.startGame(guest).ok, false);               // μόνο ο host
  assert.strictEqual(rm.startGame(host).ok, false);                // η Μαρία δεν είναι έτοιμη
  rm.setReady(guest, true);
  assert.ok(rm.startGame(host).ok);
  assert.strictEqual(lastState(io).phase, 'countdown');
  assert.strictEqual(lastState(io).round.letter, null);            // κρυφό στο 3-2-1

  await sleep(60);
  const st = lastState(io);
  assert.strictEqual(st.phase, 'playing');
  const L = st.round.letter;

  // Λέξεις που ξεκινούν από το γράμμα (ή απλώς άκυρες — μας ενδιαφέρει η ροή)
  rm.submitAnswer(host, { category: 'animal', word: `${L}ααα` });
  assert.strictEqual(rm.submitAnswer(host, { category: 'animal', word: 'x' }).ok, false); // κλειδωμένο
  // Κατά τον γύρο η κατάσταση ΔΕΝ περιέχει λέξεις
  assert.ok(!JSON.stringify(lastState(io)).includes(`${L}ααα`));
  assert.ok(io.sent.some((m) => m.ev === 'round:progress'));

  rm.submitAnswer(host, { category: 'plant', word: 'Λεμόνι' });
  assert.ok(io.sent.some((m) => m.ev === 'round:finishCountdown'));
  rm.submitAnswer(guest, { category: 'animal', word: 'Λύκος' });
  rm.submitAnswer(guest, { category: 'plant', word: 'λεμόνια' });

  await sleep(30);
  const res = lastState(io);
  assert.strictEqual(res.phase, 'results');
  const hostRow = res.results.rows.find((r) => r.playerId === c.playerId);
  const guestRow = res.results.rows.find((r) => r.playerId === j.playerId);
  assert.strictEqual(hostRow.cats.animal.valid, false); // "Χααα" → τρία ίδια γράμματα

  // Αμφισβήτηση της άκυρης λέξης του host από τη Μαρία → αντιστροφή (1 από 1 "άλλο")
  rm.vote(guest, { targetId: c.playerId, category: 'animal' });
  const afterVote = lastState(io).results.rows.find((r) => r.playerId === c.playerId);
  assert.strictEqual(afterVote.cats.animal.valid, true);
  assert.ok(afterVote.cats.animal.flipped);
  assert.ok(afterVote.total > hostRow.total);
  rm.vote(guest, { targetId: c.playerId, category: 'animal' }); // ξανά = ακύρωση ψήφου
  assert.strictEqual(lastState(io).results.rows.find((r) => r.playerId === c.playerId).cats.animal.valid, false);

  // Αν το γράμμα είναι Λ, "λεμόνια" & "Λεμόνι" = ίδια λέξη → 5 βάση
  if (L === 'Λ') assert.strictEqual(guestRow.cats.plant.base, 5);

  // Επανασύνδεση με token
  rm.handleDisconnect(guest);
  assert.strictEqual(lastState(io).players.find((p) => p.id === j.playerId).connected, false);
  const g2 = fakeSocket();
  const re = rm.joinRoom(g2, { code: c.code, token: j.token });
  assert.ok(re.rejoined && re.playerId === j.playerId);

  // Ξένος δεν μπαίνει μετά την έναρξη
  assert.strictEqual(rm.joinRoom(fakeSocket(), { code: c.code, nick: 'Χ' }).ok, false);

  // Οι υπόλοιποι γύροι μέχρι το τέλος
  for (let i = 2; i <= 5; i++) {
    rm.nextRound(host);
    await sleep(60);
    for (const s of [host, g2]) for (const cat of ['animal', 'plant']) rm.submitAnswer(s, { category: cat, word: '' });
    await sleep(30);
    assert.strictEqual(lastState(io).phase, 'results');
  }
  const letters = new Set();
  rm.nextRound(host);
  assert.strictEqual(lastState(io).phase, 'final');
  for (const room of rm.rooms.values()) room.usedLetters.forEach((l) => letters.add(l));
  assert.strictEqual(letters.size, 5); // χωρίς επανάληψη γράμματος

  // Αποχώρηση host → ο ρόλος περνά
  rm.leave(host);
  assert.strictEqual(lastState(io).hostId, j.playerId);
  rm.restart(g2);
  assert.strictEqual(lastState(io).phase, 'lobby');
});
