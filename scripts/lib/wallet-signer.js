// Sign a deploy with the owner's own browser wallet (owner decision 2026-10-04: the platform's contracts are created
// by 0x3e1f…1919 so block explorers show that wallet as their creator). The deploy scripts run unchanged; every
// transaction they send is handed to a small page on http://127.0.0.1:<port> that sends it from the wallet (MetaMask,
// Rabby, Coinbase Wallet, …) once the owner approves it there. The key never leaves the wallet. Reads, receipts and
// every check still go through the script's own RPC.
//
//   WALLET=browser DEPLOYER=0x<the wallet that must sign> [WALLET_PORT=8790] npx hardhat run scripts/deploy.js --network base
//
// Safety: the page and its API answer only on 127.0.0.1 and only with the random token printed in the link. The script
// checks every transaction the wallet reports back: sent from DEPLOYER, to the right address (or a plain contract
// creation), with exactly the data the script asked for. Anything else stops the deploy before the next step.
const http = require("http");
const crypto = require("crypto");
const { ethers } = require("hardhat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WalletBridge {
  constructor({ expected, chainId, port, title }) {
    this.expected = ethers.getAddress(expected);
    this.chainId = Number(chainId);
    this.port = Number(port);
    this.title = title;
    this.token = crypto.randomBytes(16).toString("hex");
    this.connected = null;      // { account, chainId } once the page has connected the right wallet
    this.current = null;        // the transaction waiting for the wallet
    this.history = [];          // finished steps, for the page
    this.done = null;           // final message
    this.nextId = 1;
    this._onConnect = [];
  }

  url() { return `http://127.0.0.1:${this.port}/?t=${this.token}`; }

  start() {
    this.server = http.createServer((req, res) => this._handle(req, res).catch((e) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => resolve(this));
    });
  }

  close() { if (this.server) this.server.close(); }

  waitForWallet() {
    if (this.connected) return Promise.resolve(this.connected);
    return new Promise((resolve) => this._onConnect.push(resolve));
  }

  // Hands one transaction to the page and resolves with the hash the wallet returns.
  request(label, tx) {
    if (this.current) throw new Error(`wallet busy with "${this.current.label}"`);
    return new Promise((resolve, reject) => {
      this.current = { id: this.nextId++, label, tx, resolve, reject };
    });
  }

  record(entry) { this.history.push(entry); }

  finish(message) { this.done = message; }

  async _body(req) {
    const chunks = [];
    for await (const c of req) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 65536) throw new Error("body too large"); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }

  async _handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    // Every route needs the token, so no other web page in the same browser can drive or read this one.
    if (u.searchParams.get("t") !== this.token) return send(403, { error: "forbidden" });
    if (req.method === "GET" && u.pathname === "/") return send(200, PAGE.replace("__TOKEN__", this.token), "text/html; charset=utf-8");
    if (req.method === "GET" && u.pathname === "/state") {
      const c = this.current;
      return send(200, {
        title: this.title, expected: this.expected, chainId: this.chainId, connected: this.connected,
        current: c ? { id: c.id, label: c.label, tx: c.tx } : null, history: this.history, done: this.done,
      });
    }
    if (req.method === "POST" && u.pathname === "/hello") {
      const b = await this._body(req);
      const account = typeof b.account === "string" && ethers.isAddress(b.account) ? ethers.getAddress(b.account) : null;
      const chainId = Number(b.chainId);
      if (account !== this.expected) return send(200, { ok: false, error: `Connected ${account || "no account"}; this deploy must be signed by ${this.expected}. Switch the account in your wallet and connect again.` });
      if (chainId !== this.chainId) return send(200, { ok: false, error: `Your wallet is on chain ${chainId}; switch it to chain ${this.chainId} and connect again.` });
      const first = !this.connected;
      this.connected = { account, chainId };
      if (first) { const w = this._onConnect.splice(0); w.forEach((f) => f(this.connected)); }
      return send(200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/result") {
      const b = await this._body(req);
      const c = this.current;
      if (!c || Number(b.id) !== c.id) return send(200, { ok: false, error: "not the current request" });
      if (typeof b.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(b.hash)) {
        this.current = null;
        c.resolve(b.hash);
        return send(200, { ok: true });
      }
      if (b.stop) {
        this.current = null;
        c.reject(Object.assign(new Error(`${c.label}: stopped in the wallet page (${String(b.error || "no reason given").slice(0, 300)})`), { code: "ACTION_REJECTED" }));
        return send(200, { ok: true });
      }
      return send(200, { ok: false, error: "need a transaction hash or stop" });
    }
    return send(404, { error: "not found" });
  }
}

// A signer whose transactions are sent by the browser wallet through the bridge. Contract factories and contracts
// connected to it work as with a key-based signer; signing messages is not supported (deploys never need it).
class WalletSigner extends ethers.AbstractSigner {
  constructor(provider, bridge) {
    super(provider);
    this.bridge = bridge;
    this.address = bridge.expected;
    this._label = null;
  }
  connect(provider) { return new WalletSigner(provider, this.bridge); }
  async getAddress() { return this.address; }
  /** The page shows this text for the next transaction. */
  label(text) { this._label = text; }
  async signTransaction() { throw new Error("the browser wallet signs and sends; use sendTransaction"); }
  async signMessage() { throw new Error("message signing is not supported by the wallet bridge"); }
  async signTypedData() { throw new Error("typed-data signing is not supported by the wallet bridge"); }

  async sendTransaction(tx) {
    const pop = await this.populateCall(tx);
    const label = this._label || (pop.to ? `Call ${pop.to}` : "Create a contract");
    this._label = null;
    const data = pop.data ? ethers.hexlify(pop.data) : "0x";
    const wtx = { from: this.address, data, value: ethers.toQuantity(pop.value || 0) };
    if (pop.to) wtx.to = ethers.getAddress(pop.to);
    if (pop.gasLimit != null) wtx.gas = ethers.toQuantity(pop.gasLimit);
    console.log(`  → in your wallet: ${label}`);
    const hash = await this.bridge.request(label, wtx);
    // A load-balanced RPC may not know a fresh transaction for a few seconds: look for it for up to 10 minutes.
    let resp = null;
    for (let i = 0; i < 200 && !resp; i++) {
      try { resp = await this.provider.getTransaction(hash); } catch (e) { resp = null; }
      if (!resp) await sleep(3000);
    }
    const fail = (why) => { throw new Error(`${label}: ${why}. Nothing further is sent; see the wallet page and the transaction ${hash}.`); };
    if (!resp) fail(`the wallet reported ${hash}, but Base does not know that transaction after 10 minutes (a wallet that sends through a smart-account service returns a different kind of hash)`);
    if (resp.from.toLowerCase() !== this.address.toLowerCase()) fail(`it was sent from ${resp.from}, not ${this.address}`);
    if (!wtx.to && resp.to != null) fail(`the wallet did not send a plain contract creation (it sent a call to ${resp.to})`);
    if (wtx.to && (resp.to || "").toLowerCase() !== wtx.to.toLowerCase()) fail(`it went to ${resp.to}, not ${wtx.to}`);
    if (resp.data.toLowerCase() !== data.toLowerCase()) fail("the wallet changed the transaction data");
    if (BigInt(resp.value) !== BigInt(wtx.value)) fail("the wallet changed the value");
    this.bridge.record({ label, hash, kind: wtx.to ? "call" : "create" });
    console.log(`    sent ${hash} (nonce ${resp.nonce})`);
    return resp;
  }
}

/**
 * Starts the bridge, prints the link, and resolves with a signer once the page has connected `expected` on the
 * provider's chain. `title` is shown at the top of the page.
 */
async function walletSigner(provider, { expected, port = 8790, title = "Panda deploy" }) {
  const { chainId } = await provider.getNetwork();
  const bridge = await new WalletBridge({ expected, chainId, port, title }).start();
  console.log(`\nOpen this link in the browser that has your wallet, connect ${bridge.expected}, and approve each step there:\n\n    ${bridge.url()}\n`);
  await bridge.waitForWallet();
  console.log(`wallet connected: ${bridge.expected} on chain ${Number(chainId)}`);
  return new WalletSigner(provider, bridge);
}

/** Sets the page's text for the next transaction; a no-op for key-based signers. */
function say(signer, text) { if (signer && typeof signer.label === "function") signer.label(text); }

/** For contracts created through the bridge: the receipt must show the contract at the address the script uses. */
async function assertCreated(contract, label) {
  const tx = contract.deploymentTransaction();
  if (!tx) return;
  const r = await tx.wait();
  if (!r || r.status !== 1) throw new Error(`${label}: deployment failed (tx ${tx.hash})`);
  if (!r.contractAddress || r.contractAddress.toLowerCase() !== String(contract.target).toLowerCase()) {
    throw new Error(`${label}: the receipt shows ${r.contractAddress}, not ${contract.target}`);
  }
}

/** Closes the bridge after showing the final message on the page for a few seconds. */
async function closeWallet(signer, message) {
  if (!signer || !signer.bridge) return;
  signer.bridge.finish(message);
  await sleep(6000);
  signer.bridge.close();
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Panda deploy signer</title>
<style>
:root { --bg:#f6f7f9; --card:#fff; --fg:#14171c; --muted:#5b6370; --line:#d9dde3; --accent:#1f6feb; --ok:#1a7f37; --bad:#c62828; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a20; --fg:#e8eaed; --muted:#9aa3ae; --line:#2a2f37; --accent:#58a6ff; --ok:#3fb950; --bad:#f85149; color-scheme: dark; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width:760px; margin:0 auto; padding-block:24px 48px; padding-inline:16px; display:grid; gap:16px; }
h1 { font-size:20px; margin:0; } .muted { color:var(--muted); } code { font:13px ui-monospace, Consolas, monospace; word-break:break-all; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; display:grid; gap:10px; min-width:0; }
button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; } button:disabled { opacity:.5; cursor:default; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.ok { color:var(--ok); } .bad { color:var(--bad); }
ol { margin:0; padding-left:22px; display:grid; gap:4px; } li { min-width:0; }
.big { font-size:17px; font-weight:600; }
</style></head>
<body><main>
<div><h1 id="title">Panda deploy</h1><div class="muted">Each step opens in your wallet. Approve it there; this page sends nothing by itself.</div></div>
<div class="card"><div>Must be signed by <code id="expected"></code> on chain <code id="chain"></code></div>
<div class="row" id="wallets"></div><div id="connmsg" class="muted">Looking for wallets…</div></div>
<div class="card"><div class="muted">Now</div><div id="now" class="big">Waiting for the deploy script…</div><div id="nowdetail" class="muted"></div>
<div class="row"><button id="retry" hidden>Send to the wallet again</button><button id="stop" hidden>Stop the deploy</button></div></div>
<div class="card"><div class="muted">Done</div><ol id="hist"></ol></div>
</main>
<script>
const T = "__TOKEN__";
const $ = (id) => document.getElementById(id);
let st = null, wallet = null, account = null, attempted = 0, busy = false;
const found = [];
const api = (p, body) => fetch(p + (p.includes("?") ? "&" : "?") + "t=" + T, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}).then((r) => r.json());
const hex = (n) => "0x" + Number(n).toString(16);
const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const link = (h) => st && st.chainId === 8453 ? '<a href="https://basescan.org/tx/' + h + '" target="_blank" rel="noopener">' + short(h) + '</a>' : '<code>' + short(h) + '</code>';
window.addEventListener("eip6963:announceProvider", (e) => { if (!found.some((f) => f.info.uuid === e.detail.info.uuid)) { found.push(e.detail); drawWallets(); } });
window.dispatchEvent(new Event("eip6963:requestProvider"));
function drawWallets() {
  const box = $("wallets"); box.innerHTML = "";
  const list = found.length ? found : (window.ethereum ? [{ info: { name: "Browser wallet", uuid: "injected" }, provider: window.ethereum }] : []);
  for (const w of list) { const b = document.createElement("button"); b.className = "primary"; b.textContent = "Connect " + w.info.name; b.onclick = () => connect(w.provider); box.appendChild(b); }
  $("connmsg").textContent = list.length ? (account ? "Connected " + account : "Choose the wallet that holds the account above.") : "No wallet found in this browser.";
}
setTimeout(drawWallets, 600);
async function connect(p) {
  try {
    const accs = await p.request({ method: "eth_requestAccounts" });
    let chain = parseInt(await p.request({ method: "eth_chainId" }), 16);
    if (chain !== st.chainId) {
      try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(st.chainId) }] }); } catch (e) {}
      chain = parseInt(await p.request({ method: "eth_chainId" }), 16);
    }
    const r = await api("/hello", { account: accs[0], chainId: chain });
    if (!r.ok) { $("connmsg").innerHTML = '<span class="bad">' + r.error + '</span>'; return; }
    wallet = p; account = accs[0]; $("connmsg").innerHTML = '<span class="ok">Connected ' + account + '</span>';
  } catch (e) { $("connmsg").innerHTML = '<span class="bad">' + (e.message || e) + '</span>'; }
}
async function sendCurrent() {
  if (!wallet || !st.current || busy) return;
  busy = true; $("retry").hidden = true; $("stop").hidden = true;
  const c = st.current; attempted = c.id;
  try {
    const accs = await wallet.request({ method: "eth_accounts" });
    const chain = parseInt(await wallet.request({ method: "eth_chainId" }), 16);
    if (!accs[0] || accs[0].toLowerCase() !== st.expected.toLowerCase()) throw new Error("The wallet switched to " + (accs[0] || "no account") + ". Switch back to " + st.expected + ".");
    if (chain !== st.chainId) throw new Error("The wallet is on chain " + chain + ". Switch it to chain " + st.chainId + ".");
    $("nowdetail").textContent = "Approve it in your wallet…";
    const hash = await wallet.request({ method: "eth_sendTransaction", params: [c.tx] });
    await api("/result", { id: c.id, hash });
    $("nowdetail").textContent = "Sent. Waiting for Base to confirm it…";
  } catch (e) {
    $("nowdetail").innerHTML = '<span class="bad">' + (e.message || e) + '</span>';
    $("retry").hidden = false; $("stop").hidden = false;
  } finally { busy = false; }
}
$("retry").onclick = () => sendCurrent();
$("stop").onclick = async () => { if (!st.current) return; await api("/result", { id: st.current.id, stop: true, error: $("nowdetail").textContent }); $("retry").hidden = true; $("stop").hidden = true; };
async function tick() {
  try {
    st = await api("/state");
    $("title").textContent = st.title; $("expected").textContent = st.expected; $("chain").textContent = st.chainId === 8453 ? "8453 (Base)" : String(st.chainId);
    $("hist").innerHTML = st.history.map((h) => "<li>" + h.label + " · " + link(h.hash) + "</li>").join("");
    if (st.done) { $("now").textContent = st.done; $("nowdetail").textContent = "You can close this page."; $("retry").hidden = true; $("stop").hidden = true; return; }
    if (st.current) {
      $("now").textContent = st.current.label;
      if (st.current.id !== attempted && wallet) sendCurrent();
      else if (!wallet) $("nowdetail").textContent = "Connect your wallet above to continue.";
    } else if (wallet) { $("now").textContent = "Waiting for the deploy script…"; }
  } catch (e) { $("nowdetail").innerHTML = '<span class="bad">The deploy script is not answering (' + (e.message || e) + ').</span>'; }
  setTimeout(tick, 1000);
}
tick();
</script></body></html>`;

module.exports = { walletSigner, say, assertCreated, closeWallet };
