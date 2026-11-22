// Crypto price service for real-time price data
// Using CoinGecko free API for demonstration

export interface CryptoPrice {
  [key: string]: {
    [currency: string]: number;
  };
}

export type PriceSource = 'live' | 'cache' | 'fallback';

export interface CryptoPriceResult {
  prices: CryptoPrice;
  stale: boolean;
  source: PriceSource;
  providerResponseId: string | null;
}

export interface TokenPriceQuote {
  price: number;
  stale: boolean;
  source: PriceSource;
  providerResponseId: string | null;
}

export interface TokenPriceData {
  tokenSymbol: string;
  prices: {
    [currency: string]: number;
  };
  lastUpdated: number;
  providerResponseId: string | null;
}

export interface TokenPriceWithChange {
  symbol: string;
  price: number;
  change24h?: number;
  currency: string;
}

export interface TickerData {
  [symbol: string]: TokenPriceWithChange;
}

// Token ID mapping for CoinGecko API
const TOKEN_IDS: Record<string, string> = {
  XLM: 'stellar',
  ETH: 'ethereum',
  BTC: 'bitcoin',
  USDC: 'usd-coin',
  USDT: 'tether',
};

// Supported fiat currencies — exported so UI can reference the same list
export const SUPPORTED_CURRENCIES = [
  'usd',
  'eur',
  'gbp',
  'ngn',
  'cad',
  'aud',
  'jpy',
];

// Cache for prices to avoid excessive API calls
const priceCache: Map<string, TokenPriceData> = new Map();
const inflightRequests: Map<string, Promise<TokenPriceQuote>> = new Map();
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

async function fetchCoinGeckoPrices(
  tokenSymbols: string[],
  vsCurrencies: string[],
): Promise<{ prices: CryptoPrice; providerResponseId: string | null }> {
  const tokenIds = tokenSymbols
    .map((symbol) => TOKEN_IDS[symbol.toUpperCase()])
    .filter(Boolean);
  const validCurrencies = vsCurrencies
    .map((currency) => currency.toLowerCase())
    .filter((currency) => SUPPORTED_CURRENCIES.includes(currency));

  if (tokenIds.length === 0 || validCurrencies.length === 0) {
    throw new Error('No supported token and currency pairs requested');
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenIds.join(',')}&vs_currencies=${validCurrencies.join(',')}&include_24hr_change=true`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `CoinGecko API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as Record<
    string,
    Record<string, number>
  >;
  const prices: CryptoPrice = {};
  Object.entries(data).forEach(([coinId, coinPrices]) => {
    const tokenSymbol = Object.entries(TOKEN_IDS).find(
      ([, id]) => id === coinId,
    )?.[0];
    if (tokenSymbol) prices[tokenSymbol] = coinPrices;
  });

  return {
    prices,
    providerResponseId: response.headers?.get('x-cg-request-id') ?? null,
  };
}

/** Fetch live prices, or return the last good cache and flagged fallbacks. */
export async function fetchCryptoPrices(
  tokenSymbols: string[],
  vsCurrencies: string[] = ['usd', 'eur', 'gbp', 'ngn'],
): Promise<CryptoPriceResult> {
  try {
    const { prices, providerResponseId } = await fetchCoinGeckoPrices(
      tokenSymbols,
      vsCurrencies,
    );
    const lastUpdated = Date.now();
    Object.entries(prices).forEach(([symbol, currencies]) => {
      Object.entries(currencies).forEach(([currency, price]) => {
        if (SUPPORTED_CURRENCIES.includes(currency) && Number.isFinite(price)) {
          priceCache.set(`${symbol}_${currency}`, {
            tokenSymbol: symbol,
            prices: { [currency]: price },
            lastUpdated,
            providerResponseId,
          });
        }
      });
    });
    return { prices, stale: false, source: 'live', providerResponseId };
  } catch (error) {
    console.error('Error fetching crypto prices:', error);
    const fallbackPrices = getFallbackPrices(tokenSymbols, vsCurrencies);
    const prices: CryptoPrice = {};
    let usedFallback = false;
    let usedCache = false;
    let providerResponseId: string | null = null;

    tokenSymbols.forEach((symbol) => {
      const tokenSymbol = symbol.toUpperCase();
      vsCurrencies.forEach((currency) => {
        const currencyLower = currency.toLowerCase();
        const cached = priceCache.get(`${tokenSymbol}_${currencyLower}`);
        const cachedPrice = cached?.prices[currencyLower];
        const fallbackPrice = fallbackPrices[tokenSymbol]?.[currencyLower];
        const price = cachedPrice ?? fallbackPrice;
        if (cachedPrice !== undefined) {
          usedCache = true;
          providerResponseId ??= cached.providerResponseId;
        }
        if (price !== undefined) {
          prices[tokenSymbol] ??= {};
          prices[tokenSymbol][currencyLower] = price;
        }
        if (cachedPrice === undefined && fallbackPrice !== undefined) {
          usedFallback = true;
        }
      });
    });

    return {
      prices,
      stale: true,
      source: usedFallback || !usedCache ? 'fallback' : 'cache',
      providerResponseId,
    };
  }
}

/**
 * Get fallback prices when API is unavailable
 */
function getFallbackPrices(
  tokenSymbols: string[],
  vsCurrencies: string[],
): CryptoPrice {
  const fallbackPrices: CryptoPrice = {
    XLM: {
      usd: 0.11,
      eur: 0.1,
      gbp: 0.087,
      ngn: 180,
      cad: 0.15,
      aud: 0.17,
      jpy: 16.5,
    },
    ETH: {
      usd: 4000,
      eur: 3700,
      gbp: 3200,
      ngn: 6500000,
      cad: 5400,
      aud: 6200,
      jpy: 600000,
    },
    STRK: {
      usd: 0.8,
      eur: 0.74,
      gbp: 0.64,
      ngn: 1300,
      cad: 1.08,
      aud: 1.24,
      jpy: 120,
    },
    USDC: {
      usd: 1,
      eur: 0.92,
      gbp: 0.8,
      ngn: 1650,
      cad: 1.35,
      aud: 1.55,
      jpy: 150,
    },
    USDT: {
      usd: 1,
      eur: 0.92,
      gbp: 0.8,
      ngn: 1650,
      cad: 1.35,
      aud: 1.55,
      jpy: 150,
    },
  };

  const result: CryptoPrice = {};
  tokenSymbols.forEach((symbol) => {
    const symbolUpper = symbol.toUpperCase();
    if (fallbackPrices[symbolUpper]) {
      result[symbolUpper] = {};
      vsCurrencies.forEach((currency) => {
        const currencyLower = currency.toLowerCase();
        if (fallbackPrices[symbolUpper][currencyLower]) {
          result[symbolUpper][currencyLower] =
            fallbackPrices[symbolUpper][currencyLower];
        }
      });
    }
  });

  return result;
}

/**
 * Get cached price or fetch from API.
 * Deduplicates concurrent requests for the same token+currency so only one
 * API call is in flight at a time — fixes stale-closure where N concurrent
 * callers each saw a stale cache and fired their own fetch.
 */
export async function getTokenPrice(
  tokenSymbol: string,
  vsCurrency: string = 'usd',
): Promise<number> {
  return (await getTokenPriceWithStatus(tokenSymbol, vsCurrency)).price;
}

export async function getTokenPriceWithStatus(
  tokenSymbol: string,
  vsCurrency: string = 'usd',
): Promise<TokenPriceQuote> {
  const cacheKey = `${tokenSymbol.toUpperCase()}_${vsCurrency.toLowerCase()}`;
  const cached = priceCache.get(cacheKey);

  // Return cached data if it's still fresh
  if (cached && Date.now() - cached.lastUpdated < CACHE_DURATION) {
    return {
      price: cached.prices[vsCurrency.toLowerCase()] ?? 0,
      stale: false,
      source: 'cache',
      providerResponseId: cached.providerResponseId,
    };
  }

  // If there's already an in-flight request for this key, wait for it
  const existing = inflightRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = fetchCryptoPrices([tokenSymbol], [vsCurrency]).then(
    (result) => ({
      price:
        result.prices[tokenSymbol.toUpperCase()]?.[vsCurrency.toLowerCase()] ??
        0,
      stale: result.stale,
      source: result.source,
      providerResponseId: result.providerResponseId,
    }),
  );
  inflightRequests.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

/**
 * Convert crypto amount to fiat value
 */
export async function convertCryptoToFiat(
  tokenSymbol: string,
  amount: number,
  fiatCurrency: string = 'USD',
): Promise<number> {
  try {
    const price = await getTokenPrice(tokenSymbol, fiatCurrency);
    return amount * price;
  } catch (error) {
    console.error('Error converting crypto to fiat:', error);
    throw new Error(`Failed to convert ${tokenSymbol} to ${fiatCurrency}`);
  }
}

/**
 * Convert fiat amount to crypto value
 */
export async function convertFiatToCrypto(
  fiatAmount: number,
  tokenSymbol: string,
  fiatCurrency: string = 'USD',
): Promise<number> {
  try {
    const price = await getTokenPrice(tokenSymbol, fiatCurrency);
    if (price === 0) {
      throw new Error(`No price data available for ${tokenSymbol}`);
    }
    return fiatAmount / price;
  } catch (error) {
    console.error('Error converting fiat to crypto:', error);
    throw new Error(`Failed to convert ${fiatCurrency} to ${tokenSymbol}`);
  }
}

/**
 * Get multiple token prices at once
 */
export async function getMultipleTokenPrices(
  tokenSymbols: string[],
  vsCurrencies: string[] = ['usd'],
): Promise<CryptoPriceResult> {
  return fetchCryptoPrices(tokenSymbols, vsCurrencies);
}

/**
 * Clear price cache (useful for forced refresh)
 */
export function clearPriceCache(): void {
  priceCache.clear();
}

/**
 * Fetch ticker data with 24h change for live price display
 */
export async function fetchTickerData(
  tokenSymbols: string[] = ['XLM', 'ETH', 'BTC'],
  vsCurrency: string = 'usd',
): Promise<TickerData> {
  try {
    const currencyLower = vsCurrency.toLowerCase();

    // Only include supported currencies
    if (!SUPPORTED_CURRENCIES.includes(currencyLower)) {
      throw new Error(`Unsupported currency: ${vsCurrency}`);
    }

    const { prices } = await fetchCoinGeckoPrices(tokenSymbols, [
      currencyLower,
    ]);
    const tickerData: TickerData = {};
    Object.entries(prices).forEach(([tokenSymbol, priceRecord]) => {
      if (tokenSymbol && priceRecord[currencyLower] !== undefined) {
        tickerData[tokenSymbol] = {
          symbol: tokenSymbol,
          price: priceRecord[currencyLower]!,
          change24h: priceRecord[`${currencyLower}_24h_change`],
          currency: vsCurrency,
        };
      }
    });

    return tickerData;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error fetching prices';
    console.error('Error fetching ticker data:', message);
    // Return empty object — callers should treat {} as "no data, show fallback"
    return {};
  }
}

export const QUOTE_LOCK_DURATION_MS = 120 * 1000; // 120 seconds

export interface LockedQuote {
  quoteId: string;
  quoteToken: string;
  tokenSymbol: string;
  tokenAmountDecimal: string;
  currency: string;
  exchangeRateDecimal: string;
  fiatAmountMinorUnits: string;
  roundingPolicy: string;
  provider: string;
  providerRequestId: string;
  providerResponseId: string | null;
  ngnAmount: number;
  lockedAt: number;
  expiresAt: number;
  stale: boolean;
  source: PriceSource;
}

function isLockedQuote(value: unknown): value is LockedQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as Record<string, unknown>;
  return (
    typeof quote.quoteId === 'string' &&
    typeof quote.quoteToken === 'string' &&
    typeof quote.tokenSymbol === 'string' &&
    typeof quote.tokenAmountDecimal === 'string' &&
    typeof quote.currency === 'string' &&
    typeof quote.exchangeRateDecimal === 'string' &&
    typeof quote.fiatAmountMinorUnits === 'string' &&
    typeof quote.roundingPolicy === 'string' &&
    typeof quote.provider === 'string' &&
    typeof quote.providerRequestId === 'string' &&
    (typeof quote.providerResponseId === 'string' ||
      quote.providerResponseId === null) &&
    typeof quote.ngnAmount === 'number' &&
    Number.isFinite(quote.ngnAmount) &&
    typeof quote.lockedAt === 'number' &&
    Number.isFinite(quote.lockedAt) &&
    typeof quote.expiresAt === 'number' &&
    Number.isFinite(quote.expiresAt) &&
    typeof quote.stale === 'boolean' &&
    (quote.source === 'live' ||
      quote.source === 'cache' ||
      quote.source === 'fallback')
  );
}

/**
 * Fetch a one-time fiat quote and lock it for QUOTE_LOCK_DURATION_MS.
 * The returned object carries the expiry timestamp so the UI can
 * drive a countdown and gate the final submit.
 */
export async function fetchLockedQuote(
  tokenSymbol: string,
  amount: number,
  fiatCurrency: string = 'ngn',
): Promise<LockedQuote> {
  const response = await fetch('/api/fx-quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tokenSymbol,
      tokenAmount: amount,
      currency: fiatCurrency,
    }),
  });
  const result: unknown = await response.json();
  if (
    !response.ok ||
    !result ||
    typeof result !== 'object' ||
    !('success' in result) ||
    result.success !== true ||
    !('data' in result) ||
    !isLockedQuote(result.data)
  ) {
    const message =
      result &&
      typeof result === 'object' &&
      'message' in result &&
      typeof result.message === 'string'
        ? result.message
        : `Failed to obtain an FX quote for ${tokenSymbol}`;
    throw new Error(message);
  }
  return result.data;
}

/**
 * Format a fiat amount with the correct locale and currency symbol.
 * Falls back to a plain number string if Intl is unavailable.
 */
export function formatFiatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}
