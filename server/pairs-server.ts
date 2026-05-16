import { serve } from "bun";
import { keccak256, toBytes, concat } from "viem";

// ── DexScreener API ────────────────────────────────────────────────────
const DEXSCREENER_SEARCH = "https://api.dexscreener.com/latest/dex/search";

const CHAIN_MAP: Record<string, string> = {
  ethereum: "eth",
  bsc: "bsc",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  base: "base",
  avalanche: "avalanche",
  fantom: "fantom",
  celo: "celo",
  gnosis: "gnosis",
  blast: "blast",
  linea: "linea",
  scroll: "scroll",
};

const NETWORK_TO_CHAIN: Record<string, string> = {};
for (const [k, v] of Object.entries(CHAIN_MAP)) NETWORK_TO_CHAIN[v] = k;

// ── Cache ───────────────────────────────────────────────────────────────

const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any) {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 2000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// ── Types ───────────────────────────────────────────────────────────────

interface PairResult {
  pair: string;
  token0: string;
  token1: string;
  token0_decimals: number;
  token1_decimals: number;
  interface: string;
  src_exact: string;
}

// ── RPC for decimals ───────────────────────────────────────────────────

const DECIMALS_SIG = "0x313ce567";
const RPC: Record<string, string> = {
  eth: "https://rpc.ankr.com/eth",
  bsc: "https://bsc.publicnode.com",
  polygon: "https://polygon.publicnode.com",
  arbitrum: "https://arbitrum.publicnode.com",
  optimism: "https://optimism.publicnode.com",
  base: "https://base.publicnode.com",
  avalanche: "https://avalanche.publicnode.com",
  fantom: "https://fantom.publicnode.com",
  celo: "https://forno.celo.org",
  gnosis: "https://rpc.gnosischain.com",
  blast: "https://rpc.blast.io",
  linea: "https://rpc.linea.build",
  scroll: "https://scroll.publicnode.com",
};

async function ethCall(rpc: string, to: `0x${string}`, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "ityfuzz-pairs/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to, data }, "latest"], id: 1 }),
  });
  const json: any = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function fetchDecimals(rpc: string, token: `0x${string}`): Promise<number> {
  try {
    const raw = await ethCall(rpc, token, DECIMALS_SIG);
    return parseInt(raw, 16);
  } catch { return 18; }
}

// ── DexScreener query ───────────────────────────────────────────────────

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
}

async function queryDexScreener(token: `0x${string}`): Promise<DexScreenerPair[]> {
  try {
    const res = await fetch(`${DEXSCREENER_SEARCH}/?q=${token}`);
    if (!res.ok) { console.warn(`DexScreener HTTP ${res.status}`); return []; }
    const json: any = await res.json();
    return json.pairs || [];
  } catch (e) { console.warn(`DexScreener error: ${e}`); return []; }
}

// ── Server ──────────────────────────────────────────────────────────────

serve({
  port: parseInt(process.env.PAIRS_PORT || "5003"),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (path === "/health") {
      return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    }

    // GET /pairs/:network/:token
    const pairsMatch = path.match(/^\/pairs\/([^\/]+)\/(0x[0-9a-fA-F]+)$/);
    if (pairsMatch) {
      const network = pairsMatch[1].toLowerCase();
      const token = pairsMatch[2].toLowerCase() as `0x${string}`;
      const result = await handlePairs(network, token);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // GET /single_pair/:network/:token/:weth
    const singleMatch = path.match(/^\/single_pair\/([^\/]+)\/(0x[0-9a-fA-F]+)\/(0x[0-9a-fA-F]+)$/);
    if (singleMatch) {
      const network = singleMatch[1].toLowerCase();
      const token = singleMatch[2].toLowerCase() as `0x${string}`;
      const weth = singleMatch[3].toLowerCase() as `0x${string}`;
      const result = await handleSinglePair(network, token, weth);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown endpoint" }), { status: 404, headers: { "Content-Type": "application/json" } });
  },
});

console.log(`✅ Pairs server on port ${process.env.PAIRS_PORT || "5003"} (DexScreener)`);

// ── Handlers ────────────────────────────────────────────────────────────

async function handlePairs(network: string, token: `0x${string}`): Promise<PairResult[]> {
  const cacheKey = `pairs/${network}/${token}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const chainId = NETWORK_TO_CHAIN[network];
  if (!chainId) { console.warn(`Unknown network: ${network}`); return []; }

  const pairs = await queryDexScreener(token);
  const networkPairs = pairs.filter((p) => p.chainId === chainId);
  const rpc = RPC[network];
  const seen = new Set<string>();
  const results: PairResult[] = [];

  for (const p of networkPairs) {
    if (!p.pairAddress || seen.has(p.pairAddress)) continue;
    seen.add(p.pairAddress);

    const t0 = p.baseToken.address.toLowerCase() as `0x${string}`;
    const t1 = p.quoteToken.address.toLowerCase() as `0x${string}`;
    if (!t0 || !t1) continue;

    const [d0, d1] = await Promise.all([
      fetchDecimals(rpc, t0),
      fetchDecimals(rpc, t1),
    ]);

    results.push({
      pair: p.pairAddress.toLowerCase(),
      token0: t0,
      token1: t1,
      token0_decimals: d0,
      token1_decimals: d1,
      interface: p.dexId || "unknown",
      src_exact: p.dexId || "unknown",
    });
  }

  setCache(cacheKey, results);
  console.log(`[${network}] ${token}: ${results.length} pairs`);
  return results;
}

async function handleSinglePair(network: string, token: `0x${string}`, weth: `0x${string}`): Promise<PairResult[]> {
  const cacheKey = `single/${network}/${token}/${weth}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Get all pairs and filter to only those with weth as the other token
  const allPairs = await handlePairs(network, token);
  const result = allPairs.filter((p) => {
    const other = p.token0 === token ? p.token1 : p.token0;
    return other === weth;
  }).map((p) => ({ ...p, src_exact: "pegged" }));

  setCache(cacheKey, result);
  console.log(`[${network}] ${token}/${weth}: ${result.length} pegged pairs`);
  return result;
}
