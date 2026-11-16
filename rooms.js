// =====================================================================
// rooms.js — Κατάσταση δωματίων και ροή παιχνιδιού.
// Ο server είναι η ΜΟΝΑΔΙΚΗ πηγή αλήθειας για χρόνο, λέξεις και πόντους.
// Αποθήκευση in-memory (Map). Για πολλούς servers → Redis (βλ. README).
// =====================================================================
const crypto = require('crypto');
const config = require('./config');
const { validateWord } = require('./validator');
const { sanitizeDisplay } = require('./normalize');
const { scoreRound, isEffectivelyValid } = require('./scoring');

const R = config.ROOM;
const CATEGORY_IDS = config.CATEGORIES.map((c) => c.id);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // χωρίς O/0/I/1 για να μη μπερδεύονται

const now = () => Date.now();
const randomId = () => crypto.randomBytes(8).toString('hex');
const pick = (arr) => arr[crypto.randomInt(arr.length)];

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> room
    // Καθαρισμός ανενεργών δωματίων κάθε 5 λεπτά
    setInterval(() => this.sweep(), 5 * 60 * 1000).unref();
  }

  // ------------------------------------------------------------------
  // Δημιουργία / είσοδος / έξοδος
  // ------------------------------------------------------------------
  newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => pick([...CODE_CHARS])).join('');
    } while (this.rooms.has(code));
    return code;
  }

  /** Ελέγχει και "καθαρίζει" τις ρυθμίσεις που έστειλε ο δημιουργός. */
  cleanSettings(s = {}) {
    const clamp = (v, min, max, def) => (Number.isInteger(v) && v >= min && v <= max ? v : def);
    let categories = Array.isArray(s.categories) ? s.categories.filter((c) => CATEGORY_IDS.includes(c)) : [];
    categories = [...new Set(categories)];
    if (categories.length < 2) categories = config.CATEGORIES.filter((c) => c.default).map((c) => c.id);
    return {
      maxPlayers: clamp(s.maxPlayers, R.MIN_PLAYERS, R.MAX_PLAYERS, R.MAX_PLAYERS),
      rounds: R.ROUND_OPTIONS.includes(s.rounds) ? s.rounds : R.DEFAULT_ROUNDS,
      timeSec: R.TIME_OPTIONS.includes(s.timeSec) ? s.timeSec : R.DEFAULT_TIME,
      categories,
    };
  }

  cleanProfile(p = {}) {
    const nick = sanitizeDisplay(p.nick, R.NICK_MAX) || 'Παίκτης';
    const avatar = config.AVATARS.includes(p.avatar) ? p.avatar : pick(config.AVATARS);
    const color = config.COLORS.includes(p.color) ? p.color : pick(config.COLORS);
    return { nick, avatar, color };
  }

  createRoom(socket, payload) {
    const code = this.newCode();
    const room = {
      code,
      hostId: null,
      settings: this.cleanSettings(payload.settings),
      players: new Map(),
      phase: 'lobby',
      usedLetters: [],
      roundIndex: 0,
      round: null,
      history: [],        // αποτελέσματα κάθε γύρου (για συνολική βαθμολογία)
      lastActivity: now(),
      timers: {},
    };
    this.rooms.set(code, room);
    const player = this.addPlayer(room, socket, payload);
    room.hostId = player.id;
    this.broadcast(room);
    return { ok: true, code, playerId: player.id, token: player.token };
  }

  joinRoom(socket, payload) {
    const code = String(payload.code || '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Το δωμάτιο δεν βρέθηκε ή έληξε.' };

    // Επανασύνδεση με το ίδιο token (ίδιος παίκτης, ίδιος γύρος)
    if (payload.token) {
      const existing = [...room.players.values()].find((p) => p.token === payload.token);
      if (existing) {
        this.attachSocket(room, existing, socket);
        this.broadcast(room);
        this.sendPrivate(room, existing);
        return { ok: true, code, playerId: existing.id, token: existing.token, rejoined: true };
      }
    }

    if (room.phase !== 'lobby') return { ok: false, error: 'Το παιχνίδι έχει ήδη ξεκινήσει.' };
    if (room.players.size >= room.settings.maxPlayers) return { ok: false, error: 'Το δωμάτιο είναι γεμάτο.' };

    const player = this.addPlayer(room, socket, payload);
    this.broadcast(room);
    return { ok: true, code, playerId: player.id, token: player.token };
  }

  addPlayer(room, socket, payload) {
    const profile = this.cleanProfile(payload);
    const player = {
      id: randomId(),
      token: crypto.randomBytes(16).toString('hex'), // μυστικό για reconnect
      ...profile,
      ready: false,
      connected: true,
      socketId: null,
    };
    room.players.set(player.id, player);
    this.attachSocket(room, player, socket);
    return player;
  }

  attachSocket(room, player, socket) {
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    room.lastActivity = now();
    if (room.hostId === player.id) clearTimeout(room.timers.handover);
  }

  /** Αποσύνδεση (κλείσιμο tab, χάσιμο δικτύου) — ο παίκτης μπορεί να ξαναμπεί. */
  handleDisconnect(socket) {
    const ctx = this.ctx(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (player.socketId !== socket.id) return; // έχει ήδη συνδεθεί από αλλού
    player.connected = false;
    player.socketId = null;

    if (room.hostId === player.id) {
      clearTimeout(room.timers.handover);
      room.timers.handover = setTimeout(() => {
        if (!player.connected) this.transferHost(room);
      }, R.HOST_HANDOVER_MS);
    }
    this.broadcast(room);
    this.checkAllSubmitted(room);
  }

  /** Ρητή έξοδος από το δωμάτιο. */
  leave(socket) {
    const ctx = this.ctx(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    socket.leave(room.code);
    socket.data.roomCode = null;
    room.players.delete(player.id);
    if (room.round) delete room.round.answers[player.id];
    if (room.players.size === 0) return this.destroy(room);
    if (room.hostId === player.id) this.transferHost(room);
    this.broadcast(room);
    this.checkAllSubmitted(room);
  }

  transferHost(room) {
    const next = [...room.players.values()].find((p) => p.connected && p.id !== room.hostId)
      || [...room.players.values()].find((p) => p.id !== room.hostId);
    if (next) {
      room.hostId = next.id;
      next.ready = true;
      this.broadcast(room);
    }
  }

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------
  setReady(socket, ready) {
    const ctx = this.ctx(socket);
    if (!ctx || ctx.room.phase !== 'lobby') return;
    ctx.player.ready = Boolean(ready);
    this.broadcast(ctx.room);
  }

  updateSettings(socket, settings) {
    const ctx = this.ctx(socket);
    if (!ctx || ctx.room.phase !== 'lobby' || ctx.room.hostId !== ctx.player.id) return;
    const cleaned = this.cleanSettings(settings);
    cleaned.maxPlayers = Math.max(cleaned.maxPlayers, ctx.room.players.size);
    ctx.room.settings = cleaned;
    this.broadcast(ctx.room);
  }

  startGame(socket) {
    const ctx = this.ctx(socket);
    if (!ctx) return { ok: false, error: 'Δεν είσαι σε δωμάτιο.' };
    const { room, player } = ctx;
    if (room.hostId !== player.id) return { ok: false, error: 'Μόνο ο host ξεκινά.' };
    if (room.phase !== 'lobby') return { ok: false, error: 'Έχει ήδη ξεκινήσει.' };
    const connected = [...room.players.values()].filter((p) => p.connected);
    if (connected.length < R.MIN_PLAYERS) return { ok: false, error: `Χρειάζονται τουλάχιστον ${R.MIN_PLAYERS} παίκτες.` };
    const notReady = connected.filter((p) => p.id !== room.hostId && !p.ready);
    if (notReady.length) return { ok: false, error: `Δεν είναι έτοιμοι: ${notReady.map((p) => p.nick).join(', ')}` };

    room.usedLetters = [];
    room.roundIndex = 0;
    room.history = [];
    this.startRound(room);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Γύρος
  // ------------------------------------------------------------------
  startRound(room) {
    const available = config.LETTERS.filter((l) => !room.usedLetters.includes(l));
    const letter = pick(available.length ? available : config.LETTERS); // χωρίς επανάληψη
    room.usedLetters.push(letter);
    room.roundIndex += 1;

    const t = now();
    room.round = {
      number: room.roundIndex,
      letter,
      countdownEndsAt: t + R.COUNTDOWN_MS,
      startedAt: null,
      durationMs: room.settings.timeSec * 1000,
      endsAt: null,
      finishDeadline: null,
      answers: {},   // answers[pid][cat] = { word, submittedAt, promise, validation, flipped, votes:Set }
      results: null,
      ended: false,
    };
    room.phase = 'countdown';
    room.lastActivity = t;
    this.broadcast(room);

    clearTimeout(room.timers.round);
    room.timers.round = setTimeout(() => this.beginPlaying(room), R.COUNTDOWN_MS);
  }

  beginPlaying(room) {
    const round = room.round;
    round.startedAt = now();
    round.endsAt = round.startedAt + round.durationMs;
    room.phase = 'playing';
    this.scheduleEnd(room, round.endsAt);
    this.broadcast(room);
  }

  scheduleEnd(room, at) {
    clearTimeout(room.timers.round);
    room.timers.round = setTimeout(() => this.endRound(room), Math.max(0, at - now()) + R.SUBMIT_GRACE_MS);
  }

  /** Υποβολή λέξης σε μία κατηγορία. Ο χρόνος καταγράφεται με το ρολόι του server. */
  submitAnswer(socket, { category, word }) {
    const ctx = this.ctx(socket);
    if (!ctx) return { ok: false };
    const { room, player } = ctx;
    const round = room.round;
    const t = now();
    if (room.phase !== 'playing' || !round || round.ended) return { ok: false, error: 'Ο γύρος δεν είναι ενεργός.' };
    const deadline = Math.min(round.endsAt, round.finishDeadline || Infinity) + R.SUBMIT_GRACE_MS;
    if (t > deadline) return { ok: false, error: 'Τέλος χρόνου.' };
    if (!room.settings.categories.includes(category)) return { ok: false, error: 'Άγνωστη κατηγορία.' };

    const mine = (round.answers[player.id] ||= {});
    if (mine[category]) return { ok: false, error: 'Έχει ήδη κλειδώσει.' };

    const display = sanitizeDisplay(word, R.WORD_MAX);
    const entry = {
      word: display,
      submittedAt: Math.min(t, round.endsAt), // στο grace period → bonus 0, όχι αρνητικό
      validation: null,
      flipped: false,
      votes: new Set(),
    };
    // Η επαλήθευση ξεκινά ΑΜΕΣΩΣ στο παρασκήνιο — δεν καθυστερεί το παιχνίδι
    entry.promise = validateWord(display, round.letter, category)
      .then((v) => (entry.validation = v))
      .catch((err) => {
        console.error('[validate]', err);
        entry.validation = { valid: false, status: 'invalid', reason: 'Σφάλμα ελέγχου', source: 'rules', key: '' };
      });
    mine[category] = entry;
    room.lastActivity = t;

    // Ειδοποίηση σε όλους ΧΩΡΙΣ τη λέξη
    this.io.to(room.code).emit('round:progress', {
      playerId: player.id,
      nick: player.nick,
      category,
      label: config.CATEGORIES.find((c) => c.id === category).label,
    });

    const done = Object.keys(mine).length === room.settings.categories.length;
    if (done && config.ROOM.FINISH_COUNTDOWN_ENABLED && !round.finishDeadline) {
      const fd = t + R.FINISH_COUNTDOWN_SEC * 1000;
      if (fd < round.endsAt) {
        round.finishDeadline = fd;
        this.scheduleEnd(room, fd);
        this.io.to(room.code).emit('round:finishCountdown', { by: player.nick, deadline: fd, serverNow: t });
      }
    }
    this.broadcast(room);
    this.checkAllSubmitted(room);
    return { ok: true };
  }

  /** Τέλος γύρου όταν όλοι οι συνδεδεμένοι υπέβαλαν όλες τις κατηγορίες. */
  checkAllSubmitted(room) {
    if (room.phase !== 'playing' || !room.round) return;
    const need = room.settings.categories.length;
    const connected = [...room.players.values()].filter((p) => p.connected);
    if (!connected.length) return;
    const all = connected.every((p) => Object.keys(room.round.answers[p.id] || {}).length === need);
    if (all) this.endRound(room);
  }

  async endRound(room) {
    const round = room.round;
    if (!round || round.ended) return;
    round.ended = true;
    clearTimeout(room.timers.round);
    room.phase = 'validating';
    this.broadcast(room);

    // Κενές απαντήσεις για όσους δεν πρόλαβαν
    for (const pid of room.players.keys()) {
      const mine = (round.answers[pid] ||= {});
      for (const cat of room.settings.categories) {
        if (!mine[cat]) {
          mine[cat] = {
            word: '', submittedAt: round.endsAt, flipped: false, votes: new Set(),
            validation: { valid: false, status: 'empty', reason: 'Κενό', source: 'rules', key: '' },
            promise: Promise.resolve(),
          };
        }
      }
    }
    // Περιμένουμε όσους ελέγχους (π.χ. LLM) δεν έχουν τελειώσει — τρέχουν παράλληλα
    await Promise.all(
      Object.values(round.answers).flatMap((m) => Object.values(m).map((a) => a.promise))
    );
    if (!this.rooms.has(room.code)) return;
    this.computeResults(room);
    room.phase = 'results';
    room.lastActivity = now();
    this.broadcast(room);
  }

  computeResults(room) {
    const round = room.round;
    const pids = [...room.players.keys()];
    const { perPlayer } = scoreRound(pids, room.settings.categories, round.answers, round.startedAt, round.durationMs);
    round.results = perPlayer;
    room.history[round.number - 1] = { letter: round.letter, perPlayer };
  }

  totals(room) {
    const t = {};
    for (const pid of room.players.keys()) t[pid] = 0;
    for (const h of room.history) {
      if (!h) continue;
      for (const [pid, r] of Object.entries(h.perPlayer)) if (pid in t) t[pid] += r.total;
    }
    return t;
  }

  // ------------------------------------------------------------------
  // Αμφισβήτηση: πλειοψηφία των ΑΛΛΩΝ παικτών αντιστρέφει την απόφαση
  // ------------------------------------------------------------------
  vote(socket, { targetId, category }) {
    const ctx = this.ctx(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.phase !== 'results' || !room.round) return;
    if (targetId === player.id) return;
    const ans = room.round.answers[targetId] && room.round.answers[targetId][category];
    if (!ans || ans.validation.status === 'empty') return;

    if (ans.votes.has(player.id)) ans.votes.delete(player.id);
    else ans.votes.add(player.id);

    const others = [...room.players.keys()].filter((id) => id !== targetId).length;
    const needed = Math.floor(others / 2) + 1;
    // Μετράμε μόνο ψήφους παικτών που είναι ακόμη στο δωμάτιο
    const count = [...ans.votes].filter((id) => room.players.has(id)).length;
    ans.flipped = count >= needed;
    this.computeResults(room);
    this.broadcast(room);
  }

  nextRound(socket) {
    const ctx = this.ctx(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.hostId !== player.id || room.phase !== 'results') return;
    if (room.roundIndex >= room.settings.rounds) {
      room.phase = 'final';
      this.broadcast(room);
    } else {
      this.startRound(room);
    }
  }

  /** "Ξανά παιχνίδι": επιστροφή στο lobby με τους ίδιους παίκτες. */
  restart(socket) {
    const ctx = this.ctx(socket);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.hostId !== player.id || room.phase !== 'final') return;
    room.phase = 'lobby';
    room.round = null;
    room.history = [];
    room.roundIndex = 0;
    for (const p of room.players.values()) p.ready = p.id === room.hostId;
    this.broadcast(room);
  }

  // ------------------------------------------------------------------
  // Αποστολή κατάστασης
  // ------------------------------------------------------------------
  /** Δημόσια κατάσταση — ΠΟΤΕ δεν περιέχει λέξεις άλλων κατά τη διάρκεια του γύρου. */
  publicState(room) {
    const totals = this.totals(room);
    const round = room.round;
    const showResults = room.phase === 'results' || room.phase === 'final';

    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      nick: p.nick,
      avatar: p.avatar,
      color: p.color,
      ready: p.ready,
      connected: p.connected,
      score: totals[p.id] || 0,
      progress: round && round.answers[p.id] ? Object.keys(round.answers[p.id]) : [],
    }));

    let results = null;
    if (showResults && round && round.results) {
      results = {
        letter: round.letter,
        rows: players.map((p) => {
          const ans = round.answers[p.id] || {};
          const r = round.results[p.id] || { total: 0, cats: {} };
          const cats = {};
          for (const cat of room.settings.categories) {
            const a = ans[cat];
            const s = r.cats[cat] || {};
            cats[cat] = a ? {
              word: a.word,
              status: a.validation.status,
              reason: a.validation.reason,
              source: a.validation.source,
              valid: isEffectivelyValid(a),
              flipped: a.flipped,
              votes: [...a.votes],
              base: s.base || 0, speed: s.speed || 0, first: s.first || 0, points: s.points || 0,
            } : null;
          }
          return { playerId: p.id, total: r.total, cats };
        }),
      };
    }

    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      settings: room.settings,
      categories: room.settings.categories.map((id) => {
        const c = config.CATEGORIES.find((x) => x.id === id);
        return { id, label: c.label };
      }),
      players,
      round: round ? {
        number: round.number,
        total: room.settings.rounds,
        letter: room.phase === 'countdown' ? null : round.letter, // το γράμμα αποκαλύπτεται μετά το 3-2-1
        countdownEndsAt: round.countdownEndsAt,
        startedAt: round.startedAt,
        endsAt: round.endsAt,
        finishDeadline: round.finishDeadline,
        durationMs: round.durationMs,
      } : null,
      results,
      serverNow: now(),
    };
  }

  broadcast(room) {
    room.lastActivity = now();
    this.io.to(room.code).emit('room:state', this.publicState(room));
  }

  /** Μετά από reconnect: στέλνουμε στον παίκτη τις δικές του κλειδωμένες λέξεις. */
  sendPrivate(room, player) {
    if (!room.round || !player.socketId) return;
    const mine = room.round.answers[player.id] || {};
    const words = Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, v.word]));
    this.io.to(player.socketId).emit('you:answers', { round: room.round.number, words });
  }

  // ------------------------------------------------------------------
  // Βοηθητικά
  // ------------------------------------------------------------------
  ctx(socket) {
    const room = this.rooms.get(socket.data.roomCode);
    if (!room) return null;
    const player = room.players.get(socket.data.playerId);
    if (!player) return null;
    return { room, player };
  }

  destroy(room) {
    for (const t of Object.values(room.timers)) clearTimeout(t);
    this.rooms.delete(room.code);
  }

  /** Λήξη δωματίων χωρίς δραστηριότητα για 2 ώρες. */
  sweep() {
    const limit = now() - R.INACTIVE_ROOM_MS;
    for (const room of this.rooms.values()) {
      if (room.lastActivity < limit) {
        this.io.to(room.code).emit('room:expired');
        this.destroy(room);
      }
    }
  }
}

module.exports = { RoomManager };
