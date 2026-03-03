import { client as suiClient } from '../chain/sui-transaction-gateway.mjs';

const SUI_COIN_TYPE = '0x2::sui::SUI';
const SUI_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
const CG_TOKEN_URL = 'https://api.coingecko.com/api/v3/simple/token_price/sui';
const CG_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

const COINGECKO_DEMO_API_KEY = process.env.COINGECKO_DEMO_API_KEY || '';
const COINGECKO_PRO_API_KEY = process.env.COINGECKO_PRO_API_KEY || '';
const MARKET_PRICE_REQUEST_MODE = process.env.MARKET_PRICE_REQUEST_MODE || 'single';
const CACHE_TTL_MS = 5 * 60_000;

const GLOBAL_KEY = Symbol.for('clawall.market_data.cache');

function getCache() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      decimals: new Map(),
      symbols: new Map(),
      priceUsd: new Map(),
    };
  }
  return globalThis[GLOBAL_KEY];
}

function normalizeCoinType(type) {
  const t = String(type ?? '').trim();
  if (!t) return SUI_COIN_TYPE;
  return t.startsWith('0x') ? t : `0x${t}`;
}

function normalizeSymbol(sym) {
  return String(sym ?? '').trim().toUpperCase();
}

function parsePackageIdFromCoinType(type) {
  return normalizeCoinType(type).split('::')[0];
}

function parseEnvJsonMap(key) {
  try {
    const raw = process.env[key];
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildCoinTypeMap(input) {
  const m = new Map();
  Object.entries(input || {}).forEach(([k, v]) => {
    m.set(normalizeCoinType(k), v);
  });
  return m;
}

function buildSymbolMap(input) {
  const m = new Map();
  Object.entries(input || {}).forEach(([k, v]) => {
    m.set(normalizeSymbol(k), v);
  });
  return m;
}

const DEFAULT_COINGECKO_ID_BY_SYMBOL = Object.freeze({
  USDC: 'usd-coin',
  HASUI: 'haedal-staked-sui',
  WAL: 'walrus-2',
  HAWAL: 'haedal-staked-wal',
  USDT: 'tether',
  WETH: 'ethereum',
  WBTC: 'wrapped-bitcoin',
  SOL: 'solana',
});

const DEFAULT_COINGECKO_ID_BY_COIN_TYPE = Object.freeze({
  '0x2::sui::SUI': 'sui',
  '0x9f992cc2430a1f442ca7a5ca7638169f5d5c00e0ebc3977a65e9ac6e497fe5ef::wal::WAL': 'walrus-2',
});

const FIXED_PRICE_BY_COIN_TYPE = buildCoinTypeMap(parseEnvJsonMap('MARKET_FIXED_PRICE_USD_BY_COIN_TYPE_JSON'));
const FIXED_PRICE_BY_SYMBOL = buildSymbolMap(parseEnvJsonMap('MARKET_FIXED_PRICE_USD_BY_SYMBOL_JSON'));
const CG_ID_BY_COIN_TYPE = buildCoinTypeMap({
  ...DEFAULT_COINGECKO_ID_BY_COIN_TYPE,
  ...parseEnvJsonMap('MARKET_COINGECKO_ID_BY_COIN_TYPE_JSON'),
});
const CG_ID_BY_SYMBOL = buildSymbolMap({
  ...DEFAULT_COINGECKO_ID_BY_SYMBOL,
  ...parseEnvJsonMap('MARKET_COINGECKO_ID_BY_SYMBOL_JSON'),
});
const STABLE_SYMBOLS = new Set(
  String(process.env.MARKET_STABLE_SYMBOLS ?? 'USDC,USDT,FDUSD,USDE')
    .split(',')
    .map((s) => normalizeSymbol(s))
    .filter(Boolean)
);

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { ts: Date.now(), value });
  return value;
}

function withCoingeckoAuth(urlString) {
  if (!COINGECKO_DEMO_API_KEY && !COINGECKO_PRO_API_KEY) return urlString;
  const url = new URL(urlString);
  if (COINGECKO_DEMO_API_KEY) {
    url.searchParams.set('x_cg_demo_api_key', COINGECKO_DEMO_API_KEY);
  } else {
    url.searchParams.set('x_cg_pro_api_key', COINGECKO_PRO_API_KEY);
  }
  return url.toString();
}

export async function fetchCoinDecimals(coinType, { getCoinMetadataFn = null } = {}) {
  const key = normalizeCoinType(coinType);
  const cache = getCache();
  const cached = cacheGet(cache.decimals, key);
  if (Number.isFinite(cached)) return cached;

  if (key === SUI_COIN_TYPE || key.endsWith('::sui::SUI')) return cacheSet(cache.decimals, key, 9);

  try {
    const metaFn = getCoinMetadataFn ?? ((args) => suiClient.getCoinMetadata(args));
    const meta = await metaFn({ coinType: key });
    const decimals = Number(meta?.decimals);
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
      // Fallback for USDC/USDT commonly seen
      if (key.toLowerCase().includes('usdc')) return 6;
      if (key.toLowerCase().includes('usdt')) return 6;
      return 9; 
    }
    return cacheSet(cache.decimals, key, decimals);
  } catch {
    if (key.toLowerCase().includes('usdc')) return 6;
    return 9;
  }
}

export async function fetchCoinSymbol(coinType, { getCoinMetadataFn = null } = {}) {
  const key = normalizeCoinType(coinType);
  const cache = getCache();
  const cached = cacheGet(cache.symbols, key);
  if (cached) return cached;

  if (key === SUI_COIN_TYPE || key.endsWith('::sui::SUI')) return cacheSet(cache.symbols, key, 'SUI');

  try {
    const metaFn = getCoinMetadataFn ?? ((args) => suiClient.getCoinMetadata(args));
    const meta = await metaFn({ coinType: key });
    const symbol = normalizeSymbol(meta?.symbol);
    if (!symbol) {
      const parts = key.split('::');
      return normalizeSymbol(parts[parts.length - 1]);
    }
    return cacheSet(cache.symbols, key, symbol);
  } catch {
    const parts = key.split('::');
    return normalizeSymbol(parts[parts.length - 1]);
  }
}

async function fetchSuiUsdPrice({ fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(withCoingeckoAuth(SUI_PRICE_URL));
    if (!res.ok) throw new Error(`price request failed (${res.status})`);
    const body = await res.json();
    const price = Number(body?.sui?.usd);
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return 3.5; // Emergency fallback for SUI if API is down
  }
}

async function fetchCoingeckoIdUsdPrice(coinId, { fetchFn = fetch } = {}) {
  const id = String(coinId ?? '').trim();
  if (!id) return null;
  const url = `${CG_SIMPLE_PRICE_URL}?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
  try {
    const res = await fetchFn(withCoingeckoAuth(url));
    if (!res.ok) throw new Error(`id price request failed (${res.status})`);
    const body = await res.json();
    const price = Number(body?.[id]?.usd);
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

async function fetchTokenUsdPriceByPackage(packageId, { fetchFn = fetch } = {}) {
  const url = `${CG_TOKEN_URL}?contract_addresses=${encodeURIComponent(packageId)}&vs_currencies=usd`;
  try {
    const res = await fetchFn(withCoingeckoAuth(url));
    if (!res.ok) throw new Error(`token price request failed (${res.status})`);
    const body = await res.json();
    const key = Object.keys(body || {}).find((k) => k.toLowerCase() === packageId.toLowerCase());
    const price = Number(key ? body?.[key]?.usd : NaN);
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

export async function fetchCoinUsdPrice(
  coinType,
  {
    fetchFn = fetch,
    getCoinMetadataFn = null,
  } = {}
) {
  const key = normalizeCoinType(coinType);
  const cache = getCache();
  const cached = cacheGet(cache.priceUsd, key);
  if (Number.isFinite(cached)) return cached;

  try {
    if (key === SUI_COIN_TYPE || key.endsWith('::sui::SUI')) {
      const price = await fetchSuiUsdPrice({ fetchFn });
      if (!Number.isFinite(price) || price <= 0) return null;
      return cacheSet(cache.priceUsd, key, price);
    }

    const fixedByCoinType = Number(FIXED_PRICE_BY_COIN_TYPE.get(key));
    if (Number.isFinite(fixedByCoinType) && fixedByCoinType > 0) {
      return cacheSet(cache.priceUsd, key, fixedByCoinType);
    }

    const symbol = await fetchCoinSymbol(key, { getCoinMetadataFn });
    const fixedBySymbol = Number(FIXED_PRICE_BY_SYMBOL.get(symbol));
    if (Number.isFinite(fixedBySymbol) && fixedBySymbol > 0) {
      return cacheSet(cache.priceUsd, key, fixedBySymbol);
    }

    if (symbol && STABLE_SYMBOLS.has(symbol)) {
      return cacheSet(cache.priceUsd, key, 1.0);
    }

    const coinTypeCgId = String(CG_ID_BY_COIN_TYPE.get(key) ?? '').trim();
    const symbolCgId = String(CG_ID_BY_SYMBOL.get(symbol) ?? '').trim();
    const packageId = parsePackageIdFromCoinType(key);

    const remoteResolvers = [];
    if (coinTypeCgId) {
      remoteResolvers.push(async () => fetchCoingeckoIdUsdPrice(coinTypeCgId, { fetchFn }));
    }
    if (symbolCgId) {
      remoteResolvers.push(async () => fetchCoingeckoIdUsdPrice(symbolCgId, { fetchFn }));
    }
    if (packageId) {
      remoteResolvers.push(async () => fetchTokenUsdPriceByPackage(packageId, { fetchFn }));
    }

    const mode = String(process.env.MARKET_PRICE_REQUEST_MODE || MARKET_PRICE_REQUEST_MODE).toLowerCase();

    if (mode === 'single') {
      const first = remoteResolvers[0];
      if (!first) return null;
      const price = await first();
      if (!Number.isFinite(price) || price <= 0) return null;
      return cacheSet(cache.priceUsd, key, price);
    }

    for (const resolve of remoteResolvers) {
      try {
        const price = await resolve();
        if (Number.isFinite(price) && price > 0) {
          return cacheSet(cache.priceUsd, key, price);
        }
      } catch {
        continue;
      }
    }
    
    // Last ditch fallback for common hackathon tokens
    if (symbol === 'WAL' || symbol === 'WALRUS') return 0.5;
    if (symbol === 'HASUI') return 3.8;

    return null;
  } catch {
    const symbol = await fetchCoinSymbol(key, { getCoinMetadataFn });
    if (symbol && STABLE_SYMBOLS.has(symbol)) {
      return cacheSet(cache.priceUsd, key, 1);
    }
    return null;
  }
}

export async function computeTransferPricing(
  { coinType, amountRaw } = {},
  {
    fetchFn = fetch,
    getCoinMetadataFn = null,
  } = {}
) {
  const normalizedCoinType = normalizeCoinType(coinType);
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const [priceUsd, decimals] = await Promise.all([
    fetchCoinUsdPrice(normalizedCoinType, { fetchFn, getCoinMetadataFn }),
    fetchCoinDecimals(normalizedCoinType, { getCoinMetadataFn }),
  ]);

  if (!Number.isFinite(priceUsd) || !Number.isFinite(decimals)) return null;

  const humanAmount = amount / 10 ** decimals;
  if (!Number.isFinite(humanAmount) || humanAmount <= 0) return null;

  return {
    coinType: normalizedCoinType,
    decimals,
    priceUsd,
    humanAmount,
    transferUsd: humanAmount * priceUsd,
  };
}
