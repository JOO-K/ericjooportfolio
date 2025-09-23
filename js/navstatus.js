// navstatus.js — LA clock (12h with AM/PM + tenths) + OpenWeather (text only)
(() => {
  // ===== CONFIG =====
  const CONTAINER_ID   = 'nav-status';
  const WEATHER_KEY    = window.OPENWEATHER_KEY || 'fd582057b6c16f5f503ac7985fbf94c7';
  const UNITS          = 'imperial';                  // 'imperial' | 'metric' | 'standard'
  const TIMEZONE       = 'America/Los_Angeles';
  const USE_LATLON     = true;                        // more reliable
  const LAT            = 34.0522;
  const LON            = -118.2437;
  const QUERY_FALLBACK = 'Los Angeles,US';
  const REFRESH_MS     = 10 * 60 * 1000;              // 10 min

  // ===== DOM =====
  const host = document.getElementById(CONTAINER_ID);
  if (!host) { console.warn(`[navstatus] #${CONTAINER_ID} not found`); return; }

  Object.assign(host.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
    fontSize: '12px',
    lineHeight: '1',
    color: '#e6e8f0',
    whiteSpace: 'nowrap'
  });

  const clockEl = document.createElement('span');

  // separator that won't react to hover styles
  const sepEl = document.createElement('span');
  sepEl.textContent = '·';
  Object.assign(sepEl.style, {
    color: '#8a90a2',
    opacity: '0.8',
    pointerEvents: 'none',
    userSelect: 'none',
    transition: 'none'
  });

  const weatherEl = document.createElement('span');

  // assemble (no icon!)
  host.replaceChildren(clockEl, sepEl, weatherEl);

  // ===== CLOCK: 12h + AM/PM + tenths =====
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour12: true,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  function renderClock() {
    const now = Date.now();
    const parts = dtf.formatToParts(now);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const tenths = Math.floor((now % 1000) / 100);
    const ampm = (map.dayPeriod || '').toUpperCase();
    clockEl.textContent = `${map.hour}:${map.minute}:${map.second}.${tenths} ${ampm}`;
  }
  renderClock();
  const clockTimer = setInterval(renderClock, 100);

  // after you create `clockEl`, add:
const labelEl = document.createElement('span');
labelEl.textContent = 'LA';
Object.assign(labelEl.style, {
  letterSpacing: '0.08em',
  opacity: '0.9',
  pointerEvents: 'none',
  userSelect: 'none'
});

// ...and change the assembly line from:
host.replaceChildren(clockEl, sepEl, weatherEl);

// ...to:
host.replaceChildren(labelEl, clockEl, sepEl, weatherEl);

  // ===== WEATHER (text only) =====
  const unitsSuffix = UNITS === 'metric' ? 'C' : UNITS === 'imperial' ? 'F' : 'K';
async function fetchWeather() {
  try {
    if (!WEATHER_KEY || WEATHER_KEY === 'YOUR_OPENWEATHER_KEY') {
      weatherEl.textContent = 'set OPENWEATHER key';
      return;
    }

    const url = new URL('https://api.openweathermap.org/data/2.5/weather');
    if (USE_LATLON) {
      url.searchParams.set('lat', String(LAT));
      url.searchParams.set('lon', String(LON));
    } else {
      url.searchParams.set('q', QUERY_FALLBACK);
    }
    url.searchParams.set('units', UNITS);
    url.searchParams.set('appid', WEATHER_KEY);

    weatherEl.textContent = '…';
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const wx   = (data.weather && data.weather[0]) || {};
    const temp = Math.round(data.main?.temp);

    // ↓↓↓ filter out the word "clear" from the description ↓↓↓
    let desc = (wx.main || wx.description || '').toLowerCase();
    desc = desc.replace(/\bclear\b/gi, '').trim();

    weatherEl.textContent = `${temp}°${unitsSuffix}${desc ? ' ' + desc : ''}`;
  } catch (err) {
    console.warn('[navstatus] weather error:', err);
    weatherEl.textContent = '—';
  }
}


  fetchWeather();
  const weatherTimer = setInterval(fetchWeather, REFRESH_MS);

  // cleanup if host removed
  const mo = new MutationObserver(() => {
    if (!document.body.contains(host)) {
      clearInterval(clockTimer);
      clearInterval(weatherTimer);
      mo.disconnect();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();
