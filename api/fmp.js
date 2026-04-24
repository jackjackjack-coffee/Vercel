/**
 * Vercel Serverless Function: /api/fmp.js
 * Alpha Vantage backend for MyTrade
 *
 * Setup:
 *  1. Place this file at: api/fmp.js  (in your project root)
 *  2. Add environment variable in Vercel dashboard:
 *     AV_API_KEY = your_alpha_vantage_key
 *  3. Get a free key at: https://www.alphavantage.co/support/#api-key
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

export default async function handler(req, res) {
  // Set CORS headers on every response
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action = '', ticker: rawTicker = '', period = '3m' } = req.query;
  const ticker = rawTicker.toUpperCase().trim();
  const key = process.env.AV_API_KEY || '';

  if (!key) {
    return res.status(500).json({ error: 'AV_API_KEY environment variable not set.' });
  }

  try {
    // ── 1. Connection test ────────────────────────────────────
    if (action === 'test') {
      const data = await avFetch(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=${key}`
      );
      if (data?.Note || data?.Information) {
        return res.status(200).json({ ok: false, error: 'Rate limited' });
      }
      const ok = !!(data?.['Global Quote']?.['05. price']);
      return res.status(200).json({ ok });
    }

    // ── 2. Price history ──────────────────────────────────────
    if (action === 'history') {
      if (!ticker) return res.status(400).json({ error: 'ticker required' });

      const outputsize = period === '1y' ? 'full' : 'compact';
      const data = await avFetch(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${ticker}&outputsize=${outputsize}&apikey=${key}`
      );
      if (data?.Note || data?.Information) {
        return res.status(429).json({ error: 'Rate limit reached. Free tier: 25 req/day.' });
      }
      const ts = data?.['Time Series (Daily)'];
      if (!ts) return res.status(200).json([]);

      const days = period === '1m' ? 30 : period === '3m' ? 90 : 365;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      const result = Object.entries(ts)
        .filter(([date]) => new Date(date) >= cutoff)
        .map(([date, v]) => ({
          date,
          close: parseFloat(parseFloat(v['4. close']).toFixed(2)),
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      return res.status(200).json(result);
    }

    // ── 3. Full fundamentals ──────────────────────────────────
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    // Fetch quote (price)
    const quoteData = await avFetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${ticker}&apikey=${key}`
    );
    if (quoteData?.Note || quoteData?.Information) {
      return res.status(429).json({ error: 'Rate limit reached. Free tier: 25 req/day, 5/min.' });
    }
    const quote = quoteData?.['Global Quote'];
    if (!quote?.['05. price']) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found.` });
    }

    // Small delay to avoid hitting the 5 req/min limit
    await sleep(300);

    // Fetch company overview (EPS, dividends, beta, P/E, etc.)
    const overviewData = await avFetch(
      `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${ticker}&apikey=${key}`
    );

    await sleep(300);

    // Fetch cash flow (FCF calculation)
    const cashFlowData = await avFetch(
      `https://www.alphavantage.co/query?function=CASH_FLOW&symbol=${ticker}&apikey=${key}`
    );

    // Guard against rate-limited overview (use empty object as fallback)
    const ov = overviewData && !overviewData.Note && !overviewData.Information
      ? overviewData
      : {};
    const cf = cashFlowData?.annualReports?.[0] || {};

    // ── Parse fields ──────────────────────────────────────────
    const price    = parseFloat(quote['05. price'])                      || 0;
    const eps      = parseFloat(ov['EPS'])                               || 0;
    const div      = parseFloat(ov['DividendPerShare'])                  || 0;
    const beta     = parseFloat(ov['Beta'])                              || 1.2;
    const shares   = (parseFloat(ov['SharesOutstanding']) / 1e6)         || 0;
    const pe       = parseFloat(ov['PERatio'])                           || 25;
    const evEbitda = parseFloat(ov['EVToEBITDA'])                        || 15;
    const name     = ov['Name']                                          || ticker;

    // Free Cash Flow  = Operating CF - CapEx
    const operatingCF = parseFloat(cf['operatingCashflow'])              || 0;
    const capex       = Math.abs(parseFloat(cf['capitalExpenditures'])   || 0);
    const fcf         = Math.max((operatingCF - capex) / 1e6, 0);

    // Net Debt
    const longTermDebt  = parseFloat(
      ov['LongTermDebtNetOfUnamortizedDiscount'] || cf['longTermDebt'] || 0
    );
    const shortTermDebt = parseFloat(cf['shortLongTermDebtTotal'] || 0);
    const cashAndEq     = parseFloat(
      ov['CashAndCashEquivalentsAtCarryingValue'] ||
      ov['CashAndShortTermInvestments'] || 0
    );
    const netDebt = Math.max((longTermDebt + shortTermDebt - cashAndEq) / 1e6, 0);

    // Growth rates derived from revenue growth YoY
    const revGrowthRaw = parseFloat(ov['QuarterlyRevenueGrowthYOY']) || 0.08;
    const revGrowthPct = Math.abs(revGrowthRaw) < 2
      ? revGrowthRaw * 100
      : revGrowthRaw;
    const g1 = Math.min(Math.max(revGrowthPct, 2), 30);
    const g2 = Math.min(Math.max(revGrowthPct * 0.6, 2), 20);

    const result = {
      name,
      sector:   ov['Sector']   || '',
      industry: ov['Industry'] || '',
      price,
      eps,
      div,
      fcf,
      shares,
      debt:  netDebt,
      beta,
      g1,
      g2,
      tg:    2.5,
      wacc:  9,
      fcfm:  22,
      perT:  Math.min(Math.max(pe, 10), 80),
      perG:  Math.round(g1),
      evM:   Math.min(Math.max(evEbitda, 5), 50),
      evMg:  30,
      grG:   Math.round(g1 * 0.8),
      grY:   4.5,
      ddmG:  div > 0 ? Math.min(g1 * 0.5, 8) : 0,
      ddmR:  8,
      fromApi:   true,
      fetchedAt: Date.now(),
    };

    return res.status(200).json(result);

  } catch (err) {
    console.error('[fmp] error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ── Helpers ───────────────────────────────────────────────────

async function avFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from Alpha Vantage`);
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
