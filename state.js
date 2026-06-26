/**
 * state.js
 * Reactive application state for the Financial Investigation Platform.
 * Single source of truth. Every UI panel subscribes to statechange events.
 *
 * Architecture:
 *   - Event sourcing: investigator actions are appended, never mutated
 *   - Case versioning: each edit creates a new version
 *   - DAG-aware recomputation: only affected pipeline nodes rerun on change
 *   - localStorage persistence: cases, markers, entity edits survive browser restarts
 *
 * Version: 1.0.0
 */

'use strict';

// ─── EventBus ─────────────────────────────────────────────────────────────────

const EventBus = (() => {
  const listeners = {};
  return {
    on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return () => { listeners[event] = listeners[event].filter(f => f !== fn); };
    },
    emit(event, data) {
      (listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) { console.error('EventBus error:', e); } });
    },
    off(event, fn) {
      if (listeners[event]) listeners[event] = listeners[event].filter(f => f !== fn);
    }
  };
})();

// ─── Computation DAG ──────────────────────────────────────────────────────────
// Tracks which pipeline nodes need rerunning based on what changed.
// Avoids full recomputation on every filter/period change.

const DAG = {
  // Dependency order (each node depends on all nodes above it in its branch)
  nodes: ['normalize', 'classify', 'resolve', 'filter', 'balance', 'cash', 'patterns', 'risk', 'relationships', 'stories'],

  // Which changes invalidate which nodes
  invalidationMap: {
    'rawData':      ['normalize','classify','resolve','filter','balance','cash','patterns','risk','relationships','stories'],
    'rules':        ['classify','filter','patterns','risk','stories'],
    'entityEdits':  ['resolve','filter','balance','cash','patterns','risk','relationships','stories'],
    'periodFilter': ['filter','balance','cash','patterns','risk','relationships','stories'],
    'entityFilter': ['filter','balance','cash','patterns','risk','stories'],
  },

  dirty: new Set(),

  invalidate(reason) {
    const affected = this.invalidationMap[reason] || this.nodes;
    affected.forEach(n => this.dirty.add(n));
  },

  isDirty(node) { return this.dirty.has(node); },

  markClean(nodes) {
    (Array.isArray(nodes) ? nodes : [nodes]).forEach(n => this.dirty.delete(n));
  },

  reset() { this.dirty = new Set(this.nodes); }
};

// ─── LocalStorage helpers ──────────────────────────────────────────────────────

const Storage = {
  PREFIX: 'finv_',

  get(key, defaultVal = null) {
    try {
      const raw = localStorage.getItem(this.PREFIX + key);
      return raw !== null ? JSON.parse(raw) : defaultVal;
    } catch { return defaultVal; }
  },

  set(key, value) {
    try { localStorage.setItem(this.PREFIX + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },

  remove(key) {
    try { localStorage.removeItem(this.PREFIX + key); } catch {}
  },

  clear() {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(this.PREFIX))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
  }
};

// ─── State ────────────────────────────────────────────────────────────────────

const State = (() => {

  // ── Private state ───────────────────────────────────────────────────────────

  let _cases = [];
  let _activeCaseId = null;
  let _geminiKey = null;
  let _replayState = { running: false, speed: 1, mode: 'transaction', index: 0 };
  let _computed = null;      // last computed result from Engine
  let _computing = false;    // prevent re-entrant compute

  // Active case shorthand
  function _activeCase() {
    return _cases.find(c => c.id === _activeCaseId) || null;
  }

  function _currentState() {
    const c = _activeCase();
    return c ? c.currentState : Schema.makeDefaultCaseState();
  }

  // ── Recompute (DAG-aware) ───────────────────────────────────────────────────

  function _recompute(changedBy = 'unknown') {
    if (_computing) return;
    _computing = true;

    DAG.invalidate(changedBy);

    try {
      const state = _currentState();
      const { filter, entityEdits, disabledRules } = state;

      // Apply rule overrides
      const activeRules = DEFAULT_RULES.filter(r => !disabledRules.includes(r.id));

      const result = Engine.compute(
        RAW_TRANSACTIONS,
        activeRules,
        DEFAULT_ENTITIES,
        entityEdits,
        filter.from,
        filter.to
      );

      // Additional filtering by entity/bank/flags/search not handled by compute()
      let displayTxns = result.periodTransactions;

      if (filter.entityIds && filter.entityIds.length > 0) {
        displayTxns = displayTxns.filter(t => filter.entityIds.includes(t.entityId));
      }
      if (filter.banks && filter.banks.length > 0) {
        displayTxns = displayTxns.filter(t => filter.banks.includes(t.bank));
      }
      if (filter.direction) {
        displayTxns = displayTxns.filter(t => t.direction === filter.direction);
      }
      if (filter.minAmount) {
        displayTxns = displayTxns.filter(t => t.amount >= filter.minAmount);
      }
      if (filter.maxAmount) {
        displayTxns = displayTxns.filter(t => t.amount <= filter.maxAmount);
      }
      if (filter.categories && filter.categories.length > 0) {
        displayTxns = displayTxns.filter(t => filter.categories.includes(t.categoryId));
      }
      if (filter.flags && filter.flags.length > 0) {
        const flaggedIds = new Set(result.flags.filter(f => filter.flags.includes(f.ruleId)).flatMap(f => f.txnIds));
        displayTxns = displayTxns.filter(t => flaggedIds.has(t.id));
      }
      if (filter.searchText) {
        const q = filter.searchText.toLowerCase();
        displayTxns = displayTxns.filter(t =>
          t.narration.toLowerCase().includes(q) ||
          (t.entityId || '').toLowerCase().includes(q)
        );
      }

      _computed = {
        ...result,
        displayTransactions: displayTxns,
        activeFilter: { ...filter },
        activeCase: _activeCase(),
        eventMarkers: state.eventMarkers || [],
        hypotheses: _activeCase()?.hypotheses || [],
        computedAt: new Date().toISOString(),
      };

      DAG.reset();

    } catch(e) {
      console.error('Recompute error:', e);
    } finally {
      _computing = false;
    }

    EventBus.emit('statechange', _computed);
    return _computed;
  }

  // ── Action processor (event sourcing) ──────────────────────────────────────

  function _applyAction(action) {
    const c = _activeCase();
    if (!c) return;

    // Append to action log (immutable event sourcing)
    c.actionLog.push({ ...action, timestamp: new Date().toISOString() });

    // Derive current state by replaying all actions
    c.currentState = _replayActions(c.actionLog);

    // Increment version
    c.version = (c.version || 1) + 1;
    c.updatedAt = new Date().toISOString();

    _persistCases();
  }

  function _replayActions(actionLog) {
    let state = Schema.makeDefaultCaseState();

    actionLog.forEach(action => {
      switch(action.type) {

        case Schema.InvestigatorAction.SET_FILTER:
          state.filter = { ...state.filter, ...action.payload };
          break;

        case Schema.InvestigatorAction.MERGE_ENTITY:
          state.entityEdits = [
            ...state.entityEdits.filter(e => !(e.type === 'MergeEntity' && e.sourceEntityId === action.sourceEntityId)),
            { type: 'MergeEntity', sourceEntityId: action.sourceEntityId, targetEntityId: action.targetEntityId }
          ];
          break;

        case Schema.InvestigatorAction.RENAME_ENTITY:
          state.entityEdits = [
            ...state.entityEdits.filter(e => !(e.type === 'RenameEntity' && e.entityId === action.entityId)),
            { type: 'RenameEntity', entityId: action.entityId, newName: action.newName }
          ];
          break;

        case Schema.InvestigatorAction.CREATE_MARKER:
          state.eventMarkers = [...state.eventMarkers.filter(m => m.id !== action.marker.id), action.marker];
          break;

        case 'DeleteMarker':
          state.eventMarkers = state.eventMarkers.filter(m => m.id !== action.markerId);
          break;

        case Schema.InvestigatorAction.ADD_NOTE:
          state.notes = { ...state.notes, [action.targetId]: action.note };
          break;

        case Schema.InvestigatorAction.DISABLE_RULE:
          if (!state.disabledRules.includes(action.ruleId))
            state.disabledRules = [...state.disabledRules, action.ruleId];
          break;

        case Schema.InvestigatorAction.ENABLE_RULE:
          state.disabledRules = state.disabledRules.filter(id => id !== action.ruleId);
          break;

        case Schema.InvestigatorAction.SET_HYPOTHESIS:
          state.activeHypothesis = action.hypothesis;
          break;
      }
    });

    return state;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  function _persistCases() {
    Storage.set('cases', _cases.map(c => ({
      ...c,
      // Don't persist computed — it's rebuilt on load
    })));
  }

  function _loadFromStorage() {
    const savedCases = Storage.get('cases', []);
    _cases = savedCases.length > 0 ? savedCases.map(c => {
      // Rebuild currentState from actionLog
      c.currentState = _replayActions(c.actionLog || []);
      return c;
    }) : [];

    _activeCaseId = Storage.get('activeCaseId', null);
    _geminiKey = Storage.get('geminiKey', null);

    // Create default case if none exist
    if (_cases.length === 0) {
      _createDefaultCase();
    }

    // Ensure active case is valid
    if (!_activeCaseId || !_cases.find(c => c.id === _activeCaseId)) {
      _activeCaseId = _cases[0]?.id || null;
    }
  }

  function _createDefaultCase() {
    const defaultCase = Schema.makeCase({
      id: 'CASE-001',
      name: 'RAJ KUMAR — Primary Investigation',
      description: 'Financial investigation of Raj Kumar, Narwana, Haryana. Axis Bank + PNB accounts, Apr 2016 – Jun 2026.',
      subjectId: 'SUBJECT',
      createdAt: new Date().toISOString(),
    });
    defaultCase.version = 1;
    defaultCase.updatedAt = defaultCase.createdAt;
    _cases = [defaultCase];
    _activeCaseId = defaultCase.id;
    _persistCases();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  return {

    // Initialization
    init() {
      _loadFromStorage();
      DAG.reset();
      _recompute('rawData');
      console.log(`[State] Initialized. ${_cases.length} case(s). Active: ${_activeCaseId}`);
    },

    // Read
    get computed() { return _computed; },
    get activeCaseId() { return _activeCaseId; },
    get cases() { return [..._cases]; },
    get activeCase() { return _activeCase(); },
    get currentFilter() { return _currentState().filter; },
    get eventMarkers() { return _currentState().eventMarkers || []; },
    get entityEdits() { return _currentState().entityEdits || []; },
    get disabledRules() { return _currentState().disabledRules || []; },
    get notes() { return _currentState().notes || {}; },
    get geminiKey() { return _geminiKey; },
    get replayState() { return { ..._replayState }; },

    // ── Filter actions ──────────────────────────────────────────────────────

    setFilter(patch) {
      _applyAction({ type: Schema.InvestigatorAction.SET_FILTER, payload: patch });
      _recompute('periodFilter');
    },

    setDateRange(from, to) {
      _applyAction({ type: Schema.InvestigatorAction.SET_FILTER, payload: { from, to } });
      _recompute('periodFilter');
    },

    setFY(fy) {
      // fy = "FY2021-22" → Apr 2021 – Mar 2022
      const match = fy.match(/FY(\d{4})-(\d{2})/);
      if (!match) return;
      const startYear = parseInt(match[1]);
      const from = `${startYear}-04-01`;
      const to = `${startYear+1}-03-31`;
      this.setDateRange(from, to);
    },

    clearFilter() {
      _applyAction({ type: Schema.InvestigatorAction.SET_FILTER, payload: Schema.makeDefaultFilter() });
      _recompute('periodFilter');
    },

    setEntityFilter(entityIds) {
      _applyAction({ type: Schema.InvestigatorAction.SET_FILTER, payload: { entityIds } });
      _recompute('entityFilter');
    },

    setSearchText(text) {
      _applyAction({ type: Schema.InvestigatorAction.SET_FILTER, payload: { searchText: text } });
      _recompute('entityFilter');
    },

    // ── Entity actions ───────────────────────────────────────────────────────

    mergeEntity(sourceEntityId, targetEntityId) {
      _applyAction({ type: Schema.InvestigatorAction.MERGE_ENTITY, sourceEntityId, targetEntityId });
      _recompute('entityEdits');
      EventBus.emit('entityMerged', { sourceEntityId, targetEntityId });
    },

    renameEntity(entityId, newName) {
      _applyAction({ type: Schema.InvestigatorAction.RENAME_ENTITY, entityId, newName });
      _recompute('entityEdits');
    },

    // ── Event markers ────────────────────────────────────────────────────────

    addMarker(marker) {
      const m = Schema.makeEventMarker({
        ...marker,
        id: marker.id || `MRK-${Date.now()}`,
        date: typeof marker.date === 'string' ? new Date(marker.date) : marker.date,
      });
      _applyAction({ type: Schema.InvestigatorAction.CREATE_MARKER, marker: m });
      EventBus.emit('markerAdded', m);
      // Don't recompute — markers don't affect financial calculations
    },

    removeMarker(markerId) {
      _applyAction({ type: 'DeleteMarker', markerId });
      EventBus.emit('markerRemoved', markerId);
    },

    // ── Notes ────────────────────────────────────────────────────────────────

    addNote(targetId, note) {
      _applyAction({ type: Schema.InvestigatorAction.ADD_NOTE, targetId, note });
      // Notes don't require recompute
    },

    // ── Rules ────────────────────────────────────────────────────────────────

    disableRule(ruleId) {
      _applyAction({ type: Schema.InvestigatorAction.DISABLE_RULE, ruleId });
      _recompute('rules');
    },

    enableRule(ruleId) {
      _applyAction({ type: Schema.InvestigatorAction.ENABLE_RULE, ruleId });
      _recompute('rules');
    },

    // ── Hypotheses ───────────────────────────────────────────────────────────

    setHypothesis(hypothesis) {
      _applyAction({ type: Schema.InvestigatorAction.SET_HYPOTHESIS, hypothesis });
      if (hypothesis && _computed) {
        const result = Engine.hypothesisTester(_computed.transactions, hypothesis, DEFAULT_RULES);
        EventBus.emit('hypothesisResult', result);
      }
    },

    // ── Case management ──────────────────────────────────────────────────────

    createCase(name, description = '') {
      const newCase = Schema.makeCase({
        id: `CASE-${Date.now()}`,
        name,
        description,
        subjectId: 'SUBJECT',
        createdAt: new Date().toISOString(),
      });
      newCase.version = 1;
      newCase.updatedAt = newCase.createdAt;
      _cases.push(newCase);
      _persistCases();
      return newCase.id;
    },

    switchCase(caseId) {
      if (!_cases.find(c => c.id === caseId)) return;
      _activeCaseId = caseId;
      Storage.set('activeCaseId', caseId);
      DAG.reset();
      _recompute('rawData');
      EventBus.emit('caseSwitched', caseId);
    },

    // ── Snapshots ────────────────────────────────────────────────────────────

    createSnapshot(label, notes = '') {
      const c = _activeCase();
      if (!c) return null;
      const snap = Schema.makeSnapshot({
        id: `SNAP-${Date.now()}`,
        label,
        notes,
        filter: { ..._currentState().filter },
        computed: _computed ? {
          balance: _computed.balance,
          txnCount: _computed.periodTransactions?.length,
          flagCount: _computed.flags?.length,
        } : null,
      });
      if (!c.snapshots) c.snapshots = [];
      c.snapshots.push(snap);
      _persistCases();
      EventBus.emit('snapshotCreated', snap);
      return snap.id;
    },

    restoreSnapshot(snapId) {
      const c = _activeCase();
      const snap = c?.snapshots?.find(s => s.id === snapId);
      if (!snap) return;
      _applyAction({ type: Schema.InvestigatorAction.SET_FILTER, payload: snap.filter });
      _recompute('periodFilter');
    },

    // ── Gemini key ───────────────────────────────────────────────────────────

    setGeminiKey(key) {
      _geminiKey = key;
      Storage.set('geminiKey', key);
      EventBus.emit('geminiKeySet', !!key);
    },

    clearGeminiKey() {
      _geminiKey = null;
      Storage.remove('geminiKey');
    },

    // ── Replay control ───────────────────────────────────────────────────────

    setReplayState(patch) {
      _replayState = { ..._replayState, ...patch };
      EventBus.emit('replayStateChange', _replayState);
    },

    // ── Undo ─────────────────────────────────────────────────────────────────

    undo() {
      const c = _activeCase();
      if (!c || c.actionLog.length === 0) return;
      c.actionLog = c.actionLog.slice(0, -1);
      c.currentState = _replayActions(c.actionLog);
      c.version = Math.max(1, (c.version || 1) - 1);
      _persistCases();
      DAG.reset();
      _recompute('entityEdits');
      EventBus.emit('undone', c.actionLog.length);
    },

    // ── Investigation metrics ─────────────────────────────────────────────────

    getInvestigationMetrics() {
      const c = _activeCase();
      if (!c) return {};
      const state = c.currentState;
      return {
        rulesEnabled: DEFAULT_RULES.length - (state.disabledRules?.length || 0),
        rulesDisabled: state.disabledRules?.length || 0,
        manualMerges: (state.entityEdits || []).filter(e => e.type === 'MergeEntity').length,
        unresolvedEntities: _computed?.dataQuality?.unresolved || 0,
        notesAdded: Object.keys(state.notes || {}).length,
        hypotheses: (c.hypotheses || []).length,
        snapshots: (c.snapshots || []).length,
        eventMarkers: (state.eventMarkers || []).length,
        actionLogLength: c.actionLog.length,
        version: c.version || 1,
      };
    },

    // ── Export case package ───────────────────────────────────────────────────

    exportCase() {
      const c = _activeCase();
      return {
        case: c,
        computed: _computed ? {
          balance: _computed.balance,
          cash: _computed.cash,
          flags: _computed.flags,
          scores: _computed.scores,
          stories: _computed.stories,
          dataQuality: _computed.dataQuality,
        } : null,
        exportedAt: new Date().toISOString(),
        engineVersion: Engine.VERSION,
      };
    },

    // ── Subscribe to state changes ────────────────────────────────────────────

    on: EventBus.on.bind(EventBus),
    emit: EventBus.emit.bind(EventBus),
  };

})();

if (typeof module !== 'undefined') module.exports = { State, EventBus, Storage, DAG };
if (typeof window !== 'undefined') { window.State = State; window.EventBus = EventBus; }
