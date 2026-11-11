/**
 * dsh-stock-strip — client half (Web UI).
 *
 * One thin bar pinned to the bottom edge of the window. Each watchlist symbol
 * shows `name  price  ▲+1.23%`; symbols with a configured position also carry
 * their unrealized P&L, and a fixed summary cell on the left totals every
 * position per currency. No charts, no detail popups.
 *
 * Quotes come from Eastmoney's public JSON endpoint (CORS-permissive, key-free,
 * UTF-8). If that request fails for any reason the strip retries the same codes
 * through Tencent's GBK script endpoint (loaded as a classic <script>, so no CORS
 * involved). If both fail the strip keeps the last snapshot and says so.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stock-strip',
  factory() {
    'use strict';

    const STORAGE_KEY = 'dsh-stock-strip/v1';
    const STRIP_HEIGHT = 26;
    /* Two-row mode: same bar, twice as tall, every cell gets half the row. */
    const STRIP_HEIGHT_TWO = STRIP_HEIGHT * 2;
    /* Bar height plus its 1px top border — the space the bar actually occupies. */
    const STRIP_RESERVE = STRIP_HEIGHT + 1;
    const MAX_SYMBOLS = 12;
    const MAX_DISPLAY = 18;
    const MAX_POSITIONS = 20;
    const DEFAULTS = {
      codes: ['sh000001', 'sh600519', 'sz300750', 'hk00700'],
      interval: 10,
      positions: [],
      onlyPositions: true,
      rows: 'auto',
      showSummary: true,
      fields: {
        price: false,
        change: false,
        changeAmount: false,
        amount: false,
        turnover: false,
        totalPnl: true,
        totalPct: true,
        dayPnl: false,
        marketValue: false,
        costPrice: false,
        shares: false,
      },
    };

    const CURRENCY_SIGN = { CNY: '¥', HKD: 'HK$', USD: '$' };
    /* Every switchable column, in render order. */
    const FIELD_KEYS = [
      'price',
      'change',
      'changeAmount',
      'amount',
      'turnover',
      'totalPnl',
      'totalPct',
      'dayPnl',
      'marketValue',
      'costPrice',
      'shares',
    ];

    /* ------------------------------------------------------------------ */
    /* preferences                                                         */
    /* ------------------------------------------------------------------ */

    function clampInterval(value) {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return DEFAULTS.interval;
      return Math.min(120, Math.max(5, n));
    }

    function normalisePositions(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const code = typeof entry.code === 'string' ? entry.code.trim() : '';
        const shares = Number(entry.shares);
        const cost = Number(entry.cost);
        if (!code || !(shares > 0) || !(cost > 0)) continue;
        out.push({ code, shares, cost });
        if (out.length >= MAX_POSITIONS) break;
      }
      return out;
    }

    /** Field switches; falls back to the old density presets for stale configs. */
    function normaliseFields(parsed) {
      const fields = { ...DEFAULTS.fields };
      const stored = parsed && parsed.fields;
      if (stored && typeof stored === 'object') {
        for (const key of FIELD_KEYS) {
          if (typeof stored[key] === 'boolean') fields[key] = stored[key];
        }
        return fields;
      }
      const density = parsed && parsed.density;
      const showPct = !parsed || parsed.showPct !== false;
      fields.price = density === 'full';
      fields.change = density === 'full';
      fields.totalPnl = density !== 'minimal' || !showPct;
      fields.totalPct = showPct && density !== 'minimal';
      return fields;
    }

    function readFieldBoxes(container) {
      const fields = {};
      for (const key of FIELD_KEYS) fields[key] = false;
      for (const box of container.querySelectorAll('input[data-field]')) {
        if (box.checked) fields[box.dataset.field] = true;
      }
      return fields;
    }

    function readPrefs() {
      const fallback = {
        codes: DEFAULTS.codes.slice(),
        interval: DEFAULTS.interval,
        positions: [],
        onlyPositions: DEFAULTS.onlyPositions,
        rows: DEFAULTS.rows,
        showSummary: DEFAULTS.showSummary,
        fields: { ...DEFAULTS.fields },
      };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const codes = Array.isArray(parsed.codes)
          ? parsed.codes.filter((code) => typeof code === 'string' && code.trim())
          : fallback.codes;
        return {
          codes: codes.length ? codes : fallback.codes,
          interval: clampInterval(parsed.interval),
          positions: normalisePositions(parsed.positions),
          onlyPositions: parsed.onlyPositions !== false,
          rows: parsed.rows === 1 || parsed.rows === 2 ? parsed.rows : 'auto',
          showSummary: parsed.showSummary !== false,
          fields: normaliseFields(parsed),
        };
      } catch {
        return fallback;
      }
    }

    function writePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch {
        /* private mode / quota — the in-memory copy still works */
      }
    }

    /* ------------------------------------------------------------------ */
    /* symbol normalisation                                                */
    /* ------------------------------------------------------------------ */

    function padHk(code) {
      return code.length >= 5 ? code : code.padStart(5, '0');
    }

    /** Build a symbol from a Tencent-style market prefix plus a bare code. */
    function fromMarket(market, code) {
      switch (market) {
        case 'sh':
          return { key: '1.' + code, secid: '1.' + code, alts: [], tencent: 'sh' + code, label: code };
        case 'sz':
          return { key: '0.' + code, secid: '0.' + code, alts: [], tencent: 'sz' + code, label: code };
        case 'bj':
          return { key: '0.' + code, secid: '0.' + code, alts: [], tencent: 'bj' + code, label: code };
        case 'hk': {
          const padded = padHk(code);
          return { key: '116.' + padded, secid: '116.' + padded, alts: [], tencent: 'hk' + padded, label: padded };
        }
        case 'us':
          return {
            key: '105.' + code,
            secid: '105.' + code,
            alts: ['106.' + code, '107.' + code],
            tencent: 'us' + code,
            label: code,
          };
        default:
          return null;
      }
    }

    /** Build a symbol from an explicit Eastmoney secid (market.code). */
    function fromSecid(market, code) {
      switch (market) {
        case '1':
          return { key: '1.' + code, secid: '1.' + code, alts: [], tencent: 'sh' + code, label: code };
        case '0':
          return { key: '0.' + code, secid: '0.' + code, alts: [], tencent: 'sz' + code, label: code };
        case '116':
          return {
            key: '116.' + padHk(code),
            secid: '116.' + padHk(code),
            alts: [],
            tencent: 'hk' + padHk(code),
            label: code,
          };
        case '105':
        case '106':
        case '107': {
          const alts = ['105.', '106.', '107.'].filter((prefix) => prefix !== market + '.').map((prefix) => prefix + code);
          return { key: market + '.' + code, secid: market + '.' + code, alts, tencent: 'us' + code, label: code };
        }
        case '90':
          /* Eastmoney board (BKxxxx): no Tencent equivalent. */
          return { key: '90.' + code, secid: '90.' + code, alts: [], tencent: null, label: code };
        default:
          return null;
      }
    }

    /**
     * Accepts `600519`, `sh600519`, `600519.SH`, `00700`, `hk00700`, `AAPL`,
     * `usAAPL`, `1.600519`, `90.BK1036`, `BK1036`.
     */
    function resolveSymbol(raw) {
      const input = String(raw === undefined || raw === null ? '' : raw).trim();
      if (!input) return null;
      const text = input.toLowerCase().replace(/\s+/g, '');

      const explicit = /^(\d{1,3})\.([a-z0-9.]+)$/.exec(text);
      if (explicit) return fromSecid(explicit[1], explicit[2].toUpperCase());

      const prefixed = /^(sh|sz|bj|hk|us)(.+)$/.exec(text);
      if (prefixed) return fromMarket(prefixed[1], prefixed[2].toUpperCase());

      const suffixed = /^(.+?)\.(sh|ss|sz|bj|hk|us|o|n|oq|ny)$/.exec(text);
      if (suffixed) {
        const market = { sh: 'sh', ss: 'sh', sz: 'sz', bj: 'bj', hk: 'hk', us: 'us', o: 'us', n: 'us', oq: 'us', ny: 'us' }[
          suffixed[2]
        ];
        return fromMarket(market, suffixed[1].toUpperCase());
      }

      if (/^bk\d{4}$/.test(text)) return fromSecid('90', text.toUpperCase());
      if (/^\d{6}$/.test(text)) return fromMarket(/^[569]/.test(text) ? 'sh' : 'sz', text);
      if (/^\d{1,5}$/.test(text)) return fromMarket('hk', padHk(text));
      if (/^[a-z]{1,6}$/.test(text)) return fromMarket('us', text.toUpperCase());
      return null;
    }

    function resolveList(codes) {
      const seen = new Set();
      const out = [];
      for (const raw of codes) {
        const symbol = resolveSymbol(raw);
        if (!symbol || seen.has(symbol.key)) continue;
        seen.add(symbol.key);
        out.push(symbol);
        if (out.length >= MAX_SYMBOLS) break;
      }
      return out;
    }

    /** Positions, each carrying the resolved symbol (dropped when unresolvable). */
    function resolvePositions(list) {
      const out = [];
      for (const entry of list) {
        const symbol = resolveSymbol(entry.code);
        if (!symbol) continue;
        out.push({ code: entry.code, shares: entry.shares, cost: entry.cost, symbol });
        if (out.length >= MAX_POSITIONS) break;
      }
      return out;
    }

    /** Watchlist plus any held symbol that is not on it. */
    function displayList(watchSymbols, positions) {
      const out = watchSymbols.slice();
      for (const position of positions) {
        if (out.some((symbol) => symbol.key === position.symbol.key)) continue;
        out.push(position.symbol);
        if (out.length >= MAX_DISPLAY) break;
      }
      return out;
    }

    /** What the bar actually shows: positions only, or positions + the watchlist. */
    function computeDisplay(watchSymbols, positions, onlyPositions) {
      if (!onlyPositions || !positions.length) return displayList(watchSymbols, positions);
      const seen = new Set();
      const out = [];
      for (const position of positions) {
        if (seen.has(position.symbol.key)) continue;
        seen.add(position.symbol.key);
        out.push(position.symbol);
        if (out.length >= MAX_DISPLAY) break;
      }
      return out;
    }

    function currencyOf(symbol) {
      const market = String(symbol.secid).split('.')[0];
      if (market === '116') return 'HKD';
      if (market === '105' || market === '106' || market === '107') return 'USD';
      return 'CNY';
    }

    /* ------------------------------------------------------------------ */
    /* quote sources                                                       */
    /* ------------------------------------------------------------------ */

    function toNumber(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
      if (typeof value === 'string' && value !== '' && value !== '-') return Number.parseFloat(value);
      return NaN;
    }

    /**
     * Split one position row into [code, shares, cost].
     *
     * Whitespace, `、` and full-width `，` are the primary field separators.
     * ASCII commas are ambiguous (field separator vs thousands separator), so
     * they are only used when the primary split does not yield three fields:
     * first as plain field separators, then with `6,200`-style commas removed.
     */
    function splitPositionRow(line) {
      const primary = line.split(/[\s、，]+/).filter(Boolean);
      if (primary.length === 3) return primary;
      const byComma = line.split(',').map((part) => part.trim()).filter(Boolean);
      if (byComma.length === 3) return byComma;
      const ungrouped = line.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
      if (ungrouped !== line) {
        const retry = ungrouped.split(/[\s、，]+/).filter(Boolean);
        if (retry.length === 3) return retry;
      }
      return primary;
    }

    /** Loose numeric field: tolerates ¥ / $ / thousand separators in user input. */
    function parseNumberField(raw) {
      const cleaned = String(raw === undefined || raw === null ? '' : raw).replace(/[^0-9.]/g, '');
      const value = Number(cleaned);
      return Number.isFinite(value) ? value : NaN;
    }

    function withTimeout(promise, ms) {
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('timeout')), ms);
        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          },
        );
      });
    }

    /** Eastmoney batch snapshot, keyed by `<market>.<code>`. */
    async function fetchEastmoney(secids) {
      if (!secids.length) return new Map();
      const url =
        'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f6,f8,f12,f13,f14,f18&secids=' +
        encodeURIComponent(secids.join(',')) +
        '&_=' +
        Date.now();
      const response = await withTimeout(
        window.fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }),
        6000,
      );
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const json = await response.json();
      const rows = (json && json.data && json.data.diff) || [];
      const map = new Map();
      for (const row of rows) {
        const key = String(row.f13) + '.' + String(row.f12).toUpperCase();
        const price = toNumber(row.f2);
        if (!Number.isFinite(price)) continue;
        map.set(key, {
          name: typeof row.f14 === 'string' ? row.f14 : '',
          price,
          pct: toNumber(row.f3),
          change: toNumber(row.f4),
          prevClose: toNumber(row.f18),
          amount: toNumber(row.f6),
          turnover: toNumber(row.f8),
        });
      }
      return map;
    }

    /** One `v_<sym>="…"` payload, split on `~`. */
    function parseTencentRow(raw) {
      const fields = raw.split('~');
      if (fields.length < 33) return null;
      const price = toNumber(fields[3]);
      if (!Number.isFinite(price)) return null;
      const prevClose = toNumber(fields[4]);
      let pct = toNumber(fields[32]);
      if (!Number.isFinite(pct) && Number.isFinite(prevClose) && prevClose > 0) {
        pct = ((price - prevClose) / prevClose) * 100;
      }
      const name = fields[1] ? fields[1] : fields[2] || '';
      return {
        name,
        price,
        pct,
        change: toNumber(fields[31]),
        prevClose,
        amount: NaN,
        turnover: NaN,
      };
    }

    /**
     * Tencent batch through plain fetch.
     *
     * The endpoint answers with GBK-encoded `v_<sym>="…";` assignments, so the
     * bytes are decoded explicitly instead of relying on the document charset.
     * Fetch (not a <script> injection) keeps third-party code out of the page.
     */
    async function fetchTencent(symbols) {
      if (!symbols.length) return new Map();
      const url = 'https://qt.gtimg.cn/q=' + encodeURIComponent(symbols.join(',')) + '&_t=' + Date.now();
      const response = await withTimeout(
        window.fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }),
        6000,
      );
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
      const map = new Map();
      const pattern = /v_([A-Za-z0-9_.]+)="([^"]*)"/g;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const row = parseTencentRow(match[2]);
        if (row) map.set(match[1], row);
      }
      return map;
    }

    /** Every symbol in `list`, best-effort, in one round trip or two. */
    async function fetchQuotes(list) {
      const out = new Map();
      if (!list.length) return out;

      try {
        const primary = await fetchEastmoney(list.map((symbol) => symbol.secid));
        for (const [key, row] of primary) out.set(key, row);
      } catch {
        /* fall through to the alternates and then Tencent */
      }

      const missing = list.filter((symbol) => !out.has(symbol.key));
      const alternating = missing.filter((symbol) => symbol.alts && symbol.alts.length);
      if (alternating.length) {
        try {
          const alternates = await fetchEastmoney(alternating.map((symbol) => symbol.alts[0]));
          for (const symbol of alternating) {
            const row = alternates.get(symbol.alts[0]);
            if (row && !out.has(symbol.key)) out.set(symbol.key, row);
          }
        } catch {
          /* keep going */
        }
      }

      const rest = list.filter((symbol) => !out.has(symbol.key) && symbol.tencent);
      if (rest.length) {
        const rows = await fetchTencent(rest.map((symbol) => symbol.tencent));
        for (const symbol of rest) {
          const row = rows.get(symbol.tencent);
          if (row) out.set(symbol.key, row);
        }
      }
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* formatting                                                          */
    /* ------------------------------------------------------------------ */

    function groupInteger(text) {
      return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatPrice(price) {
      if (!Number.isFinite(price)) return '—';
      return Math.abs(price) >= 1 ? price.toFixed(2) : price.toFixed(3);
    }

    /** Cost as the user typed it: up to 3 decimals, no padding zeros. */
    function formatCost(value) {
      if (!Number.isFinite(value)) return '—';
      return String(Number(value.toFixed(3)));
    }

    function formatPct(pct) {
      if (!Number.isFinite(pct)) return '';
      const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
      return sign + Math.abs(pct).toFixed(2) + '%';
    }

    /** Strip-level percentage, two decimals — rounding it would misreport the move. */
    function formatPctShort(pct) {
      if (!Number.isFinite(pct)) return '';
      const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
      return sign + Math.abs(pct).toFixed(2) + '%';
    }

    /** Amounts keep their cents everywhere; the strip is a ledger, not a headline. */
    function formatMoneyShort(value) {
      return formatMoney(value);
    }

    /** Turnover in the units people actually read: 1.2亿 / 3560万 / 42. */
    function formatAmountCN(value) {
      if (!Number.isFinite(value)) return '—';
      const abs = Math.abs(value);
      if (abs >= 1e8) return (abs / 1e8).toFixed(2) + '亿';
      if (abs >= 1e4) return Math.round(abs / 1e4) + '万';
      return String(Math.round(abs));
    }

    function signedMoneyShort(value, currency) {
      if (!Number.isFinite(value)) return '—';
      const sign = value > 0 ? '+' : value < 0 ? '-' : '';
      const prefix = currency ? CURRENCY_SIGN[currency] || '' : '';
      return sign + prefix + formatMoneyShort(value);
    }

    /** Absolute amount with grouped digits, never rounded: 1234567.5 -> "1,234,567.50". */
    function formatMoney(value) {
      if (!Number.isFinite(value)) return '—';
      const fixed = Math.abs(value).toFixed(2);
      const [integer, fraction] = fixed.split('.');
      return groupInteger(integer) + '.' + fraction;
    }

    function signedMoney(value, currency) {
      if (!Number.isFinite(value)) return '—';
      const sign = value > 0 ? '+' : value < 0 ? '-' : '';
      const prefix = currency ? CURRENCY_SIGN[currency] || '' : '';
      return sign + prefix + formatMoney(value);
    }

    function moneyWithCurrency(value, currency) {
      if (!Number.isFinite(value)) return '—';
      return (CURRENCY_SIGN[currency] || '') + formatMoney(value);
    }

    function directionOf(value) {
      if (!Number.isFinite(value) || value === 0) return 'flat';
      return value > 0 ? 'up' : 'down';
    }

    /* ------------------------------------------------------------------ */
    /* positions                                                           */
    /* ------------------------------------------------------------------ */

    /** Today's P&L for one position: price move since yesterday's close. */
    function dayPnlOf(position, row) {
      if (!row || !Number.isFinite(row.price) || !Number.isFinite(row.prevClose) || !(row.prevClose > 0)) return null;
      return {
        amount: (row.price - row.prevClose) * position.shares,
        pct: ((row.price - row.prevClose) / row.prevClose) * 100,
      };
    }

    function computePositions(positions, quotes) {
      const perSymbol = new Map();
      const totals = new Map();
      for (const position of positions) {
        const row = quotes.get(position.symbol.key);
        if (!row || !Number.isFinite(row.price)) continue;
        const cost = position.cost * position.shares;
        const value = row.price * position.shares;
        if (!(cost > 0)) continue;
        const pnl = value - cost;
        const currency = currencyOf(position.symbol);
        perSymbol.set(position.symbol.key, {
          pnl,
          pct: (pnl / cost) * 100,
          value,
          cost,
          currency,
          shares: position.shares,
          costPrice: position.cost,
        });
        const total = totals.get(currency) || { pnl: 0, cost: 0 };
        total.pnl += pnl;
        total.cost += cost;
        totals.set(currency, total);
      }
      return { perSymbol, totals };
    }

    /* ------------------------------------------------------------------ */
    /* styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.dss-strip{position:fixed;left:0;right:0;bottom:0;height:' + STRIP_HEIGHT + 'px;z-index:9999;',
      'display:flex;align-items:center;gap:0;overflow:hidden;user-select:none;',
      'font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
      'font-variant-numeric:tabular-nums;background:#f7f8fa;color:#3b3f46;',
      'border-top:1px solid rgba(15,23,42,.10);box-shadow:0 -1px 2px rgba(15,23,42,.04)}',
      'body[data-ds-dark-theme] .dss-strip{background:#16181d;color:#c9ced8;border-top-color:rgba(255,255,255,.09);box-shadow:none}',
      '.dss-summary{display:none;align-items:center;gap:6px;height:100%;padding:0 12px;white-space:nowrap;',
      'font-weight:600;border-right:1px solid rgba(15,23,42,.10);flex:0 0 auto}',
      'body[data-ds-dark-theme] .dss-summary{border-right-color:rgba(255,255,255,.09)}',
      '.dss-summary.dss-on{display:flex}',
      '.dss-sum-label{opacity:.55;font-weight:400}',
      '.dss-viewport{flex:1 1 auto;min-width:0;height:100%;overflow:hidden;position:relative;',
      '-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%);',
      'mask-image:linear-gradient(90deg,transparent 0,#000 12px,#000 calc(100% - 12px),transparent 100%)}',
      '.dss-track{display:flex;align-items:center;height:100%;white-space:nowrap;will-change:transform}',
      '.dss-track.dss-rolling{animation-name:dss-marquee;animation-timing-function:linear;animation-iteration-count:infinite}',
      '.dss-two .dss-track{display:grid;grid-auto-flow:row;grid-template-rows:repeat(2,minmax(0,1fr));',
      'height:100%;justify-content:start}',
      '.dss-two .dss-item{height:100%;min-width:0;max-width:100%;overflow:hidden}',
      '.dss-two .dss-item:nth-child(odd){border-bottom:1px solid rgba(15,23,42,.06)}',
      'body[data-ds-dark-theme] .dss-two .dss-item:nth-child(odd){border-bottom-color:rgba(255,255,255,.06)}',
      '.dss-viewport:hover .dss-track{animation-play-state:paused}',
      '@keyframes dss-marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}',
      '.dss-item{display:inline-flex;align-items:baseline;gap:4px;padding:0 7px;height:100%;line-height:' + STRIP_HEIGHT + 'px;',
      'border-right:1px solid rgba(15,23,42,.07)}',
      'body[data-ds-dark-theme] .dss-item{border-right-color:rgba(255,255,255,.07)}',
      '.dss-name{opacity:.66;max-width:7em;overflow:hidden;text-overflow:ellipsis}',
      '.dss-held .dss-name{opacity:.92}',
      '.dss-dim{opacity:.3}',
      '.dss-price{font-weight:600}',
      '.dss-pct{font-weight:600;min-width:4.6em}',
      '.dss-pnl{font-weight:600;opacity:.92}',
      '.dss-sep{opacity:.26;margin:0 1px}',
      '.dss-pnl-rate{font-weight:600;opacity:.66}',
      '.dss-up{color:#e02e3d}.dss-down{color:#0a9d6b}.dss-flat{opacity:.55}',
      'body[data-ds-dark-theme] .dss-up{color:#ff5b6a}body[data-ds-dark-theme] .dss-down{color:#26c08a}',
      '.dss-missing .dss-price{opacity:.35}',
      '.dss-status{padding:0 10px;opacity:.5;font-size:11px;white-space:nowrap}',
      '.dss-gear{border:0;background:transparent;color:inherit;opacity:.42;cursor:pointer;height:100%;padding:0 12px;font-size:13px;line-height:1}',
      '.dss-gear:hover{opacity:.85}',
      '.dss-panel{position:fixed;right:10px;bottom:' + (STRIP_RESERVE + 8) + 'px;z-index:10000;width:320px;',
      'display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;max-height:calc(100vh - 60px);overflow:auto;',
      'background:#fff;color:#2b2f36;border:1px solid rgba(15,23,42,.1);box-shadow:0 10px 30px rgba(15,23,42,.18);',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
      'body[data-ds-dark-theme] .dss-panel{background:#1d2027;color:#d5dae4;border-color:rgba(255,255,255,.1)}',
      '.dss-panel-title{font-weight:600}',
      '.dss-panel-hint{opacity:.55;font-size:11px}',
      '.dss-panel textarea,.dss-panel input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;',
      'border:1px solid rgba(15,23,42,.16);background:transparent;color:inherit;font:inherit;resize:vertical}',
      'body[data-ds-dark-theme] .dss-panel textarea,body[data-ds-dark-theme] .dss-panel input{border-color:rgba(255,255,255,.16)}',
      '.dss-row{display:flex;align-items:center;gap:8px}',
      '.dss-row input{width:70px}',
      '.dss-row select{flex:1 1 auto;min-width:0;padding:4px 6px;border-radius:6px;border:1px solid rgba(15,23,42,.16);background:transparent;color:inherit;font:inherit}',
      'body[data-ds-dark-theme] .dss-panel select{border-color:rgba(255,255,255,.16)}',
      'body[data-ds-dark-theme] .dss-panel select option{background:#1d2027;color:#d5dae4}',
      '.dss-check{width:auto;gap:6px;cursor:pointer;opacity:.85}',
      '.dss-fields{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px}',
      '.dss-field{display:flex;align-items:center;gap:5px;cursor:pointer;opacity:.86;font-size:12px}',
      '.dss-field input{width:13px;height:13px;margin:0;accent-color:#3b6ef5}',
      '.dss-check input{width:13px;height:13px;margin:0;accent-color:#3b6ef5}',
      '.dss-actions{justify-content:flex-end}',
      '.dss-btn{padding:4px 12px;border-radius:6px;border:1px solid rgba(15,23,42,.16);background:transparent;color:inherit;font:inherit;cursor:pointer}',
      '.dss-btn-primary{background:#3b6ef5;border-color:#3b6ef5;color:#fff}',
      '.dss-error{color:#e02e3d}',
    ].join('');

    /* ------------------------------------------------------------------ */
    /* plugin                                                              */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      const body = document.body;
      if (!body) return;

      let prefs = readPrefs();
      let watchSymbols = resolveList(prefs.codes);
      let positions = resolvePositions(prefs.positions);
      let symbols = computeDisplay(watchSymbols, positions, prefs.onlyPositions);
      let timer = null;
      let disposed = false;
      let inFlight = false;
      let painted = false;
      let panel = null;

      const style = document.createElement('style');
      style.dataset.dshStockStrip = '';
      style.textContent = CSS;
      document.head.append(style);

      const strip = document.createElement('div');
      strip.className = 'dss-strip';
      strip.dataset.dshStockStrip = '';
      strip.setAttribute('role', 'status');
      strip.setAttribute('aria-live', 'off');

      const summary = document.createElement('span');
      summary.className = 'dss-summary';

      const viewport = document.createElement('div');
      viewport.className = 'dss-viewport';
      const track = document.createElement('div');
      track.className = 'dss-track';
      const status = document.createElement('span');
      status.className = 'dss-status';
      const gear = document.createElement('button');
      gear.className = 'dss-gear';
      gear.type = 'button';
      gear.title = '自选股、持仓与刷新频率';
      gear.textContent = '⚙';

      viewport.append(track);
      strip.append(summary, viewport, status, gear);
      body.append(strip);

      /* Reserve the strip's height so nothing sits underneath it. */
      const prior = {
        paddingBottom: body.style.paddingBottom,
        boxSizing: body.style.boxSizing,
      };
      const basePadding = Number.parseFloat(window.getComputedStyle(body).paddingBottom) || 0;
      body.style.boxSizing = 'border-box';

      /* Height actually reserved right now, in px (bar height + its top border). */
      let reserved = 0;
      /* The app root, when the shell pins it to 100vh instead of letting body padding work. */
      let shrunkRoot = null;
      let shrunkRootHeight = '';

      /** Grow/shrink the bar and move the app out of its way. */
      function setRows(rows) {
        const px = STRIP_HEIGHT * rows + 1;
        strip.classList.toggle('dss-two', rows === 2);
        track.style.gridTemplateColumns =
          rows === 2 ? 'repeat(' + Math.ceil(Math.max(1, symbols.length) / 2) + ', max-content)' : '';
        if (px === reserved) return;
        reserved = px;
        strip.style.height = px - 1 + 'px';
        if (shrunkRoot) shrunkRoot.style.height = 'calc(100% - ' + px + 'px)';
        else body.style.paddingBottom = basePadding + px + 'px';
      }
      setRows(1);

      /*
       * Most shells size the app from <body>, so the padding above is enough.
       * A few pin the app root to 100vh instead; shrink that root by the strip
       * height so the composer never ends up underneath the bar.
       */
      function reserveRootSpace() {
        if (disposed || shrunkRoot) return;
        for (const child of body.children) {
          if (child === strip || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
          const rect = child.getBoundingClientRect();
          if (rect.height >= window.innerHeight - 4 && rect.width > window.innerWidth * 0.4) {
            shrunkRoot = child;
            shrunkRootHeight = child.style.height;
            /* The root already fills the viewport: undo the body padding and
             * shrink the root itself instead, so the two never double up. */
            body.style.paddingBottom = basePadding + 'px';
            child.style.height = 'calc(100% - ' + (reserved || STRIP_RESERVE) + 'px)';
            return;
          }
        }
      }

      const onResize = () =>
        window.requestAnimationFrame(() => {
          reserveRootSpace();
          layout();
        });
      window.addEventListener('resize', onResize);
      window.requestAnimationFrame(reserveRootSpace);

      /* ---------------- rendering ---------------- */

      function buildCell(className, text) {
        const node = document.createElement('span');
        node.className = className;
        node.textContent = text;
        return node;
      }

      /** One row cell: the name plus whichever fields the user switched on. */
      function buildItem(symbol, row, pnl) {
        const item = document.createElement('span');
        item.className = 'dss-item' + (pnl ? ' dss-held' : '');
        const fields = prefs.fields;

        const name = document.createElement('span');
        name.className = 'dss-name';
        name.textContent = row && row.name ? row.name : symbol.label;
        item.append(name);

        if (!row || !Number.isFinite(row.price)) {
          item.append(buildCell('dss-dim', '—'));
          return item;
        }

        const dir = directionOf(row.pct);
        const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
        const marketFields = fields.price || fields.change || fields.changeAmount || fields.amount || fields.turnover;
        const cells = [];

        if (fields.price) cells.push(buildCell('dss-price dss-' + dir, formatPrice(row.price)));
        if (fields.change || (!pnl && !marketFields)) {
          cells.push(buildCell('dss-pct dss-' + dir, arrow + formatPctShort(row.pct)));
        }
        if (fields.changeAmount && Number.isFinite(row.change)) {
          cells.push(buildCell('dss-dim', (row.change > 0 ? '+' : '') + row.change.toFixed(2)));
        }
        if (fields.amount && Number.isFinite(row.amount)) {
          cells.push(buildCell('dss-dim', formatAmountCN(row.amount)));
        }
        if (fields.turnover && Number.isFinite(row.turnover)) {
          cells.push(buildCell('dss-dim', row.turnover.toFixed(2) + '%'));
        }

        if (pnl) {
          const pdir = directionOf(pnl.pnl);
          /* With several money columns on at once, tag each so -756 vs -3,168 is readable. */
          const moneyFields = [fields.totalPnl, fields.dayPnl, fields.marketValue, fields.costPrice].filter(Boolean).length;
          const tag = (label, text) => (moneyFields >= 2 ? label + text : text);
          /* Mixed currencies keep the symbol per cell; a single one shows it in the summary. */
          const symbolFor = singleCurrency ? null : pnl.currency;
          const day = fields.dayPnl ? dayPnlOf(pnl, row) : null;
          if (fields.totalPnl) cells.push(buildCell('dss-pnl dss-' + pdir, tag('总', signedMoneyShort(pnl.pnl, symbolFor))));
          if (fields.totalPct) {
            cells.push(buildCell('dss-pnl-rate dss-' + pdir, tag('总', formatPctShort(pnl.pct))));
          }
          if (fields.dayPnl) {
            cells.push(
              buildCell(
                'dss-day dss-' + (day ? directionOf(day.amount) : 'flat'),
                day ? tag('今', signedMoneyShort(day.amount, symbolFor)) : '—',
              ),
            );
          }
          if (fields.marketValue) cells.push(buildCell('dss-dim', tag('值', moneyWithCurrency(pnl.value, pnl.currency))));
          if (fields.costPrice) cells.push(buildCell('dss-dim', tag('本', formatCost(pnl.costPrice))));
          if (fields.shares) cells.push(buildCell('dss-dim', groupInteger(String(pnl.shares)) + '股'));

          item.title =
            '成本 ' +
            formatCost(pnl.costPrice) +
            ' × ' +
            groupInteger(String(pnl.shares)) +
            ' 股 · 市值 ' +
            moneyWithCurrency(pnl.value, pnl.currency) +
            ' · 总盈亏 ' +
            signedMoney(pnl.pnl, pnl.currency) +
            ' (' +
            formatPct(pnl.pct) +
            ')' +
            (dayPnlOf(pnl, row)
              ? ' · 当日 ' +
                signedMoney(dayPnlOf(pnl, row).amount, pnl.currency) +
                ' (' +
                formatPct(dayPnlOf(pnl, row).pct) +
                ')'
              : '');
        }

        cells.forEach((node, index) => {
          if (index > 0) {
            const sep = document.createElement('span');
            sep.className = 'dss-sep';
            sep.textContent = '·';
            item.append(sep);
          }
          item.append(node);
        });

        return item;
      }

      function renderSummary(totals) {
        summary.textContent = '';
        const entries = Array.from(totals.entries());
        if (!positions.length || !entries.length || prefs.showSummary === false) {
          summary.classList.remove('dss-on');
          return;
        }
        const label = document.createElement('span');
        label.className = 'dss-sum-label';
        label.textContent = '持仓';
        summary.append(label);

        const single = entries.length === 1;
        for (const [currency, total] of entries) {
          const chip = document.createElement('span');
          chip.className = 'dss-sum-chip dss-' + directionOf(total.pnl);
          const pct = total.cost > 0 ? formatPctShort((total.pnl / total.cost) * 100) : '';
          const symbol = CURRENCY_SIGN[currency] || '';
          chip.textContent =
            (total.pnl > 0 ? '+' : total.pnl < 0 ? '-' : '') +
            symbol +
            formatMoneyShort(total.pnl) +
            (single && pct ? ' (' + pct + ')' : '');
          chip.title = '成本 ' + formatMoney(total.cost) + ' ' + currency + (pct ? ' · 盈亏率 ' + pct : '');
          summary.append(chip);
        }
        summary.classList.add('dss-on');
      }

      let lastQuotes = new Map();
      let lastPnl = new Map();
      /* When every position sits in one currency the per-cell symbol is redundant. */
      let singleCurrency = true;

      function paint() {
        track.classList.remove('dss-rolling');
        track.style.animationDuration = '';
        track.textContent = '';
        track.dataset.dssCloned = '0';
        for (const symbol of symbols) {
          track.append(buildItem(symbol, lastQuotes.get(symbol.key), lastPnl.get(symbol.key)));
        }
      }

      function render(quotes) {
        lastQuotes = quotes;
        summary.textContent = '';
        summary.classList.remove('dss-on');

        if (!symbols.length) {
          track.textContent = '';
          status.textContent = '未配置自选股';
          status.classList.remove('dss-error');
          return;
        }

        const { perSymbol, totals } = computePositions(positions, quotes);
        lastPnl = perSymbol;
        singleCurrency = totals.size <= 1;
        renderSummary(totals);

        window.requestAnimationFrame(layout);
      }

      /**
       * Pick the cheapest layout that shows everything: one row if it fits,
       * otherwise two half-width rows (no scrolling), otherwise one rolling row.
       */
      function layout() {
        if (disposed || !symbols.length) return;
        /* Always measure in single-row mode: in the grid each cell is only half width. */
        setRows(1);
        paint();
        const widths = Array.from(track.children).map((node) => node.getBoundingClientRect().width);
        const natural = widths.reduce((sum, width) => sum + width, 0);
        const available = viewport.clientWidth;
        const fitsOne = natural <= available + 2;

        const wantsTwo = prefs.rows === 2;

        /* One row wins unless the user explicitly asked for two. */
        if (!wantsTwo && (fitsOne || prefs.rows === 1 || symbols.length < 2)) {
          setRows(1);
          if (fitsOne) stopRoll();
          else fitRoll();
          return;
        }

        const columns = Math.ceil(symbols.length / 2);
        const columnWidth = available / columns;
        const widest = Math.max.apply(null, widths);
        if (wantsTwo || widest <= columnWidth - 2) {
          setRows(2);
          stopRoll();
          return;
        }

        setRows(1);
        fitRoll();
      }

      /** Stop any running marquee (also drops the duplicated cells). */
      function stopRoll() {
        track.classList.remove('dss-rolling');
        track.style.animationDuration = '';
        while (track.dataset.dssCloned === '1' && track.children.length > symbols.length) {
          track.lastElementChild.remove();
        }
        track.dataset.dssCloned = '0';
      }

      /** If the row overflows, duplicate it and roll right-to-left. */
      function fitRoll() {
        track.classList.remove('dss-rolling');
        track.style.animationDuration = '';
        while (track.dataset.dssCloned === '1' && track.children.length > symbols.length) {
          track.lastElementChild.remove();
        }
        track.dataset.dssCloned = '0';
        if (!track.children.length) return;
        if (track.scrollWidth <= viewport.clientWidth + 4) return;
        const originals = Array.from(track.children);
        for (const node of originals) track.append(node.cloneNode(true));
        track.dataset.dssCloned = '1';
        const seconds = Math.max(12, Math.round(track.scrollWidth / 2 / 55));
        track.style.animationDuration = seconds + 's';
        track.classList.add('dss-rolling');
      }

      /* ---------------- settings panel ---------------- */

      function closePanel() {
        if (!panel) return;
        panel.remove();
        panel = null;
      }

      function openPanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.className = 'dss-panel';

        const title = document.createElement('div');
        title.className = 'dss-panel-title';
        title.textContent = '底边行情条';

        const hint = document.createElement('div');
        hint.className = 'dss-panel-hint';
        hint.textContent = '自选股（逗号或换行分隔）：600519 / sh600519 / 00700 / AAPL / BK1036 / 1.600519';

        const area = document.createElement('textarea');
        area.rows = 3;
        area.spellcheck = false;
        area.value = prefs.codes.join(', ');

        const posHint = document.createElement('div');
        posHint.className = 'dss-panel-hint';
        posHint.textContent = '持仓（每行：代码 股数 成本价，换行或分号分隔；不填则不显示盈亏）';

        const posArea = document.createElement('textarea');
        posArea.rows = Math.min(6, Math.max(3, prefs.positions.length + 1));
        posArea.spellcheck = false;
        posArea.placeholder = '600519 100 1580.5';
        posArea.value = prefs.positions.map((p) => p.code + ' ' + p.shares + ' ' + p.cost).join('\n');

        const row = document.createElement('div');
        row.className = 'dss-row';
        const rowLabel = document.createElement('span');
        rowLabel.textContent = '刷新间隔（秒）';
        const interval = document.createElement('input');
        interval.type = 'number';
        interval.min = '5';
        interval.max = '120';
        interval.step = '1';
        interval.value = String(prefs.interval);
        row.append(rowLabel, interval);

        const rowsRow = document.createElement('label');
        rowsRow.className = 'dss-row';
        const rowsLabel = document.createElement('span');
        rowsLabel.textContent = '行数';
        const rowsSelect = document.createElement('select');
        for (const [value, text] of [
          ['auto', '自动（一行放不下就变两行）'],
          ['1', '单行'],
          ['2', '两行'],
        ]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          rowsSelect.append(option);
        }
        rowsSelect.value = String(prefs.rows);
        rowsRow.append(rowsLabel, rowsSelect);

        const onlyRow = document.createElement('label');
        onlyRow.className = 'dss-row dss-check';
        const onlyBox = document.createElement('input');
        onlyBox.type = 'checkbox';
        onlyBox.checked = prefs.onlyPositions !== false;
        const onlyLabel = document.createElement('span');
        onlyLabel.textContent = '只显示持仓（不然还会带上自选股里的指数等）';
        onlyRow.append(onlyBox, onlyLabel);

        const sumRow = document.createElement('label');
        sumRow.className = 'dss-row dss-check';
        const sumBox = document.createElement('input');
        sumBox.type = 'checkbox';
        sumBox.checked = prefs.showSummary !== false;
        const sumLabel = document.createElement('span');
        sumLabel.textContent = '显示左侧「持仓」汇总（关掉能给行情条腾出宽度）';
        sumRow.append(sumBox, sumLabel);

        const fieldHint = document.createElement('div');
        fieldHint.className = 'dss-panel-hint';
        fieldHint.textContent = '显示字段（按顺序拼接；持仓类只对有仓位的票生效；涨跌幅即当日盈亏比）';

        const fieldsWrap = document.createElement('div');
        fieldsWrap.className = 'dss-fields';
        for (const [key, text] of [
          ['price', '股价'],
          ['change', '涨跌幅'],
          ['changeAmount', '涨跌额'],
          ['amount', '成交额'],
          ['turnover', '换手率'],
          ['totalPnl', '总盈亏'],
          ['totalPct', '总盈亏比'],
          ['dayPnl', '当日盈亏'],
          ['marketValue', '持仓市值'],
          ['costPrice', '成本价'],
          ['shares', '股数'],
        ]) {
          const wrap = document.createElement('label');
          wrap.className = 'dss-field';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.dataset.field = key;
          box.checked = prefs.fields[key] === true;
          const label = document.createElement('span');
          label.textContent = text;
          wrap.append(box, label);
          fieldsWrap.append(wrap);
        }

        const actions = document.createElement('div');
        actions.className = 'dss-row dss-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dss-btn';
        cancel.textContent = '取消';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'dss-btn dss-btn-primary';
        save.textContent = '保存';
        actions.append(cancel, save);

        const error = document.createElement('div');
        error.className = 'dss-panel-hint dss-error';

        panel.append(title, hint, area, posHint, posArea, row, rowsRow, onlyRow, sumRow, fieldHint, fieldsWrap, actions, error);
        body.append(panel);

        cancel.addEventListener('click', closePanel);
        save.addEventListener('click', () => {
          error.textContent = '';

          const codes = area.value
            .split(/[\s,，;；、]+/)
            .map((code) => code.trim())
            .filter(Boolean);
          const nextWatch = resolveList(codes);
          if (!nextWatch.length) {
            error.textContent = '自选股没认出任何代码，检查一下写法';
            return;
          }

          /* Rows split on newline or semicolon; fields on whitespace/comma. */
          const parsedPositions = [];
          const rows = posArea.value.split(/[\n;；]+/);
          for (let index = 0; index < rows.length; index += 1) {
            const line = rows[index].trim();
            if (!line) continue;
            const parts = splitPositionRow(line);
            if (parts.length < 3) {
              error.textContent = '持仓第 ' + (index + 1) + ' 行「' + line + '」：要写成 代码 股数 成本价';
              return;
            }
            const code = parts[0];
            if (!resolveSymbol(code)) {
              error.textContent = '持仓第 ' + (index + 1) + ' 行：认不出代码「' + code + '」';
              return;
            }
            const shares = parseNumberField(parts[1]);
            const cost = parseNumberField(parts[2]);
            if (!(shares > 0) || !(cost > 0)) {
              error.textContent =
                '持仓第 ' + (index + 1) + ' 行「' + line + '」：股数和成本价要是大于 0 的数字';
              return;
            }
            parsedPositions.push({ code, shares, cost });
          }

          prefs = {
            codes,
            interval: clampInterval(interval.value),
            positions: parsedPositions,
            onlyPositions: onlyBox.checked,
            rows: rowsSelect.value === '1' ? 1 : rowsSelect.value === '2' ? 2 : 'auto',
            showSummary: sumBox.checked,
            fields: readFieldBoxes(fieldsWrap),
          };
          writePrefs(prefs);
          watchSymbols = nextWatch;
          positions = resolvePositions(parsedPositions);
          symbols = computeDisplay(watchSymbols, positions, prefs.onlyPositions);
          closePanel();
          painted = false;
          render(new Map());
          refresh();
        });

        window.requestAnimationFrame(() => area.focus());
      }

      gear.addEventListener('click', () => {
        if (panel) closePanel();
        else openPanel();
      });

      function onKeyDown(event) {
        if (event.key === 'Escape') closePanel();
      }
      document.addEventListener('keydown', onKeyDown);

      /* ---------------- polling ---------------- */

      function schedule() {
        if (disposed) return;
        if (timer) window.clearTimeout(timer);
        const delay = document.hidden ? 60000 : prefs.interval * 1000;
        timer = window.setTimeout(refresh, delay);
      }

      async function refresh() {
        if (disposed || inFlight) return;
        if (document.hidden) {
          schedule();
          return;
        }
        inFlight = true;
        try {
          const quotes = await fetchQuotes(symbols);
          if (disposed) return;
          if (quotes.size) {
            painted = true;
            status.textContent = '';
            status.classList.remove('dss-error');
            render(quotes);
          } else if (!painted) {
            status.textContent = '行情暂不可用';
            status.classList.add('dss-error');
          }
        } catch {
          if (!painted) {
            status.textContent = '行情暂不可用';
            status.classList.add('dss-error');
          }
        } finally {
          inFlight = false;
          schedule();
        }
      }

      function onVisibility() {
        if (document.hidden) {
          if (timer) window.clearTimeout(timer);
        } else {
          refresh();
        }
      }
      document.addEventListener('visibilitychange', onVisibility);

      render(new Map());
      refresh();

      const cleanup = () => {
        disposed = true;
        if (timer) window.clearTimeout(timer);
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('resize', onResize);
        closePanel();
        strip.remove();
        style.remove();
        if (shrunkRoot) shrunkRoot.style.height = shrunkRootHeight;
        body.style.paddingBottom = prior.paddingBottom;
        body.style.boxSizing = prior.boxSizing;
      };

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => cleanup, 'dsh-stock-strip: bottom quote bar');
      } else {
        window.addEventListener('pagehide', cleanup, { once: true });
      }
    }

    return { apply };
  },
});
