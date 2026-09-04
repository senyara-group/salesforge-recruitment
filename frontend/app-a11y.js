/* Progressive accessibility helpers for the product UI. No business state is changed. */
(function () {
  'use strict';

  function labelControls(root) {
    root.querySelectorAll('input, select, textarea').forEach(function (control) {
      if (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
      if (control.id && root.querySelector('label[for="' + CSS.escape(control.id) + '"]')) return;
      var hint = control.getAttribute('placeholder') || control.getAttribute('name') || control.id;
      if (hint) control.setAttribute('aria-label', hint.replace(/[-_]/g, ' '));
    });

    root.querySelectorAll('button').forEach(function (button) {
      if (button.hasAttribute('aria-label') || button.textContent.trim()) return;
      var title = button.getAttribute('title');
      var svgTitle = button.querySelector('svg title');
      button.setAttribute('aria-label', title || (svgTitle && svgTitle.textContent) || 'Action');
    });
  }

  function enhanceInteractiveElements(root) {
    root.querySelectorAll('[onclick]:not(button):not(a):not(input):not(select):not(textarea)').forEach(function (element) {
      if (!element.hasAttribute('tabindex')) element.tabIndex = 0;
      if (!element.hasAttribute('role')) element.setAttribute('role', 'button');
      element.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        element.click();
      });
    });
  }

  function enhanceStatus(root) {
    root.querySelectorAll('.err, .msg.error').forEach(function (node) {
      node.setAttribute('role', 'alert');
      node.setAttribute('aria-live', 'assertive');
    });
    root.querySelectorAll('.msg.success, .toast, .loading-state, .empty-state').forEach(function (node) {
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
    });
    root.querySelectorAll('.spinner').forEach(function (node) {
      node.setAttribute('aria-hidden', 'true');
    });
  }

  function enhance(root) {
    labelControls(root);
    enhanceInteractiveElements(root);
    enhanceStatus(root);
  }

  function init() {
    enhance(document);
    var desktop = window.matchMedia('(min-width: 1024px)');
    var resetTransientNavigation = function () {
      var focusedPanel = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('.notif-panel.on')
        : null;
      document.querySelectorAll('.notif-panel.on, .autocomplete-list.on').forEach(function (node) {
        node.classList.remove('on');
      });
      document.documentElement.classList.remove('menu-open');
      document.body.classList.remove('menu-open', 'nav-open');
      document.documentElement.style.removeProperty('overflow');
      document.body.style.removeProperty('overflow');
      if (focusedPanel) {
        var wrapper = focusedPanel.closest('.notif-wrap');
        var trigger = wrapper && wrapper.querySelector('[onclick]');
        if (trigger) trigger.focus({ preventScroll: true });
      }
    };
    if (desktop.addEventListener) desktop.addEventListener('change', resetTransientNavigation);
    else desktop.addListener(resetTransientNavigation);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) enhance(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
