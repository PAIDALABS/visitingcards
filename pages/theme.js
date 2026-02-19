/* CardFlow Theme Toggle — persist, detect, sync meta */
(function () {
  var KEY = 'cardflow-theme';
  var root = document.documentElement;

  function getPreferred() {
    var saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  function apply(theme) {
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    /* Update meta theme-color */
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F1117' : '#FAFBFC');
  }

  /* Apply on load (supplements the inline anti-flash script) */
  apply(getPreferred());

  /* Public API */
  window.toggleTheme = function () {
    var current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };

  window.getTheme = function () {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  };

  /* Listen for OS preference changes (only if no explicit preference saved) */
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (!localStorage.getItem(KEY)) {
        apply(e.matches ? 'dark' : 'light');
      }
    });
  }
})();
