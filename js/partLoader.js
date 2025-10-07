// js/partloader.js
(function () {
  // -- figure out BASE (can be overridden with data-root on the <script>)
  const scriptEl = document.currentScript;
  const dataRoot = scriptEl?.dataset?.root; // e.g. "." or "/<repo>"
  const inferredBase = (() => {
    try {
      const src = scriptEl?.src || '';
      // directory of this script, then go up into the repo root (remove "js/…")
      if (src.includes('/js/')) {
        return src.replace(/\/js\/[^\/?#]+(?:[?#].*)?$/, '/');
      }
    } catch (_) {}
    // fallback for local file paths
    return location.pathname.includes('/archive/') ? '../' : './';
  })();

  // If data-root provided, normalize it to end with "/"
  let BASE = (dataRoot || inferredBase);
  if (!BASE.endsWith('/')) BASE += '/';

  // ---------- rewrite helpers ----------
  // NOTE: We do NOT treat a leading "/" as absolute here; we rewrite it to repo base.
  function isTrulyAbsolute(url) {
    return /^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('#');
  }

  function prefix(url) {
    if (!url) return url;

    if (isTrulyAbsolute(url)) return url;     // http(s)://, //, data:, #

    if (url.startsWith('/')) {                // site-root relative → rewrite to repo base
      return BASE + url.slice(1);
    }
    if (url.startsWith('../')) return url;    // keep higher-level relatives intact
    if (url.startsWith('./'))  return BASE + url.slice(2);

    // plain relative like "images/a.jpg" or "components/x.html"
    return BASE + url;
  }

  function rewriteSrcSet(val) {
    if (!val) return val;
    return val
      .split(',')
      .map(part => {
        const [u, d] = part.trim().split(/\s+/, 2);
        return [prefix(u), d].filter(Boolean).join(' ');
      })
      .join(', ');
  }

  function rewriteHtml(htmlString) {
    const tpl = document.createElement('template');
    tpl.innerHTML = htmlString;

    const ATTRS = ['src', 'href', 'poster'];
    tpl.content.querySelectorAll('*').forEach(el => {
      ATTRS.forEach(a => {
        if (el.hasAttribute(a)) {
          el.setAttribute(a, prefix(el.getAttribute(a)));
        }
      });
      if (el.hasAttribute('srcset')) {
        el.setAttribute('srcset', rewriteSrcSet(el.getAttribute('srcset')));
      }
      const style = el.getAttribute?.('style');
      if (style && style.includes('url(')) {
        el.setAttribute('style', style.replace(/url\((['"]?)(.+?)\1\)/g, (_m, q, u) => `url(${q}${prefix(u)}${q})`));
      }
    });

    return tpl.innerHTML;
  }

  // ---------- NAV ----------
  if (!document.querySelector('#navWrapper')) {
    $.get(prefix('components/navigation.html'), function (data) {
      $("#navigation").replaceWith(rewriteHtml(data));
      console.log("Navigation loaded");
    }).fail(function (xhr) {
      console.warn('Navigation load failed:', xhr.status, xhr.statusText);
    });
  }

  // ---------- ARCHIVE MENU ----------
  if (!document.querySelector('#archivemenu')) {
    $.get(prefix('components/archivemenu.html'), function (data) {
      $("#archivemenu").replaceWith(rewriteHtml(data));
      console.log("Archivemenu loaded");
    }).fail(function (xhr) {
      console.warn('Archivemenu load failed:', xhr.status, xhr.statusText);
    });
  }
})();
