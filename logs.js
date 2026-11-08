/**
 * The Poker Way — logs.js
 * Full application logging buffer + report builder.
 * Loaded from index.html before the main session script.
 * Exposes window.LogBuf with public API.
 * Only depends on browser APIs and optionally window.Bots / window.VipBots / window.Engine.
 */
(function() {
  'use strict';

  // ========================================================================
  // CONFIG
  // ========================================================================

  const CONFIG = {
    detailedHandsLimit: 10,
    archiveHandsLimit: 100,
    detailedEventsLimit: 5000,
    botDecisionTimeWarnMs: 4000,
    uiStaleWarnMs: 800
  };

  // ========================================================================
  // STATE
  // ========================================================================

  const state = {
    sessionStartTs: Date.now(),
    detailedEvents: [],       // [{ts, type, handId, stepId, mode, payload}]
    archivedHands: [],        // [{handNumber, finalStreet, pot, winner, payoutsCount, errors, ok}]
    handEvents: new Map(),    // handId -> [{...events}]
    currentHandId: 0,
    currentStepId: 0,
    mode: 'live',             // live | history | replay
    errorsCount: 0,
    warningsCount: 0,
    lastUiUpdateTs: 0,
    pendingTimers: new Map(), // id -> {kind, startedAt, payload}
    timerSeq: 0,
    lastBotDecision: {},
    version: '1.0'
  };

  function resetAll() {
    state.detailedEvents = [];
    state.archivedHands = [];
    state.handEvents.clear();
    state.currentHandId = 0;
    state.currentStepId = 0;
    state.mode = 'live';
    state.errorsCount = 0;
    state.warningsCount = 0;
    state.lastUiUpdateTs = 0;
    state.pendingTimers.clear();
    state.timerSeq = 0;
    state.lastBotDecision = {};
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

  function ts() { return Date.now(); }

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (Math.round(n * 100) / 100).toString();
  }

  function cardStr(c) {
    if (!c) return '??';
    const rank = c.rank === 'T' ? '10' : c.rank;
    const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[c.suit] || '?';
    return rank + suit;
  }

  function cardsStr(cards) {
    if (!cards || cards.length === 0) return '—';
    return cards.map(cardStr).join(' ');
  }

  function cardPs(c) {
    if (!c) return '??';
    const r = { 'T':'T' }[c.rank] || c.rank;
    return r + (c.suit || '?');
  }

  function cardsPs(cards) {
    if (!cards || cards.length === 0) return '';
    return cards.map(cardPs).join(' ');
  }

  function streetRu(s) {
    return ({ preflop:'preflop', flop:'flop', turn:'turn', river:'river' })[s] || s;
  }

  function actionRu(a) {
    return ({
      fold:'fold', check:'check', call:'call', raise:'raise', bet:'bet',
      allin:'all-in', sb:'SB', bb:'BB'
    })[a] || a;
  }

  function psNameFor(p) {
    if (!p) return 'Player';
    if (p.isHero) return 'Hero';
    const n = (typeof p.seatIndex === 'number') ? (p.seatIndex + 1) : 1;
    return 'Player_' + n;
  }

  function psHandName(sc) {
    if (!sc) return '';
    const cat = sc.category;
    const ranks = sc.ranks || [];
    const r = (v) => {
      if (v === 10) return 'Ten';
      if (v === 11) return 'Jack';
      if (v === 12) return 'Queen';
      if (v === 13) return 'King';
      if (v === 14) return 'Ace';
      return String(v);
    };
    const rp = (v) => {
      if (v === 10) return 'Tens';
      if (v === 11) return 'Jacks';
      if (v === 12) return 'Queens';
      if (v === 13) return 'Kings';
      if (v === 14) return 'Aces';
      return String(v) + 's';
    };
    switch (cat) {
      case 0: return 'High Card';
      case 1: return 'One Pair, ' + rp(ranks[0] || 0);
      case 2: return 'Two Pair, ' + rp(ranks[0] || 0) + ' and ' + rp(ranks[1] || 0);
      case 3: return 'Three of a Kind, ' + rp(ranks[0] || 0);
      case 4: return 'Straight, ' + r(ranks[0] || 0) + ' High';
      case 5: return 'Flush, ' + r(ranks[0] || 0) + ' High';
      case 6: return 'Full House, ' + rp(ranks[0] || 0) + ' full of ' + rp(ranks[1] || 0);
      case 7: return 'Four of a Kind, ' + rp(ranks[0] || 0);
      case 8: return 'Straight Flush, ' + r(ranks[0] || 0) + ' High';
      case 9: return 'Royal Flush';
      default: return '';
    }
  }

  function fmtDateEt(d) {
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ET';
  }

  function classifyError(payload) {
    if (!payload) return 'ERR';
    if (payload.kind === 'error' || payload.kind === 'unhandledrejection' || payload.kind === 'bot-decision-error') return 'ERR';
    return 'WARN';
  }

  // ========================================================================
  // BUFFER — RECORD EVENTS
  // ========================================================================

  function record(type, payload) {
    try {
      const ev = {
        ts: ts(),
        type: type,
        handId: state.currentHandId || null,
        stepId: state.currentStepId || null,
        mode: state.mode,
        payload: payload || {}
      };
      state.detailedEvents.push(ev);
      if (type === 'error') {
        state.errorsCount++;
        window.__ppErrors = window.__ppErrors || [];
        if (payload && payload.message) {
          window.__ppErrors.push(payload);
        }
      } else if (type === 'warn') {
        state.warningsCount++;
      }
      if (state.handEvents) {
        if (!state.handEvents.has(state.currentHandId)) state.handEvents.set(state.currentHandId, []);
        state.handEvents.get(state.currentHandId).push(ev);
      }
      if (type === 'bot_decision' && payload && payload.botCtx) {
        state.lastBotDecision[payload.botCtx.botType || '?'] = payload.botCtx;
      }
      if (type === 'ui_update') {
        state.lastUiUpdateTs = ev.ts;
      }
      // FIFO trim
      if (state.detailedEvents.length > CONFIG.detailedEventsLimit) {
        state.detailedEvents.shift();
      }
    } catch (e) {}
  }

  function setHandContext(handId, mode) {
    try {
      state.currentHandId = handId || 0;
      state.currentStepId = 0;
      if (mode) state.mode = mode;
      if (state.currentHandId && !state.handEvents.has(state.currentHandId)) {
        state.handEvents.set(state.currentHandId, []);
      }
    } catch (e) {}
  }

  function nextStep() {
    state.currentStepId++;
    return state.currentStepId;
  }

  function archiveHand(summary) {
    try {
      if (!summary) return;
      state.archivedHands.push(summary);
      if (state.archivedHands.length > CONFIG.archiveHandsLimit) state.archivedHands.shift();
      // Trim detailed hand events beyond detailedHandsLimit
      const handIds = Array.from(state.handEvents.keys()).sort((a, b) => a - b);
      while (handIds.length > CONFIG.detailedHandsLimit) {
        const oldId = handIds.shift();
        state.handEvents.delete(oldId);
      }
    } catch (e) {}
  }

  function setMode(mode) { state.mode = mode || 'live'; }

  // ========================================================================
  // TIMERS TRACKING
  // ========================================================================

  function startTimer(kind, payload) {
    const id = ++state.timerSeq;
    state.pendingTimers.set(id, { kind, startedAt: ts(), payload });
    return id;
  }

  function endTimer(id, reason) {
    if (!state.pendingTimers.has(id)) return;
    const rec = state.pendingTimers.get(id);
    state.pendingTimers.delete(id);
    const elapsed = ts() - rec.startedAt;
    if (elapsed > CONFIG.botDecisionTimeWarnMs && rec.kind === 'bot') {
      record('warn', { kind: 'slow_timer', timerKind: rec.kind, elapsed, payload: rec.payload });
    }
  }

  // ========================================================================
  // CHECKS
  // ========================================================================

  function checkMoneyInvariants(snap) {
    const issues = [];
    if (!snap || !snap.players) return issues;
    let committedTotal = 0;
    for (const p of snap.players) committedTotal += (p.committedTotal || 0);
    if (snap.showdownResults && !snap.showdownResults.uncontested) {
      const payoutsSum = Object.values(snap.showdownResults.payouts || {}).reduce((a,b) => a+b, 0);
      if (Math.abs(payoutsSum - committedTotal) > 0.5) {
        issues.push('payouts(' + payoutsSum + ') != committed(' + committedTotal + ')');
      }
    }
    if (snap.pot && committedTotal > 0 && Math.abs(snap.pot - committedTotal) > 1) {
      issues.push('pot(' + snap.pot + ') != committed(' + committedTotal + ')');
    }
    return issues;
  }

  function checkCardDuplicates(snap) {
    const issues = [];
    if (!snap) return issues;
    const seen = new Map();
    const allCards = [];
    for (const p of (snap.players || [])) {
      for (const c of (p.holeCards || [])) {
        const key = c.rank + c.suit;
        allCards.push({ key, owner: p.name || p.id });
      }
    }
    for (const c of (snap.board || [])) {
      const key = c.rank + c.suit;
      allCards.push({ key, owner: 'board' });
    }
    for (const c of allCards) {
      if (seen.has(c.key)) {
        issues.push('duplicate card ' + c.key + ' owned by ' + seen.get(c.key) + ' and ' + c.owner);
      } else {
        seen.set(c.key, c.owner);
      }
    }
    return issues;
  }

  function checkBotMismatch(snap) {
    const issues = [];
    if (!snap || !snap.actionLog) return issues;
    for (const a of snap.actionLog) {
      if (!a.botCtx) continue;
      const c = a.botCtx;
      if (c.botResultType && c.appliedType && c.botResultType !== c.appliedType) {
        issues.push('bot ' + (c.botType || '?') + ' wanted ' + c.botResultType + ' but engine applied ' + c.appliedType);
      }
    }
    return issues;
  }

  function checkUIStaleness() {
    const issues = [];
    if (state.mode !== 'live') return issues;
    if (state.lastUiUpdateTs === 0) return issues;
    const elapsed = ts() - state.lastUiUpdateTs;
    if (elapsed > CONFIG.uiStaleWarnMs * 10) {
      issues.push('UI not updated for ' + elapsed + 'ms');
    }
    return issues;
  }

  function runChecks(snap) {
    const results = {
      money: checkMoneyInvariants(snap),
      cards: checkCardDuplicates(snap),
      botMismatch: checkBotMismatch(snap),
      uiStale: checkUIStaleness()
    };
    const total = results.money.length + results.cards.length + results.botMismatch.length + results.uiStale.length;
    return { results, total };
  }

  // ========================================================================
  // REPORT BUILDERS
  // ========================================================================

  function buildGlossary() {
    const g = [];
    g.push('GLOSSARY:');
    g.push('  decisionBranch   — какую ветку отработал бот (rfi / facing_limp / facing_raise / facing_3bet / ...)');
    g.push('  contextType      — тип ситуации по мнению движка');
    g.push('  strength         — сила руки после реализации (0..1)');
    g.push('  equityRealized   — сила × equityRealization');
    g.push('  threshold        — порог, с которым сравнивалась сила');
    g.push('  statUsed         — какая метрика статистики использована (или null)');
    g.push('  statConfidence   — уверенность в статистике (0..1)');
    g.push('  statEffect       — на сколько статистика сдвинула порог');
    g.push('  bubbleFactor     — давление ICM');
    g.push('  icmPressure      — none / bubble / final_table');
    g.push('  blockerScore     — оценка блокеров (A5s = +0.15)');
    g.push('  potOdds          — toCall / (pot + toCall)');
    g.push('  decisionTimeMs   — сколько миллисекунд бот думал');
    g.push('  mismatch         — botResultType != appliedType');
    g.push('');
    return g;
  }

  function buildKnownLimitations() {
    const L = [];
    L.push('KNOWN LIMITATIONS:');
    L.push('  - Postflop EV is basic, not solver-level.');
    L.push('  - MDF in multiway is simplified.');
    L.push('  - Nash push tables are approximations, not exact 38k dataset.');
    L.push('  - Statistics confidence is often <0.45 in a single session; bots play GTO-first by design.');
    L.push('  - Independent verification of detectContext / EV / GTO is not implemented in this version.');
    L.push('');
    return L;
  }

  function buildHandLog(snap, meta) {
    const L = [];
    const isHistoryView = !!(meta && meta.viewingPast);
    const isReplay = !!(meta && meta.replayActive);
    const bl = getBotsInfo();
    const handMode = isHistoryView ? 'HISTORY (hand finished, all cards revealed)' : (isReplay ? 'REPLAY' : 'LIVE');
    L.push('=== THE POKER WAY — HAND LOG ===');
    L.push('*** MODE: ' + handMode + ' ***');
    if (isHistoryView) {
      L.push('Note: cards and board shown here are the FINAL state of a finished hand.');
    }
    L.push('Captured: ' + new Date().toLocaleString('en-US'));
    L.push('Format version: v7-deeplog');
    L.push('Current bots: ' + bl.current + ' | pending: ' + bl.pending);
    L.push('PRO available: ' + (bl.proAvailable ? 'yes' : 'no') + ' | version ' + bl.version);
    L.push('Hand #' + snap.handNumber +
      ' | level ' + snap.levelIndex +
      ' | blinds SB ' + snap.blinds.sb + ' / BB ' + snap.blinds.bb + (snap.blinds.ante ? ' / ante ' + snap.blinds.ante : '') +
      ' | button ' + snap.buttonIndex);
    L.push('Final street: ' + (snap.finalStreet || '—') + ' | hand complete: ' + (snap.handOver ? 'yes' : 'no'));
    L.push('');
    L.push(...buildGlossary());

    L.push('--- TABLE COMPOSITION ---');
    for (const p of snap.players) {
      L.push('Seat ' + p.seatIndex + ' | ' + p.name + ' | ' +
        (p.isHero ? 'HERO' : 'bot ' + (p.botType || '—') + ' / ' + (p.botClass || '—')) +
        ' | pos ' + (p.position || '—') +
        ' | stack ' + p.stack +
        (p.eliminated ? ' | ELIMINATED' : '') +
        (p.inHand ? ' | in hand' : '') +
        ' | cards ' + cardsStr(p.holeCards));
    }
    L.push('');

    L.push('--- BOARD ---');
    if (snap.board.length === 0) L.push('Board empty (no flop)');
    else {
      L.push('Final board: ' + cardsStr(snap.board));
      const parts = [];
      if (snap.board.length >= 3) parts.push('flop: ' + cardsStr(snap.board.slice(0,3)));
      if (snap.board.length >= 4) parts.push('turn: ' + cardStr(snap.board[3]));
      if (snap.board.length >= 5) parts.push('river: ' + cardStr(snap.board[4]));
      L.push(parts.join(' | '));
    }
    L.push('');

    L.push('--- ACTION LOG ---');
    const log = snap.actionLog || [];
    if (log.length === 0) {
      L.push('(no actions)');
    } else {
      let lastStreet = null;
      let step = 0;
      for (const a of log) {
        step++;
        if (a.street !== lastStreet) {
          lastStreet = a.street;
          L.push('');
          L.push('>> Street: ' + streetRu(a.street));
        }
        const p = snap.players.find(pl => pl.seatIndex === a.playerIndex);
        const who = p ? (p.name + ' [' + (p.position || '?') + ']') : ('seat ' + a.playerIndex);
        L.push('  #' + step + ' ' + who + ' → ' + actionRu(a.actionType) +
          (a.amount ? ' ' + a.amount : '') +
          ' | pot after: ' + (a.potAfter !== undefined ? a.potAfter : '—'));

        if (a.botCtx) {
          const c = a.botCtx;
          L.push('       [BOT ' + (c.botType || '?') + ']');
          L.push('       branch=' + (c.diagnostics && (c.diagnostics.decisionBranch || c.diagnostics.contextType) || c.contextType || '—') +
            ' | ctx=' + (c.contextType || '—') +
            ' | raiserPos=' + (c.raiserPosition || '—') +
            ' | limpers=' + (c.numLimpers !== undefined ? c.numLimpers : '—') +
            ' | isRealRaise=' + (c.isRealRaise ? 'y' : 'n'));
          L.push('       pos=' + (c.position || '—') +
            ' | stackBB=' + fmtNum(c.stackBB) +
            ' | toCall=' + fmtNum(c.toCall) +
            ' | currentBet=' + fmtNum(c.currentBet) +
            ' | pot=' + fmtNum(c.pot) +
            ' | myStack=' + fmtNum(c.myStack) +
            ' | invested=' + fmtNum(c.committedThisStreet) + '/' + fmtNum(c.committedTotal));
          L.push('       cards=' + cardsStr(c.holeCards) + ' | board=' + cardsStr(c.board));
          if (c.diagnostics) {
            const d = c.diagnostics;
            L.push('       strength=' + (d.strength !== undefined ? fmtNum(d.strength) : '—') +
              ' | threshold=' + (d.threshold !== undefined ? String(d.threshold) : '—') +
              ' | equityRealized=' + (d.equityRealized !== undefined ? fmtNum(d.equityRealized) : '—') +
              ' | equityVsRange=' + (d.equityVsRange !== undefined ? fmtNum(d.equityVsRange) : '—'));
            L.push('       potOdds=' + (d.potOdds !== undefined ? fmtNum(d.potOdds) : '—') +
              ' | foldEquity=' + (d.foldEquity !== undefined ? fmtNum(d.foldEquity) : '—') +
              ' | spr=' + (d.spr !== undefined ? fmtNum(d.spr) : '—'));
            L.push('       statUsed=' + (d.statUsed || d.statKey || '—') +
              ' | statConfidence=' + (d.statConfidence !== undefined ? fmtNum(d.statConfidence) : '—') +
              ' | statEffect=' + (d.statEffect !== undefined ? fmtNum(d.statEffect) : '—') +
              ' | sample=' + (d.statSampleSize !== undefined ? d.statSampleSize : '—'));
            L.push('       bubbleFactor=' + (d.bubbleFactor !== undefined ? fmtNum(d.bubbleFactor) : '—') +
              ' | icmPressure=' + (d.icmPressure || '—') +
              ' | payoutStructure=' + (d.payoutStructure || '—') +
              ' | opponentType=' + (d.opponentType || '—'));
            L.push('       blockerScore=' + (d.blockerScore !== undefined ? fmtNum(d.blockerScore) : '—') +
              ' | blockerReason=' + (d.blockerReason || '—') +
              ' | exploitActive=' + (d.exploitActive ? 'yes' : 'no'));
            L.push('       frequency=' + (d.frequency !== undefined ? fmtNum(d.frequency) : '—') +
              ' | randomRoll=' + (d.randomRoll !== undefined ? fmtNum(d.randomRoll) : '—') +
              ' | sizingReason=' + (d.sizingReason || '—'));
            L.push('       limpingReason=' + (d.limpingReason || '—') +
              ' | metaLevel=' + (d.metaLevel !== undefined ? d.metaLevel : '—') +
              ' | adaptationDetected=' + (d.adaptationDetected ? 'yes' : 'no'));
            if (d.evFold !== undefined || d.evCall !== undefined || d.evRaise !== undefined) {
              L.push('       EV: fold=' + fmtNum(d.evFold) + ' | call=' + fmtNum(d.evCall) + ' | raise=' + fmtNum(d.evRaise));
            }
            if (d.reason) L.push('       reason: ' + d.reason);
            if (d.error) L.push('       ERROR: ' + d.error);
          }
          if (c.decisionTimeMs !== undefined) {
            L.push('       decisionTimeMs=' + c.decisionTimeMs +
              ' | botResultType=' + (c.botResultType || '—') +
              ' | appliedType=' + (c.appliedType || '—') +
              ' | mismatch=' + (c.mismatch ? 'YES' : 'no'));
          }
        }

        if (a.heroCtx) {
          const h = a.heroCtx;
          L.push('       [HERO]');
          L.push('       action=' + actionRu(h.action) + (h.amount ? ' ' + h.amount : '') +
            ' | pot ' + fmtNum(h.potBefore) + '→' + fmtNum(h.potAfter) +
            ' | stack ' + fmtNum(h.stackBefore) + '→' + fmtNum(h.stackAfter));
          if (h.quickOptions && h.quickOptions.length) {
            L.push('       quick options: ' + h.quickOptions.join(', '));
          }
        }
      }
    }
    L.push('');

    L.push('--- HAND RESULTS ---');
    if (!snap.showdownResults) {
      L.push('Results unavailable');
    } else {
      const sr = snap.showdownResults;
      if (sr.uncontested) L.push('No showdown (all folded)');
      for (const [id, sc] of Object.entries(sr.scores || {})) {
        const p = snap.players.find(pl => String(pl.id) === String(id));
        if (!p) continue;
        if (!sc) { L.push('  ' + p.name + ': did not reach showdown'); continue; }
        L.push('  ' + p.name + ' [' + (p.position || '?') + '] cards ' + cardsStr(p.holeCards) +
          ' → ' + sc.name + ' (cat ' + sc.category + ', ranks ' + (sc.ranks || []).join(',') + ')');
      }
      for (let i = 0; i < (sr.pots || []).length; i++) {
        const pot = sr.pots[i];
        L.push('  pot #' + (i + 1) + ': ' + pot.amount + ' | winners: ' + (pot.winners || []).join(', '));
      }
      for (const [id, amount] of Object.entries(sr.payouts || {})) {
        const p = snap.players.find(pl => String(pl.id) === String(id));
        if (!p) continue;
        const committed = p.committedTotal || 0;
        L.push('  payout: ' + p.name + ' received ' + amount + ' | invested ' + committed + ' | net ' + (amount - committed));
      }
    }
    L.push('');

    L.push('--- CHECKS ---');
    const chk = runChecks(snap);
    if (chk.total === 0) {
      L.push('  All checks OK');
    } else {
      L.push('  Total issues: ' + chk.total);
      for (const k of Object.keys(chk.results)) {
        const list = chk.results[k];
        if (!list.length) continue;
        for (const issue of list) L.push('  [' + k + '] ' + issue);
      }
    }
    L.push('');

    L.push('--- PER-PLAYER SUMMARY ---');
    for (const p of snap.players) {
      const acts = (snap.actionLog || []).filter(a => a.playerIndex === p.seatIndex);
      const folds = acts.filter(a => a.actionType === 'fold').length;
      const calls = acts.filter(a => a.actionType === 'call').length;
      const raises = acts.filter(a => a.actionType === 'raise' || a.actionType === 'bet').length;
      const checks = acts.filter(a => a.actionType === 'check').length;
      const allins = acts.filter(a => a.actionType === 'allin').length;
      L.push('  ' + p.name + ' [' + (p.position || '—') + ']: ' +
        'actions=' + acts.length +
        ' (fold=' + folds + ' call=' + calls + ' raise=' + raises + ' check=' + checks + ' allin=' + allins + ')' +
        ' | invested=' + (p.committedTotal || 0) +
        ' | finalStack=' + p.stack);
    }
    L.push('');

    L.push('--- VISUALS ---');
    const alive = snap.players.filter(p => !p.eliminated);
    L.push('Rank/ITM: ' + (alive.length > 0 ? 'active ' + alive.length + ' of ' + snap.players.length + ', ITM 3' : '—'));
    L.push('Pot line: Pot: ' + (snap.pot || 0));
    L.push('Blinds line: Blinds: ' + snap.blinds.sb + '/' + snap.blinds.bb +
      (snap.blinds.ante > 0 ? ' (' + snap.blinds.ante + ')' : ''));
    L.push('Board on screen: ' + cardsStr(snap.board));
    L.push('');
    L.push(...buildKnownLimitations());
    L.push('=== END OF HAND LOG ===');
    return L.join('\n');
  }

  function getBotsInfo() {
    const current = window.__ppCurrentBotsLevel || 'vip';
    const pending = window.__ppPendingBotsLevel || 'none';
    const b = window.Bots;
    const proAvailable = !!(b && b.__source === 'bots.js' && window.__botsJsLoaded === true);
    return {
      current,
      pending,
      proAvailable,
      version: (b && b.__version) || '—',
      source: (b && b.__source) || '—'
    };
  }

  function buildSummaryHeader(appMeta) {
    const L = [];
    const now = new Date();
    const bl = getBotsInfo();
    L.push('=== THE POKER WAY — FULL APP LOG ===');
    L.push('*** MODE: ' + (state.mode === 'live' ? 'LIVE GAME' : state.mode.toUpperCase()) + ' ***');
    L.push('Captured: ' + now.toLocaleString('en-US'));
    L.push('Format version: v7-deeplog');
    L.push('logs.js version: ' + state.version);
    L.push('Current bots: ' + bl.current + ' | pending: ' + bl.pending);
    L.push('PRO available: ' + (bl.proAvailable ? 'yes' : 'no') + ' | version ' + bl.version + ' | source ' + bl.source);
    L.push('Session started: ' + new Date(state.sessionStartTs).toLocaleString('en-US'));
    L.push('Uptime: ' + Math.round((Date.now() - state.sessionStartTs) / 1000) + ' sec');
    L.push('Errors recorded: ' + state.errorsCount);
    L.push('Warnings recorded: ' + state.warningsCount);
    L.push('Detailed events in buffer: ' + state.detailedEvents.length);
    L.push('Hands in detailed buffer: ' + state.handEvents.size + ' | archived summary: ' + state.archivedHands.length);
    L.push('');
    return L;
  }

  function buildEnvBlock() {
    const L = [];
    L.push('--- ENVIRONMENT ---');
    L.push('UA: ' + (navigator.userAgent || '—'));
    L.push('Platform: ' + (navigator.platform || '—'));
    L.push('Language: ' + (navigator.language || '—'));
    L.push('Languages: ' + ((navigator.languages && navigator.languages.join(', ')) || '—'));
    L.push('URL: ' + (location && location.href ? location.href : '—'));
    L.push('Protocol: ' + (location && location.protocol ? location.protocol : '—'));
    L.push('Secure context: ' + (window.isSecureContext ? 'yes' : 'no'));
    L.push('Screen: ' + (screen.width || 0) + 'x' + (screen.height || 0));
    L.push('Window: ' + window.innerWidth + 'x' + window.innerHeight);
    L.push('DPR: ' + (window.devicePixelRatio || 1));
    L.push('Visual viewport: ' + (window.visualViewport ? (Math.round(window.visualViewport.width) + 'x' + Math.round(window.visualViewport.height) + ' @scale ' + window.visualViewport.scale) : '—'));
    L.push('Orientation: ' + ((screen.orientation && screen.orientation.type) || (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait')));
    L.push('Touch: ' + (('ontouchstart' in window) ? 'yes' : 'no'));
    L.push('Max touch points: ' + (navigator.maxTouchPoints || 0));
    L.push('Timezone: ' + (Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '—'));
    L.push('');
    return L;
  }

  function buildSessionBlock(session, appMeta) {
    const L = [];
    L.push('--- SESSION STATE ---');
    if (!session) { L.push('session missing'); L.push(''); return L; }
    L.push('active: ' + (session.active ? 'yes' : 'no'));
    L.push('isPaused: ' + (session.isPaused ? 'yes' : 'no'));
    L.push('waitingForHero: ' + (session.waitingForHero ? 'yes' : 'no'));
    L.push('heroEliminated: ' + (session.heroEliminated ? 'yes' : 'no'));
    L.push('heroFinishPlace: ' + session.heroFinishPlace);
    L.push('tournamentOver: ' + (session.tournamentOver ? 'yes' : 'no'));
    L.push('finalShown: ' + (session.finalShown ? 'yes' : 'no'));
    L.push('huAutoActive: ' + (session.huAutoActive ? 'yes' : 'no'));
    L.push('history.length: ' + (session.history ? session.history.length : 0));
    L.push('viewingIndex: ' + session.viewingIndex);
    L.push('replay.active: ' + (session.replay ? (session.replay.active ? 'yes' : 'no') : '—'));
    L.push('replay.paused: ' + (session.replay ? (session.replay.paused ? 'yes' : 'no') : '—'));
    L.push('replay.stepIndex: ' + (session.replay ? session.replay.stepIndex : '—'));
    L.push('replay.steps.length: ' + (session.replay && session.replay.steps ? session.replay.steps.length : '—'));
    L.push('');
    L.push('--- TIMERS ---');
    L.push('heroTimerIntervalId: ' + (session.heroTimerIntervalId ? 'set' : 'null'));
    L.push('heroTimerRemaining: ' + fmtNum(session.heroTimerRemaining));
    L.push('heroTimerTotal: ' + fmtNum(session.heroTimerTotal));
    L.push('botTimerId: ' + (session.botTimerId ? 'set' : 'null'));
    L.push('autoNextTimerId: ' + (session.autoNextTimerId ? 'set' : 'null'));
    L.push('revealTimerId: ' + (session.revealTimerId ? 'set' : 'null'));
    L.push('streetEndTimerId: ' + (session.streetEndTimerId ? 'set' : 'null'));
    L.push('streetRevealTimers count: ' + (session.streetRevealTimers ? session.streetRevealTimers.length : 0));
    L.push('pendingTimers tracked: ' + state.pendingTimers.size);
    for (const [id, rec] of state.pendingTimers.entries()) {
      L.push('  timer #' + id + ': kind=' + rec.kind + ' age=' + (Date.now() - rec.startedAt) + 'ms payload=' + safeStringify(rec.payload));
    }
    L.push('');
    return L;
  }

  function buildGlobalFlagsBlock() {
    const L = [];
    L.push('--- GLOBAL FLAGS ---');
    L.push('__ppCurrentBotsLevel: ' + (window.__ppCurrentBotsLevel || '—'));
    L.push('__ppPendingBotsLevel: ' + (window.__ppPendingBotsLevel || '—'));
    L.push('__sessionShowHistoryLabel: ' + (window.__sessionShowHistoryLabel ? 'yes' : 'no'));
    L.push('__replayActive: ' + (window.__replayActive ? 'yes' : 'no'));
    L.push('__botsJsLoaded: ' + (window.__botsJsLoaded ? 'yes' : 'no'));
    L.push('__ppAllowLogCopy: ' + (window.__ppAllowLogCopy ? 'yes' : 'no'));
    L.push('__ppAllowDonateCopy: ' + (window.__ppAllowDonateCopy ? 'yes' : 'no'));
    L.push('window.Bots.__level: ' + ((window.Bots && window.Bots.__level) || '—'));
    L.push('window.Bots.__version: ' + ((window.Bots && window.Bots.__version) || '—'));
    L.push('window.Bots.__source: ' + ((window.Bots && window.Bots.__source) || '—'));
    L.push('window.VipBots available: ' + (window.VipBots ? 'yes' : 'no'));
    L.push('Engine available: ' + (window.Engine ? 'yes' : 'no'));
    L.push('');
    return L;
  }

  function buildEngineStateBlock(session) {
    const L = [];
    L.push('--- CURRENT ENGINE STATE ---');
    const st = session && session.state;
    if (!st) {
      L.push('(no current hand state)');
      L.push('');
      return L;
    }
    L.push('Hand #' + st.handNumber + ' | level ' + st.levelIndex + ' | handsAtLevel ' + st.handsAtLevel);
    L.push('Street: ' + st.street + ' | actingIndex: ' + st.actingIndex + ' | lastAggressorIndex: ' + (st.lastAggressorIndex !== null ? st.lastAggressorIndex : 'null'));
    L.push('Button: ' + st.buttonIndex + ' | blinds SB ' + st.blinds.sb + ' / BB ' + st.blinds.bb + ' / ante ' + st.blinds.ante);
    L.push('Pot: ' + st.pot + ' | currentBet: ' + st.currentBet + ' | minRaise: ' + st.minRaise);
    L.push('Board: ' + (st.board && st.board.length ? st.board.map(c => c.rank + c.suit).join(' ') : 'empty'));
    L.push('handOver: ' + (st.handOver ? 'yes' : 'no') + ' | finalStreet: ' + (st.finalStreet || '—'));
    L.push('_deckIdx: ' + (st._deckIdx !== undefined ? st._deckIdx : '—') + ' | deck.length: ' + (st.deck ? st.deck.length : 0));
    L.push('actionLog.length: ' + (st.actionLog ? st.actionLog.length : 0));
    L.push('');
    L.push('Players:');
    for (const p of st.players) {
      L.push('  seat ' + p.seatIndex + ' | ' + p.name +
        ' | ' + (p.isHero ? 'HERO' : 'bot ' + (p.botType || '—')) +
        ' | pos ' + (p.position || '—') +
        ' | stack ' + p.stack +
        ' | committed ' + p.committedThisStreet + '/' + p.committedTotal +
        ' | folded=' + (p.folded ? 'y' : 'n') +
        ' | allIn=' + (p.allIn ? 'y' : 'n') +
        ' | eliminated=' + (p.eliminated ? 'y' : 'n') +
        ' | acted=' + (p.acted ? 'y' : 'n') +
        ' | cards ' + (p.holeCards && p.holeCards.length ? p.holeCards.map(c => c.rank + c.suit).join(' ') : '—'));
    }
    L.push('');
    L.push('Action log:');
    if (st.actionLog && st.actionLog.length) {
      for (let i = 0; i < st.actionLog.length; i++) {
        const a = st.actionLog[i];
        const pp = st.players.find(pl => pl.seatIndex === a.playerIndex);
        L.push('  #' + (i+1) + ' [' + a.street + '] ' + (pp ? pp.name : ('seat ' + a.playerIndex)) +
          ' → ' + a.actionType + (a.amount ? ' ' + a.amount : '') + ' | potAfter=' + a.potAfter);
      }
    } else {
      L.push('  (empty)');
    }
    L.push('');
    return L;
  }

  function buildStatsBlock() {
    const L = [];
    L.push('--- OPPONENT STATS DUMP ---');
    const b = window.Bots;
    if (!b || typeof b.dumpStats !== 'function') {
      L.push('  dumpStats not available');
      L.push('');
      return L;
    }
    let dump = [];
    try { dump = b.dumpStats(); } catch (e) { L.push('  dumpStats error: ' + String(e && e.message || e)); L.push(''); return L; }
    if (!Array.isArray(dump) || dump.length === 0) {
      L.push('  No opponent stats recorded');
      L.push('');
      return L;
    }
    L.push('  Tracked opponents: ' + dump.length);
    const shrinkKeys = ['rfi','threeBet','foldTo3Bet','coldCall','fourBet','foldTo4Bet','foldToResteal','foldBbToStealBtn','sbRfiVsBb','bbDefendVsBtn','limp','isoRaise','squeeze','resteal','steal','fiveBet','cold4Bet','call4Bet','foldToSqueeze','squeezeVs1','squeezeVs2','bbDefendVsUtg','bbDefendVsCo','sbDefendVsBtn','sbFoldVsBb3Bet'];
    for (const entry of dump) {
      const id = entry[0];
      const stats = entry[1] || {};
      L.push('  --- ' + id + ' ---');
      for (const k of ['handsPlayed','showdowns','showdownWins','positionalAwareness','limpTrapCount','adaptationDetected']) {
        if (stats[k] !== undefined) {
          L.push('    ' + k + ' = ' + (typeof stats[k] === 'boolean' ? (stats[k] ? 'yes' : 'no') : fmtNum(stats[k])));
        }
      }
      const metrics = Object.keys(stats).filter(k =>
        typeof stats[k] === 'number' &&
        k !== 'handsPlayed' && k !== 'showdowns' && k !== 'showdownWins' &&
        k !== 'positionalAwareness' && k !== 'limpTrapCount' &&
        !k.endsWith('Opportunities') &&
        k.indexOf('_') !== 0
      );
      for (const m of metrics) {
        const opp = stats[m + 'Opportunities'];
        if (typeof opp !== 'number') continue;
        L.push('    ' + m + ': raw=' + fmtNum(stats[m]) + '/' + opp +
          ' = ' + (opp > 0 ? fmtNum(stats[m] / opp) : '—') + ' | opp=' + opp);
      }
      if (typeof b.getShrunk === 'function') {
        const parts = [];
        for (const sk of shrinkKeys) {
          try {
            const sh = b.getShrunk(id, sk);
            if (sh && sh.sampleSize > 0) {
              parts.push(sk + '=v' + fmtNum(sh.value) + '/r' + fmtNum(sh.raw) + '/c' + fmtNum(sh.confidence) + '/n' + sh.sampleSize);
            }
          } catch (e) {}
        }
        if (parts.length) L.push('    shrunk: ' + parts.join(' '));
      }
    }
    L.push('');
    return L;
  }

  function buildLastBotDecisionsBlock() {
    const L = [];
    L.push('--- LAST BOT DECISION CONTEXTS (current hand) ---');
    const keys = Object.keys(state.lastBotDecision);
    if (!keys.length) {
      L.push('No bot decisions recorded');
      L.push('');
      return L;
    }
    for (const k of keys) {
      const c = state.lastBotDecision[k];
      if (!c) continue;
      L.push('  ' + k +
        ' | pos=' + (c.position || '—') +
        ' | ctx=' + (c.contextType || '—') +
        ' | raiserPos=' + (c.raiserPosition || '—') +
        ' | limpers=' + (c.numLimpers !== undefined ? c.numLimpers : '—') +
        ' | isRealRaise=' + (c.isRealRaise ? 'y' : 'n') +
        ' | toCall=' + fmtNum(c.toCall) +
        ' | pot=' + fmtNum(c.pot) +
        ' | stackBB=' + fmtNum(c.stackBB) +
        ' | strength=' + (c.diagnostics && c.diagnostics.strength !== undefined ? fmtNum(c.diagnostics.strength) : '—') +
        ' | statUsed=' + (c.diagnostics && (c.diagnostics.statUsed || c.diagnostics.statKey) || '—') +
        ' | statConf=' + (c.diagnostics && c.diagnostics.statConfidence !== undefined ? fmtNum(c.diagnostics.statConfidence) : '—') +
        ' | reason=' + (c.diagnostics && c.diagnostics.reason ? c.diagnostics.reason : '—'));
    }
    L.push('');
    return L;
  }

  function buildUIStateBlock(appMeta) {
    const L = [];
    L.push('--- UI STATE ---');
    const uiSettings = (appMeta && appMeta.uiSettings) || (window.UI && UI.settings) || {};
    L.push('cardStyle: ' + uiSettings.cardStyle);
    L.push('stackDisplay: ' + uiSettings.stackDisplay);
    L.push('blindGrowthHands: ' + uiSettings.blindGrowthHands);
    L.push('turnTime: ' + uiSettings.turnTime);
    L.push('showAllHands: ' + (uiSettings.showAllHands ? 'yes' : 'no'));
    L.push('hideHeroHand: ' + (uiSettings.hideHeroHand ? 'yes' : 'no'));
    L.push('hideBoardCards: ' + (uiSettings.hideBoardCards ? 'yes' : 'no'));
    L.push('showAllShowdown: ' + (uiSettings.showAllShowdown ? 'yes' : 'no'));
    const uiState = (appMeta && appMeta.uiState) || {};
    L.push('hero-actions inactive: ' + (uiState.heroActionsInactive ? 'yes' : 'no'));
    L.push('Fold disabled: ' + (uiState.btnFoldDisabled ? 'yes' : 'no'));
    L.push('Check disabled: ' + (uiState.btnCheckDisabled ? 'yes' : 'no'));
    L.push('Call disabled: ' + (uiState.btnCallDisabled ? 'yes' : 'no') + ' | mode ' + (uiState.btnCallMode || 'call'));
    if (uiState.slider) {
      L.push('slider: active=' + (uiState.slider.active ? 'y' : 'n') +
        ' call=' + fmtNum(uiState.slider.callValue) +
        ' minRaise=' + fmtNum(uiState.slider.minRaiseValue) +
        ' max=' + fmtNum(uiState.slider.maxValue) +
        ' current=' + fmtNum(uiState.slider.currentValue));
    }
    L.push('');
    L.push('--- DOM SNAPSHOT ---');
    try {
      const seatsEl = document.getElementById('seats');
      L.push('seats nodes: ' + (seatsEl ? seatsEl.children.length : '—'));
      const boardEl = document.getElementById('board-cards');
      L.push('board cards: ' + (boardEl ? boardEl.children.length : '—'));
      const potEl = document.getElementById('pot-display');
      L.push('pot text: ' + (potEl ? potEl.textContent : '—'));
      const blindsEl = document.getElementById('info-blinds-row');
      L.push('blinds text: ' + (blindsEl ? blindsEl.textContent : '—'));
      const timerEl = document.getElementById('info-timer-row');
      L.push('timer text: ' + (timerEl ? timerEl.textContent : '—'));
      const placeEl = document.getElementById('place-line');
      L.push('rank line: ' + (placeEl ? placeEl.textContent : '—'));
      const haEl = document.getElementById('hero-actions');
      L.push('hero-actions visible: ' + (haEl && !haEl.classList.contains('inactive') ? 'yes' : 'no'));
      const qpEl = document.getElementById('quick-percent-list');
      L.push('quick-percent buttons: ' + (qpEl ? qpEl.children.length : '—'));
      const foEl = document.getElementById('final-overlay');
      L.push('final-overlay visible: ' + (foEl && foEl.classList.contains('visible') ? 'yes' : 'no'));
      const doEl = document.getElementById('donate-overlay');
      L.push('donate-overlay visible: ' + (doEl && doEl.classList.contains('visible') ? 'yes' : 'no'));
    } catch (e) {}
    L.push('');
    return L;
  }

  function buildHandSummaryBlock(session) {
    const L = [];
    L.push('--- HAND SUMMARY (last ' + CONFIG.detailedHandsLimit + ' detailed) ---');
    if (!session || !session.history || session.history.length === 0) {
      L.push('No hands yet');
      L.push('');
      return L;
    }
    const hist = session.history;
    const start = Math.max(0, hist.length - CONFIG.detailedHandsLimit);
    L.push('Showing hands ' + (start + 1) + '..' + hist.length + ' of ' + hist.length);
    for (let i = start; i < hist.length; i++) {
      const snap = hist[i];
      const alive = (snap.players || []).filter(p => !p.eliminated).length;
      let winnerName = '—';
      let winnerPayout = 0;
      if (snap.showdownResults && snap.showdownResults.payouts) {
        for (const [id, amount] of Object.entries(snap.showdownResults.payouts)) {
          if (amount > winnerPayout) {
            const pp = (snap.players || []).find(pl => String(pl.id) === String(id));
            winnerName = pp ? pp.name : id;
            winnerPayout = amount;
          }
        }
      }
      L.push('  #' + snap.handNumber + ' | final=' + (snap.finalStreet || '—') +
        ' | pot=' + snap.pot +
        ' | aliveAfter=' + alive +
        ' | winner=' + winnerName + ' (' + winnerPayout + ')');
    }
    L.push('');
    return L;
  }

  function buildLastHandsDetailsBlock(session) {
    const L = [];
    L.push('--- DETAILED HANDS LOG (last ' + CONFIG.detailedHandsLimit + ') ---');
    if (!session || !session.history || session.history.length === 0) {
      L.push('No hands yet');
      L.push('');
      return L;
    }
    const hist = session.history;
    const start = Math.max(0, hist.length - CONFIG.detailedHandsLimit);
    for (let i = start; i < hist.length; i++) {
      const snap = hist[i];
      L.push('');
      L.push('=== HAND #' + snap.handNumber + ' ===');
      L.push(buildHandLog(snap, { viewingPast: true, replayActive: false }));
    }
    L.push('');
    return L;
  }

  function buildEventsDump() {
    const L = [];
    L.push('--- EVENTS BUFFER DUMP (' + state.detailedEvents.length + ' events) ---');
    if (!state.detailedEvents.length) {
      L.push('  (empty)');
      L.push('');
      return L;
    }
    for (const ev of state.detailedEvents) {
      const tag = ev.type === 'error' ? '[ERR]' : (ev.type === 'warn' ? '[WARN]' : '[' + ev.type.toUpperCase() + ']');
      L.push('  ' + tag + ' ts=' + ev.ts +
        ' hand=' + (ev.handId || '—') +
        ' step=' + (ev.stepId || '—') +
        ' mode=' + ev.mode +
        ' | ' + safeStringify(ev.payload));
    }
    L.push('');
    return L;
  }

  function buildErrorsBlock(appMeta) {
    const L = [];
    L.push('--- ERRORS ---');
    const errs = (appMeta && appMeta.errors) || window.__ppErrors || [];
    if (!errs.length) {
      L.push('  None');
      L.push('');
      return L;
    }
    L.push('  Total: ' + errs.length);
    for (const e of errs) {
      L.push('  [' + new Date(e.ts || Date.now()).toLocaleString('en-US') + '] ' + (e.kind || 'error') + ': ' + (e.message || '—'));
      if (e.source) L.push('    source: ' + e.source + ':' + (e.line || 0) + ':' + (e.col || 0));
      if (e.stack) {
        for (const line of String(e.stack).split('\n')) L.push('    ' + line);
      }
    }
    L.push('');
    return L;
  }

  function buildChecksSummary(session) {
    const L = [];
    L.push('--- CHECKS SUMMARY ---');
    if (!session || !session.history || session.history.length === 0) {
      L.push('No hands to check');
      L.push('');
      return L;
    }
    const hist = session.history;
    const start = Math.max(0, hist.length - CONFIG.detailedHandsLimit);
    let totalChecks = 0;
    let totalIssues = 0;
    let botMismatchCount = 0;
    for (let i = start; i < hist.length; i++) {
      const snap = hist[i];
      const chk = runChecks(snap);
      totalChecks += 4;
      totalIssues += chk.total;
      botMismatchCount += chk.results.botMismatch.length;
      L.push('  Hand #' + snap.handNumber + ': ' + (chk.total === 0 ? 'OK' : chk.total + ' issue(s)'));
      if (chk.total > 0) {
        for (const k of Object.keys(chk.results)) {
          const list = chk.results[k];
          if (!list.length) continue;
          for (const issue of list) L.push('    [' + k + '] ' + issue);
        }
      }
    }
    L.push('');
    L.push('Total checks: ' + totalChecks);
    L.push('Total issues: ' + totalIssues);
    L.push('Bot-engine mismatches: ' + botMismatchCount);
    L.push(totalIssues === 0 ? 'OVERALL: ALL OK' : 'OVERALL: ' + totalIssues + ' ISSUES');
    L.push('');
    return L;
  }

  function safeStringify(obj) {
    try {
      return JSON.stringify(obj, function(key, value) {
        if (typeof value === 'function') return '[fn]';
        if (value instanceof Map) { const o = {}; value.forEach((v, k) => { o[k] = v; }); return o; }
        if (value instanceof Set) return Array.from(value);
        return value;
      });
    } catch (e) { return '"[unserializable]"'; }
  }

  // ========================================================================
  // PUBLIC BUILDERS
  // ========================================================================

  function buildHandReport(snap, meta) {
    try {
      return buildHandLog(snap, meta || {});
    } catch (e) {
      return 'ERROR building hand report: ' + String(e && e.message || e);
    }
  }

  function buildAppReport(session, appMeta) {
    try {
      const L = [];
      L.push(...buildSummaryHeader(appMeta));
      L.push(...buildGlossary());
      L.push(...buildKnownLimitations());
      L.push(...buildEnvBlock());
      L.push(...buildSessionBlock(session, appMeta));
      L.push(...buildGlobalFlagsBlock());
      L.push(...buildEngineStateBlock(session));
      L.push(...buildStatsBlock());
      L.push(...buildLastBotDecisionsBlock());
      L.push(...buildUIStateBlock(appMeta));
      L.push(...buildHandSummaryBlock(session));
      L.push(...buildLastHandsDetailsBlock(session));
      L.push(...buildEventsDump());
      L.push(...buildErrorsBlock(appMeta));
      L.push(...buildChecksSummary(session));
      L.push('=== END OF APP LOG ===');
      return L.join('\n');
    } catch (e) {
      return 'ERROR building app report: ' + String(e && e.message || e);
    }
  }

  function buildPokerStarsHistory(snap) {
    if (!snap) return '';
    const L = [];
    const now = new Date();

    const sb = snap.blinds ? snap.blinds.sb : 10;
    const bb = snap.blinds ? snap.blinds.bb : 20;
    const ante = snap.blinds ? (snap.blinds.ante || 0) : 0;
    const handId = 1000000000 + (snap.handNumber || 0);
    const tournamentId = 2000000000 + (snap.handNumber || 0);
    const levelNumber = (snap.levelIndex || 0) + 1;
    const maxSeats = snap.players ? snap.players.length : 8;
    const buttonSeat = (typeof snap.buttonIndex === 'number') ? (snap.buttonIndex + 1) : 1;
    const buyin = '$0.00+$0.00';
    const dateStr = fmtDateEt(now);
    const tableName = 'ThePokerWay - Sit & Go 8-max';

    L.push('PokerStars Hand #' + handId + ': Tournament #' + tournamentId + ', ' + buyin +
      ' USD Hold\'em No Limit - Level ' + levelNumber + ' (' + sb + '/' + bb + ') - ' + dateStr);
    L.push('Table \'' + tableName + '\' ' + maxSeats + '-max Seat #' + buttonSeat + ' is the button');

    const sortedPlayers = (snap.players || []).slice().sort((a, b) => a.seatIndex - b.seatIndex);
    for (const p of sortedPlayers) {
      const seatNum = p.seatIndex + 1;
      L.push('Seat ' + seatNum + ': ' + psNameFor(p) + ' (' + p.stack + ' in chips)');
    }

    const alive = (snap.players || []).filter(p => !p.eliminated);
    const isHU = alive.length === 2;
    let sbSeatPlayer = null, bbSeatPlayer = null;
    if (isHU) {
      sbSeatPlayer = sortedPlayers.find(p => p.seatIndex === snap.buttonIndex) || null;
      if (sbSeatPlayer) {
        const idx = sortedPlayers.indexOf(sbSeatPlayer);
        for (let k = 1; k <= sortedPlayers.length; k++) {
          const cand = sortedPlayers[(idx + k) % sortedPlayers.length];
          if (!cand.eliminated && cand.inHand) { bbSeatPlayer = cand; break; }
        }
      }
    } else {
      const btnIdx = sortedPlayers.findIndex(p => p.seatIndex === snap.buttonIndex);
      if (btnIdx >= 0) {
        for (let k = 1; k <= sortedPlayers.length; k++) {
          const cand = sortedPlayers[(btnIdx + k) % sortedPlayers.length];
          if (!cand.eliminated && cand.inHand) { sbSeatPlayer = cand; break; }
        }
        if (sbSeatPlayer) {
          const sbIdx = sortedPlayers.indexOf(sbSeatPlayer);
          for (let k = 1; k <= sortedPlayers.length; k++) {
            const cand = sortedPlayers[(sbIdx + k) % sortedPlayers.length];
            if (!cand.eliminated && cand.inHand) { bbSeatPlayer = cand; break; }
          }
        }
      }
    }

    if (ante > 0) {
      for (const p of sortedPlayers) {
        if (p.eliminated) continue;
        L.push(psNameFor(p) + ': posts the ante ' + ante);
      }
    }
    if (sbSeatPlayer) L.push(psNameFor(sbSeatPlayer) + ': posts small blind ' + sb);
    if (bbSeatPlayer) L.push(psNameFor(bbSeatPlayer) + ': posts big blind ' + bb);
    L.push('*** HOLE CARDS ***');

    const hero = (snap.players || []).find(p => p.isHero);
    if (hero && hero.holeCards && hero.holeCards.length === 2) {
      L.push('Dealt to ' + psNameFor(hero) + ' [' + cardsPs(hero.holeCards) + ']');
    }

    const log = snap.actionLog || [];
    let shownStreet = null;
    const boardSnapshot = (snap.board || []).map(c => c);

    for (const a of log) {
      if (a.street !== shownStreet) {
        shownStreet = a.street;
        if (shownStreet === 'flop') {
          const flop = boardSnapshot.slice(0, 3);
          if (flop.length === 3) L.push('*** FLOP *** [' + cardsPs(flop) + ']');
        } else if (shownStreet === 'turn') {
          const turn = boardSnapshot.slice(0, 4);
          if (turn.length === 4) L.push('*** TURN *** [' + cardsPs(turn.slice(0,3)) + '] [' + cardPs(turn[3]) + ']');
        } else if (shownStreet === 'river') {
          const river = boardSnapshot.slice(0, 5);
          if (river.length === 5) L.push('*** RIVER *** [' + cardsPs(river.slice(0,4)) + '] [' + cardPs(river[4]) + ']');
        }
      }
      const p = (snap.players || []).find(pl => pl.seatIndex === a.playerIndex);
      if (!p) continue;
      const pname = psNameFor(p);
      if (a.actionType === 'sb' || a.actionType === 'bb') continue;
      if (a.actionType === 'fold') L.push(pname + ': folds');
      else if (a.actionType === 'check') L.push(pname + ': checks');
      else if (a.actionType === 'call') L.push(pname + ': calls ' + (a.amount || 0));
      else if (a.actionType === 'bet') L.push(pname + ': bets ' + (a.amount || 0));
      else if (a.actionType === 'raise') L.push(pname + ': raises ' + (a.amount || 0) + ' to ' + (a.amount || 0));
      else if (a.actionType === 'allin') L.push(pname + ': is all-in');
    }

    if (snap.showdownResults) {
      const sr = snap.showdownResults;
      if (!sr.uncontested) {
        L.push('*** SHOW DOWN ***');
        const scores = sr.scores || {};
        for (const [id, sc] of Object.entries(scores)) {
          const p = (snap.players || []).find(pl => String(pl.id) === String(id));
          if (!p) continue;
          if (p.holeCards && p.holeCards.length === 2) {
            L.push(psNameFor(p) + ': shows [' + cardsPs(p.holeCards) + '] (' + psHandName(sc) + ')');
          }
        }
        const payouts = sr.payouts || {};
        const mainWinner = Object.keys(payouts).sort((a, b) => payouts[b] - payouts[a])[0];
        if (mainWinner) {
          const p = (snap.players || []).find(pl => String(pl.id) === String(mainWinner));
          if (p) L.push(psNameFor(p) + ' collected ' + payouts[mainWinner] + ' from pot');
        }
      }
    }

    L.push('*** SUMMARY ***');
    L.push('Total pot ' + (snap.pot || 0) + ' | Rake 0');
    if (snap.board && snap.board.length > 0) {
      const parts = [];
      if (snap.board.length >= 3) parts.push('[' + cardsPs(snap.board.slice(0,3)) + ']');
      if (snap.board.length >= 4) parts.push('[' + cardPs(snap.board[3]) + ']');
      if (snap.board.length >= 5) parts.push('[' + cardPs(snap.board[4]) + ']');
      L.push('Board ' + parts.join(' '));
    }
    const sr = snap.showdownResults;
    const scores = (sr && sr.scores) || {};
    for (const p of sortedPlayers) {
      const seatNum = p.seatIndex + 1;
      const pname = psNameFor(p);
      const payout = sr && sr.payouts ? (sr.payouts[p.id] || 0) : 0;
      const sc = scores[p.id] || scores[String(p.id)] || null;
      if (payout > 0) {
        L.push('Seat ' + seatNum + ': ' + pname + ' showed [' + cardsPs(p.holeCards || []) + '] and won (' + payout + ')' + (sc ? ' with ' + psHandName(sc) : ''));
      } else if (!p.folded && p.holeCards && p.holeCards.length === 2) {
        L.push('Seat ' + seatNum + ': ' + pname + ' showed [' + cardsPs(p.holeCards) + ']' + (sc ? ' and lost with ' + psHandName(sc) : ''));
      } else {
        L.push('Seat ' + seatNum + ': ' + pname + ' folded before Flop (didn\'t bet)');
      }
    }
    return L.join('\n');
  }

  // ========================================================================
  // CLIPBOARD
  // ========================================================================

  async function copyToClipboard(text) {
    try {
      window.__ppAllowLogCopy = true;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.setAttribute('readonly', 'readonly');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    } finally {
      setTimeout(() => { window.__ppAllowLogCopy = false; }, 0);
    }
  }

  // ========================================================================
  // INIT + EXPORT
  // ========================================================================

  function init(opts) {
    try {
      state.sessionStartTs = (opts && opts.sessionStartTs) || Date.now();
      window.__ppErrors = (opts && opts.errors) || window.__ppErrors || [];
      record('session_init', { at: state.sessionStartTs });
    } catch (e) {}
  }

  window.LogBuf = {
    init,
    record,
    setHandContext,
    nextStep,
    archiveHand,
    setMode,
    startTimer,
    endTimer,
    buildHandReport,
    buildAppReport,
    buildPokerStarsHistory,
    copyToClipboard,
    reset: resetAll,
    _state: state,
    _config: CONFIG
  };

})();