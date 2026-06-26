// Live-registry wrapper resolution for the Hadrian cached-test deploys.
//
// The canonical SPL_ERC20_cached wrapper addresses are NOT hardcoded here —
// they're fetched at runtime from the deployed rome-ui backend's /api/chains,
// the same source rome-ui itself reads. Hadrian migrated all SPL wrappers to a
// new set; fetching keeps these deploys pointed at whatever is live instead of
// testing dead contracts.
//
// Base URL is configurable via REGISTRY_API_BASE (default = Hadrian devnet app).

const DEFAULT_API_BASE = 'https://app.devnet.romeprotocol.xyz';
const HADRIAN_CHAIN_ID = 200010;

export interface RegistryToken {
  symbol: string;
  address: string;
  mintId: string;
  kind: string;
}

export interface ResolvedWrapper {
  symbol: string;
  address: string;
  mint: string;
}

// /api/chains is an array of chain objects, but tolerate the chain being
// nested (e.g. under a `chains` key) by walking the JSON for the first object
// whose chainId matches.
function findChain(node: unknown, chainId: number): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findChain(item, chainId);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Number(obj.chainId) === chainId) return obj;
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') {
        const found = findChain(value, chainId);
        if (found) return found;
      }
    }
  }
  return null;
}

// Fetch the live Hadrian (200010) SPL_ERC20_cached wrappers by symbol. Returns
// { address, mint } for each requested symbol; throws if the chain or any
// requested wrapper is missing so a misconfigured deploy fails loudly.
export async function fetchHadrianWrappers(
  symbols: string[],
  apiBase: string = process.env.REGISTRY_API_BASE || DEFAULT_API_BASE,
): Promise<Record<string, ResolvedWrapper>> {
  const url = `${apiBase.replace(/\/$/, '')}/api/chains`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`registry fetch failed: GET ${url} → HTTP ${res.status}`);
  }
  const body = await res.json();
  const chain = findChain(body, HADRIAN_CHAIN_ID);
  if (!chain) {
    throw new Error(`chain ${HADRIAN_CHAIN_ID} not found in ${url}`);
  }
  const tokens = (chain.tokens as RegistryToken[]) || [];

  const resolved: Record<string, ResolvedWrapper> = {};
  for (const symbol of symbols) {
    const token = tokens.find((t) => t.symbol === symbol && t.kind === 'spl_wrapper');
    if (!token) {
      throw new Error(
        `no spl_wrapper token '${symbol}' for chain ${HADRIAN_CHAIN_ID} in ${url}`,
      );
    }
    resolved[symbol] = { symbol, address: token.address, mint: token.mintId };
  }
  return resolved;
}
