(function () {
  // Determine base prefix (works both at / and /archive/)
  const BASE = (function () {
    try {
      const s = document.currentScript?.src || '';
      if (s.includes('/js/')) return s.replace(/\/js\/[^\/?#]+(?:[?#].*)?$/, '/');
    } catch (_) {}
    return location.pathname.includes('/archive/') ? '../' : './';
  })();

  // --- rewrite helpers: prefix relative URLs inside fetched HTML ---
  function isAbsolute(url) {
    return /^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('/') || url.startsWith('data:') || url.startsWith('#');
  }
  function prefix(url) {
    if (!url) return url;
    if (isAbsolute(url) || url.startsWith('../')) return url; // leave alone
    if (url.startsWith('./')) return BASE + url.slice(2);
    return BASE + url; // e.g. "images/a.jpg" -> "../images/a.jpg" on archive pages
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

    // Elements with URL-like attributes we care about
    const ATTRS = ['src', 'href', 'poster'];
    tpl.content.querySelectorAll('*').forEach(el => {
      // src/href/poster
      ATTRS.forEach(a => {
        if (el.hasAttribute(a)) el.setAttribute(a, prefix(el.getAttribute(a)));
      });
      // srcset
      if (el.hasAttribute('srcset')) {
        el.setAttribute('srcset', rewriteSrcSet(el.getAttribute('srcset')));
      }
      // optional: inline style url(...)
      const style = el.getAttribute?.('style');
      if (style && style.includes('url(')) {
        el.setAttribute('style', style.replace(/url\((['"]?)(.+?)\1\)/g, (_m, q, u) => `url(${q}${prefix(u)}${q})`));
      }
    });

    return tpl.innerHTML;
  }

  // === NAV === (same logic as yours)
  if (!document.querySelector('#navWrapper')) {
    $.get(BASE + "components/navigation.html", function (data) {
      const html = rewriteHtml(data);
      $("#navigation").replaceWith(html);
      console.log("Navigation loaded");
    }).fail(function (xhr) {
      console.warn('Navigation load failed:', xhr.status, xhr.statusText);
    });
  }

  // === ARCHIVE MENU === (same logic as yours)
  if (!document.querySelector('#archivemenu')) {
    $.get(BASE + "components/archivemenu.html", function (data) {
      const html = rewriteHtml(data);
      $("#archivemenu").replaceWith(html);
      console.log("Archivemenu loaded");
    }).fail(function (xhr) {
      console.warn('Archivemenu load failed:', xhr.status, xhr.statusText);
    });
  }
})();
