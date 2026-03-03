import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function freshImport(workspaceRelativePath) {
  const abs = path.resolve(process.cwd(), workspaceRelativePath);
  const href = pathToFileURL(abs).href;
  return import(`${href}?t=${Date.now()}_${Math.random()}`);
}

function withEnv(overrides, fn) {
  const previous = { ...process.env };
  const overrideKeys = Object.keys(overrides);
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous) && overrideKeys.includes(key)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    });
}

function clearMarketCache() {
  delete globalThis[Symbol.for('clawall.market_data.cache')];
}

test('market pricing resolves by symbol -> coingecko id map (haSUI)', { concurrency: false }, async () => {
  await withEnv(
    {
      TEST_MODE: '1',
      PACKAGE_ID: '',
      MARKET_COINGECKO_ID_BY_SYMBOL_JSON: '{"HASUI":"hasui"}',
      MARKET_COINGECKO_ID_BY_COIN_TYPE_JSON: '',
      MARKET_FIXED_PRICE_USD_BY_SYMBOL_JSON: '',
      MARKET_FIXED_PRICE_USD_BY_COIN_TYPE_JSON: '',
    },
    async () => {
      clearMarketCache();
      const market = await freshImport('src/risk/market-data.mjs');
      const coinType = '0xaaa::hasui::HASUI';

      const out = await market.computeTransferPricing(
        {
          coinType,
          amountRaw: 1_000_000_000,
        },
        {
          getCoinMetadataFn: async () => ({ symbol: 'haSUI', decimals: 9 }),
          fetchFn: async (url) => {
            if (!String(url).includes('/simple/price?ids=hasui')) {
              throw new Error(`unexpected url: ${url}`);
            }
            return {
              ok: true,
              async json() {
                return { hasui: { usd: 1.23 } };
              },
            };
          },
        }
      );

      assert.equal(out?.coinType, coinType);
      assert.equal(out?.priceUsd, 1.23);
      assert.equal(out?.transferUsd, 1.23);
    }
  );
});

test('market pricing resolves via fixed symbol price (WAL)', { concurrency: false }, async () => {
  await withEnv(
    {
      TEST_MODE: '1',
      PACKAGE_ID: '',
      MARKET_FIXED_PRICE_USD_BY_SYMBOL_JSON: '{"WAL":0.42}',
      MARKET_COINGECKO_ID_BY_SYMBOL_JSON: '',
      MARKET_COINGECKO_ID_BY_COIN_TYPE_JSON: '',
      MARKET_FIXED_PRICE_USD_BY_COIN_TYPE_JSON: '',
    },
    async () => {
      clearMarketCache();
      const market = await freshImport('src/risk/market-data.mjs');
      const coinType = '0xbbb::wal::WAL';

      const out = await market.computeTransferPricing(
        {
          coinType,
          amountRaw: 2_000_000_000,
        },
        {
          getCoinMetadataFn: async () => ({ symbol: 'wal', decimals: 9 }),
          fetchFn: async () => {
            throw new Error('fetch should not run for fixed symbol price');
          },
        }
      );

      assert.equal(out?.priceUsd, 0.42);
      assert.equal(out?.transferUsd, 0.84);
    }
  );
});

test('market pricing falls back to $1 for stable symbols when providers fail (USDC)', { concurrency: false }, async () => {
  await withEnv(
    {
      TEST_MODE: '1',
      PACKAGE_ID: '',
      MARKET_STABLE_SYMBOLS: 'USDC,USDT',
      MARKET_FIXED_PRICE_USD_BY_SYMBOL_JSON: '',
      MARKET_COINGECKO_ID_BY_SYMBOL_JSON: '',
      MARKET_COINGECKO_ID_BY_COIN_TYPE_JSON: '',
      MARKET_FIXED_PRICE_USD_BY_COIN_TYPE_JSON: '',
    },
    async () => {
      clearMarketCache();
      const market = await freshImport('src/risk/market-data.mjs');
      const coinType = '0xccc::usdc::USDC';

      const out = await market.computeTransferPricing(
        {
          coinType,
          amountRaw: 2_500_000,
        },
        {
          getCoinMetadataFn: async () => ({ symbol: 'USDC', decimals: 6 }),
          fetchFn: async () => ({
            ok: false,
            status: 503,
            async json() {
              return {};
            },
          }),
        }
      );

      assert.equal(out?.priceUsd, 1);
      assert.equal(out?.transferUsd, 2.5);
    }
  );
});

test('single request mode performs only one remote price call', { concurrency: false }, async () => {
  await withEnv(
    {
      TEST_MODE: '1',
      PACKAGE_ID: '',
      MARKET_PRICE_REQUEST_MODE: 'single',
      MARKET_COINGECKO_ID_BY_SYMBOL_JSON: '{"HASUI":"haedal-staked-sui"}',
      MARKET_COINGECKO_ID_BY_COIN_TYPE_JSON: '{"0xddd::hasui::HASUI":"haedal-staked-sui"}',
      MARKET_FIXED_PRICE_USD_BY_SYMBOL_JSON: '',
      MARKET_FIXED_PRICE_USD_BY_COIN_TYPE_JSON: '',
    },
    async () => {
      clearMarketCache();
      const market = await freshImport('src/risk/market-data.mjs');
      let calls = 0;

      const out = await market.computeTransferPricing(
        {
          coinType: '0xddd::hasui::HASUI',
          amountRaw: 1_000_000_000,
        },
        {
          getCoinMetadataFn: async () => ({ symbol: 'haSUI', decimals: 9 }),
          fetchFn: async () => {
            calls += 1;
            return {
              ok: true,
              async json() {
                return { 'haedal-staked-sui': { usd: 1.11 } };
              },
            };
          },
        }
      );

      assert.equal(out?.priceUsd, 1.11);
      assert.equal(calls, 1);
    }
  );
});
