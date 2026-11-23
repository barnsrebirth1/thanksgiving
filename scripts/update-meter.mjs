// Counts every creator-fee donation from $THANKS to Meals on Wheels America (via pump.fun Charity Coins + donate.gg)
// and writes the running total to meter.json. Runs on GitHub Actions every 10 minutes.
import fs from "node:fs";

const RAW = (process.env.HELIUS_RPC || "").trim();
const HELIUS = !RAW ? null : RAW.startsWith("http") ? RAW : "https://mainnet.helius-rpc.com/?api-key=" + RAW;
const PUBLIC = "https://solana-rpc.publicnode.com";
let RPC = HELIUS || PUBLIC;
const RECIPIENT = "sYjZCNo1HgDpg4ajibL9sDgwyeJ8EeTpdWUhKEPr5K7";   // fee-sharing shareholder (100%) for the coin
const DONATION = "AgqbtJ1Fv73DKbwfzk9282t2L3Xbev6AkwoKQExJG5De";    // donation account the fees are swept into
const OUT = process.argv[2] || "meter.json";
const SOL_MINT = "So11111111111111111111111111111111111111112";

async function call(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 80)}`); }
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
async function rpc(method, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return await call(RPC, method, params); }
    catch (e) {
      if (RPC !== PUBLIC && /HTTP (401|403)|Unauthorized|api key/i.test(e.message)) { console.log("Helius key rejected, using the public RPC instead"); RPC = PUBLIC; continue; }
      if (i === tries - 1) throw e; await new Promise((s) => setTimeout(s, 800 * (i + 1)));
    }
  }
}
async function solPrice() {
  const urls = [
    ["https://lite-api.jup.ag/price/v3?ids=" + SOL_MINT, (j) => j[SOL_MINT]?.usdPrice],
    ["https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => j.solana?.usd],
    ["https://api.dexscreener.com/latest/dex/tokens/BECqBzwZmkzM7A3tWimc2qvm7ookzYi8XACHMZgipump", (j) => { const p = j.pairs?.[0]; return p && +p.priceUsd / +p.priceNative; }],
  ];
  for (const [u, f] of urls) { try { const v = +f(await (await fetch(u)).json()); if (v > 1) return v; } catch {} }
  return null;
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { totalSol: 0, totalUsd: 0, donations: [], lastSig: null };
let sigs = [], before;
for (;;) {
  const opt = { limit: 1000 }; if (before) opt.before = before; if (prev.lastSig) opt.until = prev.lastSig;
  const page = await rpc("getSignaturesForAddress", [RECIPIENT, opt]);
  if (!page?.length) break;
  sigs.push(...page); before = page[page.length - 1].signature;
  if (page.length < 1000) break;
}
sigs = sigs.filter((s) => !s.err).reverse(); // oldest first
const price = await solPrice();
let added = 0;
for (const s of sigs) {
  const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
  if (!tx) continue;
  const logs = tx.meta.logMessages || [];
  if (!logs.some((l) => l.includes("DistributeCreatorFees"))) continue;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
  const i = keys.indexOf(DONATION); if (i < 0) continue;
  const sol = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
  if (sol <= 0) continue;
  if (prev.donations.some((d) => d.sig === s.signature)) continue;
  prev.donations.push({ time: s.blockTime, sol: +sol.toFixed(6), usd: price ? +(sol * price).toFixed(2) : null, sig: s.signature });
  added++;
}
if (sigs.length) prev.lastSig = sigs[sigs.length - 1].signature;
const p = price || prev.solPrice || null;
prev.donations.forEach((d) => { if (d.usd == null && p) d.usd = +(d.sol * p).toFixed(2); });
prev.totalSol = +prev.donations.reduce((a, d) => a + d.sol, 0).toFixed(6);
prev.totalUsd = +prev.donations.reduce((a, d) => a + (d.usd || 0), 0).toFixed(2);
prev.count = prev.donations.length;
if (price) prev.solPrice = +price.toFixed(2);
prev.updated = Math.floor(Date.now() / 1000);
fs.writeFileSync(OUT, JSON.stringify(prev));
console.log(`+${added} donations, total ${prev.totalSol} SOL ≈ $${prev.totalUsd}`);
