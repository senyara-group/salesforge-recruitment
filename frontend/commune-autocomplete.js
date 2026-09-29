/*
 * Autocomplétion de communes partagée (geo.api.gouv.fr) — Lot 6.
 * Utilisée par : lieu d'offre (création/édition), ville du profil candidat, filtre
 * localisation Opportunités, filtre localisation Sourcing.
 *
 * Contrat :
 * - suggestions « Nom (département) », valeur insérée = nom de la commune (même
 *   format que les offres historiques) ;
 * - la saisie libre reste possible : une suggestion améliore et homogénéise la
 *   valeur, elle n'est jamais imposée (sauf si l'appelant l'exige, ex. offre ; il
 *   fournit alors ses propres messages via `statusMessages`) ;
 * - ARIA combobox / listbox, clavier ↑ ↓ Entrée Échap Tab, clic extérieur ;
 * - debounce, cache par requête, AbortController + numéro de séquence : une
 *   réponse obsolète arrivant en retard n'écrase jamais la plus récente ;
 * - une fermeture explicite (Échap, Tab, clic extérieur, sélection, fermeture du
 *   contexte) annule la recherche en cours : une réponse tardive ne rouvre jamais
 *   la liste, ni un champ qui n'a plus le focus ;
 * - erreur réseau / API non bloquante (message discret).
 */
(function (root) {
  'use strict';

  var API_URL = 'https://geo.api.gouv.fr/communes';
  var MIN_CHARS = 2;
  var DEBOUNCE_MS = 250;
  var LIMIT = 8;
  // Messages par défaut : champs à saisie libre (profil, filtres).
  var STATUS = {
    loading: 'Recherche des communes…',
    empty: 'Aucune commune trouvée : le texte saisi sera utilisé tel quel.',
    error: 'Suggestions indisponibles : vous pouvez saisir la localisation librement.',
  };
  var instanceCount = 0;

  function buildUrl(query) {
    return API_URL + '?nom=' + encodeURIComponent(query) + '&fields=nom,codeDepartement&boost=population&limit=' + LIMIT;
  }

  /** Réponse API → [{ label, value }] ; entrées invalides ignorées, doublons retirés. */
  function communeSuggestions(data) {
    if (!Array.isArray(data)) return [];
    var seen = {};
    var out = [];
    data.forEach(function (commune) {
      if (!commune || typeof commune.nom !== 'string' || !commune.nom.trim()) return;
      var name = commune.nom.trim();
      var dept = typeof commune.codeDepartement === 'string' && commune.codeDepartement ? commune.codeDepartement : '';
      var label = dept ? name + ' (' + dept + ')' : name;
      if (seen[label]) return;
      seen[label] = true;
      out.push({ label: label, value: name });
    });
    return out;
  }

  /**
   * options : listId, statusId, statusMessages { loading, empty, error } (remplace les
   * messages par défaut pour cette instance), extraItems(query) → [{label,value}],
   * shouldFetch(query), onInput(), onSelect(item), openOnFocus, revealList,
   * context (élément conteneur, ex. overlay de filtres : quand il perd la classe
   * `on`, l'instance est fermée et réinitialisée), doc, fetchImpl, setTimeoutImpl,
   * clearTimeoutImpl, MutationObserverImpl.
   */
  function attach(input, options) {
    options = options || {};
    var doc = options.doc || root.document;
    var fetchImpl = options.fetchImpl || (root.fetch ? root.fetch.bind(root) : null);
    var later = options.setTimeoutImpl || root.setTimeout.bind(root);
    var cancel = options.clearTimeoutImpl || root.clearTimeout.bind(root);
    var extraItems = options.extraItems || function () { return []; };
    var shouldFetch = options.shouldFetch || function (query) { return query.length >= MIN_CHARS; };
    var messages = {};
    Object.keys(STATUS).forEach(function (key) {
      var custom = options.statusMessages && options.statusMessages[key];
      messages[key] = typeof custom === 'string' && custom ? custom : STATUS[key];
    });
    var list = options.listId ? doc.getElementById(options.listId) : null;
    var status = options.statusId ? doc.getElementById(options.statusId) : null;
    if (!input || !list) throw new Error('commune-autocomplete : champ ou liste introuvable');

    instanceCount += 1;
    var baseId = list.id || 'commune-list-' + instanceCount;
    list.id = baseId;
    var items = [];
    var active = -1;
    var timer = null;
    var seq = 0;
    var controller = null;
    var cache = {};

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', baseId);
    input.setAttribute('autocomplete', 'off');
    list.setAttribute('role', 'listbox');
    if (status) {
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
    }

    function setStatus(kind) {
      if (!status) return;
      status.textContent = kind ? messages[kind] : '';
      status.hidden = !kind;
    }
    function optionId(index) { return baseId + '-opt-' + index; }
    function isOpen() { return list.classList.contains('on'); }
    // Sans document réel (tests), activeElement peut être absent : on ne bloque pas.
    function hasFocus() { return !doc.activeElement || doc.activeElement === input; }

    /** Annule debounce + requête en vol : toute réponse encore attendue devient obsolète. */
    function cancelPending() {
      if (timer) { cancel(timer); timer = null; }
      seq += 1;
      if (controller) { controller.abort(); controller = null; }
    }

    function close() {
      list.classList.remove('on');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }

    /** Fermeture demandée (utilisateur ou contexte) : rien ne doit rouvrir la liste ensuite. */
    function dismiss() {
      cancelPending();
      if (status && !status.hidden && status.textContent === messages.loading) setStatus(null);
      close();
    }

    /** Remise à zéro complète (contexte fermé) : pas de suggestion périmée à la réouverture. */
    function reset() {
      dismiss();
      setStatus(null);
      items = [];
      while (list.firstChild) list.removeChild(list.firstChild);
      list.scrollTop = 0;
    }

    function highlight(index) {
      active = index;
      list.childNodes.forEach(function (node, i) {
        var on = i === index;
        node.classList.toggle('active', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (index >= 0) {
        input.setAttribute('aria-activedescendant', optionId(index));
        var node = list.childNodes[index];
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function render(next) {
      items = next;
      while (list.firstChild) list.removeChild(list.firstChild);
      items.forEach(function (item, index) {
        var option = doc.createElement('div');
        option.className = 'autocomplete-item' + (item.special ? ' remote' : '');
        option.id = optionId(index);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.textContent = item.label;
        // mousedown (et non click) : la sélection précède la perte de focus du champ.
        option.addEventListener('mousedown', function (event) {
          event.preventDefault();
          select(index);
        });
        list.appendChild(option);
      });
      // Nouveau rendu : on repart du haut (les premières suggestions sont les plus pertinentes).
      list.scrollTop = 0;
      active = -1;
      input.removeAttribute('aria-activedescendant');
      if (items.length) {
        list.classList.add('on');
        input.setAttribute('aria-expanded', 'true');
        if (list.scrollIntoView && options.revealList) list.scrollIntoView({ block: 'nearest' });
      } else {
        close();
      }
    }

    function select(index) {
      var item = items[index];
      if (!item) return;
      input.value = item.value;
      dismiss();
      setStatus(null);
      if (options.onSelect) options.onSelect(item);
    }

    function search(rawQuery) {
      var query = String(rawQuery || '').trim();
      var extras = extraItems(query) || [];
      if (!shouldFetch(query) || !fetchImpl) {
        cancelPending(); // toute réponse encore en vol devient obsolète
        setStatus(null);
        render(extras);
        return Promise.resolve(extras);
      }
      if (cache[query]) {
        cancelPending();
        setStatus(cache[query].length ? null : 'empty');
        render(extras.concat(cache[query]));
        return Promise.resolve(items);
      }
      cancelPending();
      var mySeq = seq;
      controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      var signal = controller ? controller.signal : null;
      setStatus('loading');
      return Promise.resolve()
        .then(function () { return fetchImpl(buildUrl(query), signal ? { signal: signal } : undefined); })
        .then(function (response) {
          if (!response || !response.ok) throw new Error('geo api ' + (response && response.status));
          return response.json();
        })
        .then(function (data) {
          var communes = communeSuggestions(data);
          if (mySeq !== seq) return items; // réponse obsolète ou liste fermée entre-temps : ignorée
          cache[query] = communes;
          if (!hasFocus()) { setStatus(null); return items; } // l'utilisateur a quitté le champ
          setStatus(communes.length ? null : 'empty');
          render(extras.concat(communes));
          return items;
        })
        .catch(function (error) {
          if (mySeq !== seq || (error && error.name === 'AbortError')) return items;
          if (!hasFocus()) { setStatus(null); return items; }
          setStatus('error');
          render(extras);
          return items;
        });
    }

    function schedule() {
      if (timer) cancel(timer);
      var value = input.value;
      if (!String(value).trim()) {
        cancelPending();
        setStatus(null);
        render(extraItems(''));
        return;
      }
      timer = later(function () { timer = null; search(value); }, DEBOUNCE_MS);
    }

    function onKeydown(event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!isOpen()) {
          if (items.length) render(items);
          else return;
        }
        event.preventDefault();
        var step = event.key === 'ArrowDown' ? 1 : -1;
        var next = active + step;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        highlight(next);
      } else if (event.key === 'Enter') {
        if (isOpen() && active >= 0) {
          event.preventDefault();
          select(active);
        }
      } else if (event.key === 'Escape') {
        // Échap annule aussi une recherche en cours, même si la liste n'est pas encore ouverte.
        if (isOpen()) event.preventDefault();
        dismiss();
      } else if (event.key === 'Tab') {
        dismiss();
      }
    }

    function onInput() {
      // L'ancienne saisie devient obsolète immédiatement, avant le prochain debounce.
      reset();
      if (options.onInput) options.onInput();
      schedule();
    }
    function onFocus() {
      if (options.openOnFocus) schedule();
    }
    function onOutside(event) {
      var target = event.target;
      if (target === input || (list.contains && list.contains(target))) return;
      if (isOpen() || timer || controller) dismiss();
    }

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
    input.addEventListener('focus', onFocus);
    doc.addEventListener('mousedown', onOutside);

    // Contexte (overlay de filtres) : quel que soit le chemin de fermeture (fond,
    // Appliquer, Réinitialiser…), la perte de la classe `on` réinitialise l'instance.
    var observer = null;
    var Observer = options.MutationObserverImpl || root.MutationObserver;
    if (options.context && typeof Observer === 'function') {
      var wasOpen = options.context.classList.contains('on');
      observer = new Observer(function () {
        var open = options.context.classList.contains('on');
        if (wasOpen && !open) reset();
        wasOpen = open;
      });
      observer.observe(options.context, { attributes: true, attributeFilter: ['class'] });
    }

    return {
      search: search,
      close: dismiss,
      reset: reset,
      isOpen: isOpen,
      items: function () { return items.slice(); },
      destroy: function () {
        input.removeEventListener('input', onInput);
        input.removeEventListener('keydown', onKeydown);
        input.removeEventListener('focus', onFocus);
        doc.removeEventListener('mousedown', onOutside);
        if (observer) observer.disconnect();
        cancelPending();
      },
    };
  }

  var api = { attach: attach, communeSuggestions: communeSuggestions, buildUrl: buildUrl, MIN_CHARS: MIN_CHARS, DEBOUNCE_MS: DEBOUNCE_MS, STATUS: STATUS };
  root.SwipCommuneAutocomplete = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
