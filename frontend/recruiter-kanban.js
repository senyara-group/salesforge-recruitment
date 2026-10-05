/* Deterministic, immutable card operations shared by the UI and its tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RecruiterKanban = api;
})(typeof window !== 'undefined' ? window : this, function () {
  function compare(a, b) {
    const at = a.created_at ? Date.parse(a.created_at) : null;
    const bt = b.created_at ? Date.parse(b.created_at) : null;
    if (at !== bt) return at == null ? 1 : bt == null ? -1 : bt - at;
    return String(b.id).localeCompare(String(a.id));
  }
  function find(state, id) {
    for (const [stage, cards] of Object.entries(state)) {
      const card = cards.find((item) => String(item.id) === String(id));
      if (card) return { stage, card };
    }
    return null;
  }
  function put(state, stage, card) {
    const next = Object.fromEntries(Object.entries(state).map(([key, cards]) =>
      [key, cards.filter((item) => String(item.id) !== String(card.id))]));
    next[stage] = [...next[stage], card].sort(compare);
    return next;
  }
  function merge(state, page) {
    let next = state;
    for (const stage of Object.keys(state)) {
      for (const card of page[stage] || []) next = put(next, stage, card);
    }
    return next;
  }
  function countsAfter(counts, from, to) {
    if (!counts || from === to) return counts;
    return { ...counts, [from]: counts[from] - 1, [to]: counts[to] + 1 };
  }
  // One write per card; different cards can complete in any order. Rollback
  // restores only this card, never a whole snapshot which would undo another move.
  function createWriter({ getState, setState, getCounts, setCounts, request, changed }) {
    const pending = new Map();
    function move(id, status) {
      if (pending.has(String(id))) return pending.get(String(id));
      const original = find(getState(), id);
      const target = original?.card.moves?.find((item) => item.statut === status);
      if (!target) return Promise.reject(new Error('Transition impossible'));
      const promise = Promise.resolve().then(async () => {
        setState(put(getState(), target.stage, { ...original.card, statut: status }));
        setCounts(countsAfter(getCounts(), original.stage, target.stage));
        changed();
        try {
          const result = await request(id, status, original.card.statut);
          setState(put(getState(), target.stage, { ...original.card, ...result }));
          return result;
        } catch (error) {
          setState(put(getState(), original.stage, original.card));
          setCounts(countsAfter(getCounts(), target.stage, original.stage));
          throw error;
        } finally {
          pending.delete(String(id));
          changed();
        }
      });
      pending.set(String(id), promise);
      return promise;
    }
    async function idle() {
      while (pending.size) await Promise.allSettled([...pending.values()]);
    }
    return { move, idle, pending };
  }
  return { compare, find, put, merge, countsAfter, createWriter };
});
