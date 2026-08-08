// ONCHAIN CHAOS — game server
// Off-chain real-time layer, plus the win -> guess-your-taps -> leaderboard -> MON payout loop.
// The payout wallet is server-held (same pattern as the GMBoard proof-of-concept): set
// POT_WALLET_PRIVATE_KEY in the environment to make payouts real; leave it unset and the app
// still runs end-to-end, it just logs what *would* have been paid out (see onPayout() below).

const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');
const { createWalletClient, http: viemHttp } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// On Render, RENDER_EXTERNAL_URL is auto-set to the public https://<service>.onrender.com
// URL — local network IPs (from getLocalUrls) are meaningless inside that container, so prefer
// it whenever present instead of falling through to internal-only addresses.
function getPrimaryBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  const urls = getLocalUrls(PORT);
  return urls[1] || urls[0]; // prefer a LAN IP phones can actually reach over localhost
}

app.get('/api/join-urls', (req, res) => {
  const bases = process.env.RENDER_EXTERNAL_URL ? [process.env.RENDER_EXTERNAL_URL] : getLocalUrls(PORT);
  const urls = bases.map((base) => `${base}/controller.html`);
  res.json({ urls });
});

app.get('/api/qr.png', async (req, res) => {
  try {
    const target = `${getPrimaryBaseUrl()}/controller.html`;
    const png = await QRCode.toBuffer(target, { width: 500, margin: 1 });
    res.type('png').send(png);
  } catch (err) {
    console.error('QR generation failed:', err);
    res.status(500).end();
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    potWalletAddress: payoutAccount ? payoutAccount.address : null,
    buyInWei: BUY_IN_WEI.toString(),
    buyInMon: BUY_IN_MON,
    chainIdHex: MONAD_CHAIN_ID_HEX,
    rpcUrl: MONAD_RPC_URL,
    explorerUrl: MONAD_EXPLORER_URL,
  });
});

// ---- tunables (adjust these live at the venue based on crowd size) ----
const TICK_MS = 50; // 20fps game loop
const TAP_INCREMENT = 12.5; // base power added per tap before team-size scaling
const DECAY_PER_SEC = 35; // power lost per second when not tapped
const FORCE_CONST = 0.016; // how hard power translates into robot velocity
const FRICTION = 0.86; // per-tick velocity damping (glide + slow down)
const MAX_SPEED = 14; // prevents the crowd from launching past the targets
const TRACK_WIDTH = 1000; // arbitrary units, robot x ranges 0..TRACK_WIDTH
const ROBOT_START_X = 500; // middle of the track — robot must travel LEFT to the coin, then RIGHT
                            // to the wallet, so both LEFT and RIGHT teams have a real job. A robot
                            // that starts left of the coin never needs LEFT team's push at all.
const COIN_START_X = 150;
const PICKUP_RADIUS = 45;
const WALLET_ZONE = { start: 820, end: 950 };
const BALANCE_TOLERANCE = 15; // |left-right| must be under this to count as "steady"
const WIN_HOLD_SECONDS = 3;

const TARGETS = { left: 70, right: 70, hold: 60 };

const WIN_CELEBRATION_MS = 2500; // how long "CROWD WINS" shows before the guess prompt appears
const GUESS_WINDOW_MS = 20000; // how long players have to submit a tap-guess
const LEADERBOARD_DISPLAY_MS = 15000; // how long the leaderboard stays up before the next lobby

// ---- Monad testnet + pot wallet config ----
const MONAD_CHAIN_ID_HEX = '0x279f'; // 10143
const MONAD_RPC_URL = 'https://testnet-rpc.monad.xyz';
const MONAD_EXPLORER_URL = 'https://testnet.monadexplorer.com';
const BUY_IN_MON = '0.5';
const BUY_IN_WEI = 500000000000000000n; // 0.5 MON, as a BigInt to avoid float precision issues

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_RPC_URL] } },
};

// Only set up if POT_WALLET_PRIVATE_KEY is present in the environment — see HANDOFF.md for setup.
let payoutAccount = null;
let payoutClient = null;
if (process.env.POT_WALLET_PRIVATE_KEY) {
  payoutAccount = privateKeyToAccount(process.env.POT_WALLET_PRIVATE_KEY);
  payoutClient = createWalletClient({
    account: payoutAccount,
    chain: monadTestnet,
    transport: viemHttp(MONAD_RPC_URL),
  });
  console.log(`Pot wallet configured: ${payoutAccount.address} — payouts are LIVE.`);
} else {
  console.log('POT_WALLET_PRIVATE_KEY not set — buy-in/payout will run in log-only stub mode.');
}

function freshState() {
  return {
    left: { power: 0, target: TARGETS.left },
    right: { power: 0, target: TARGETS.right },
    hold: { power: 0, target: TARGETS.hold },
    robot: { x: ROBOT_START_X, v: 0 },
    coin: { x: COIN_START_X, held: false },
    coinDropped: false,
    winTimer: 0,
    status: 'waiting', // waiting | playing | won | dropped | guessing | leaderboard
    guessDeadline: null,
    leaderboard: null,
    winnerUsername: null,
    payoutTx: null,
  };
}

let state = freshState();
let potWei = 0n;
const teamCounts = { left: 0, right: 0, hold: 0 };
const socketTeam = new Map();
const players = new Map(); // socket.id -> { username, team, taps, address, paid, buyInTx, guess }
// Round-scoped record of wallet addresses that already paid, keyed separately from socket.id —
// a mobile MetaMask in-app browser can reload mid-flow and hand back a brand-new socket
// connection, which would otherwise look like a fresh unpaid player and let someone get
// double-charged. Address is the durable identity here, not the socket.
const paidAddresses = new Set();
let resetTimeout = null;
let lastTapBroadcast = 0;

function assignTeam() {
  // balance new joiners across the three teams
  let team = 'right';
  if (teamCounts.hold < teamCounts[team]) team = 'hold';
  if (teamCounts.left < teamCounts[team]) team = 'left';
  teamCounts[team]++;
  return team;
}

function sanitizeUsername(raw) {
  const trimmed = String(raw || '').trim();
  const cleaned = Array.from(trimmed).filter((ch) => ch.charCodeAt(0) >= 32 || ch === '\t').join('');
  return (cleaned || 'Player').slice(0, 14);
}

function resetRound() {
  if (resetTimeout) {
    clearTimeout(resetTimeout);
    resetTimeout = null;
  }
  state = freshState();
  potWei = 0n;
  paidAddresses.clear();
  for (const p of players.values()) {
    p.paid = false;
    p.buyInTx = null;
    p.guess = null;
  }
  io.emit('reset');
  emitLobby();
}

function startRound() {
  if (resetTimeout) {
    clearTimeout(resetTimeout);
    resetTimeout = null;
  }
  const wasStatus = state.status;
  state = freshState();
  state.status = 'playing';
  if (wasStatus !== 'waiting') potWei = 0n; // safety net; normally already cleared by resetRound
  io.emit('reset');
}

function scheduleReset(ms) {
  if (resetTimeout) return;
  resetTimeout = setTimeout(() => {
    resetTimeout = null;
    resetRound();
  }, ms);
}

function onWin() {
  state.status = 'won';
  console.log('>>> CROWD WON <<< hook the Monad mint call here (onWin in server.js)');
  // TODO next checkpoint: call the contract to mint the champion NFT.
  setTimeout(startGuessingPhase, WIN_CELEBRATION_MS);
}

function startGuessingPhase() {
  for (const p of players.values()) p.guess = null;
  state.status = 'guessing';
  state.guessDeadline = Date.now() + GUESS_WINDOW_MS;
}

function maybeFinishGuessing() {
  if (state.status !== 'guessing') return;
  const everyoneGuessed =
    players.size > 0 && Array.from(players.values()).every((p) => p.guess != null);
  if (!everyoneGuessed && Date.now() < state.guessDeadline) return;
  finishGuessing();
}

function finishGuessing() {
  const ranked = Array.from(players.values())
    .map((p) => ({
      username: p.username,
      team: p.team,
      taps: p.taps,
      guess: p.guess,
      diff: p.guess == null ? Infinity : Math.abs(p.guess - p.taps),
      address: p.address || null,
    }))
    .sort((a, b) => a.diff - b.diff);

  const winner = ranked.length && Number.isFinite(ranked[0].diff) ? ranked[0] : null;

  state.status = 'leaderboard';
  state.leaderboard = ranked;
  state.winnerUsername = winner ? winner.username : null;
  state.potMon = (Number(potWei) / 1e18).toFixed(2);

  if (winner) onPayout(winner);
  scheduleReset(LEADERBOARD_DISPLAY_MS);
}

async function onPayout(winner) {
  if (potWei <= 0n) {
    console.log(`>>> PAYOUT <<< ${winner.username} guessed closest, but the pot is empty this round (no buy-ins) — nothing to send.`);
    return;
  }
  const potMon = (Number(potWei) / 1e18).toFixed(2);
  if (!payoutClient || !winner.address) {
    console.log(
      `>>> PAYOUT HOOK <<< ${winner.username} would win ${potMon} MON, but ` +
      `${!payoutClient ? 'POT_WALLET_PRIVATE_KEY is not set' : "the winner never connected a wallet"} — ` +
      `see HANDOFF.md for setup. (onPayout in server.js)`
    );
    return;
  }
  try {
    const hash = await payoutClient.sendTransaction({ to: winner.address, value: potWei });
    console.log(`>>> PAYOUT SENT <<< ${winner.username} received ${potMon} MON — tx ${hash}`);
    state.payoutTx = hash;
  } catch (err) {
    console.error('Payout transaction failed:', err);
  }
}

function emitLobby() {
  io.emit('lobby', { players: Array.from(players.values()), teamCounts, potMon: (Number(potWei) / 1e18).toFixed(2) });
}

io.on('connection', (socket) => {
  // Player is connected but not yet in the game until they submit a username via 'join'.
  socket.on('join', (payload = {}) => {
    const username = sanitizeUsername(payload.username);
    if (!players.has(socket.id)) {
      const team = assignTeam();
      socketTeam.set(socket.id, team);
      players.set(socket.id, {
        username, team, taps: 0, address: null, paid: false, buyInTx: null, guess: null,
      });
    } else {
      players.get(socket.id).username = username;
    }
    const { team } = players.get(socket.id);
    socket.emit('joined', { team, username, targets: TARGETS });
    emitLobby();
  });

  // Player connected a wallet (see controller.html connectWallet()) — records the address, and
  // acks back whether this address already paid this round (see paidAddresses above), so a
  // client that reconnected mid-flow (fresh socket.id) can self-heal to "already paid" instead
  // of sending a second buy-in transaction.
  socket.on('wallet', (payload = {}, ack) => {
    const p = players.get(socket.id);
    if (!p) { if (typeof ack === 'function') ack({ alreadyPaid: false }); return; }
    const address = String(payload.address || '');
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) { if (typeof ack === 'function') ack({ alreadyPaid: false }); return; }
    p.address = address;
    const alreadyPaid = paidAddresses.has(address.toLowerCase());
    if (alreadyPaid && !p.paid) p.paid = true;
    emitLobby();
    if (typeof ack === 'function') ack({ alreadyPaid });
  });

  // Player's wallet already sent the buy-in tx client-side (MetaMask signs it on their phone) —
  // this just tells the server to count them into this round's pot. Trust-based for demo speed:
  // we take the reported txHash at face value rather than watching the chain for confirmation.
  socket.on('buyIn', (payload = {}) => {
    if (state.status !== 'waiting') return; // buy-in window is the lobby, before START
    const p = players.get(socket.id);
    if (!p || !p.address || p.paid) return;
    const txHash = String(payload.txHash || '');
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return;
    p.paid = true;
    p.buyInTx = txHash;
    paidAddresses.add(p.address.toLowerCase());
    potWei += BUY_IN_WEI;
    emitLobby();
  });

  socket.on('guess', (payload = {}) => {
    if (state.status !== 'guessing') return;
    const p = players.get(socket.id);
    if (!p || p.guess != null) return;
    const n = Number(payload.guess);
    if (!Number.isFinite(n) || n < 0) return;
    p.guess = Math.round(n);
    maybeFinishGuessing();
  });

  socket.on('tap', (payload = {}) => {
    if (state.status !== 'playing') return;
    const requestedTeam = payload.team;
    const t = ['left', 'right', 'hold'].includes(requestedTeam)
      ? requestedTeam
      : socketTeam.get(socket.id);
    if (!t) return;
    const playersOnTeam = Math.max(1, teamCounts[t]);
    const scaledIncrement = TAP_INCREMENT / playersOnTeam;
    state[t].power = Math.min(100, state[t].power + scaledIncrement);
    const p = players.get(socket.id);
    if (p) {
      p.taps++;
      // throttled: this feeds a cosmetic activity log on the host screen, not gameplay,
      // so under a room full of simultaneous tappers we sample it instead of broadcasting every tap.
      const now = Date.now();
      if (now - lastTapBroadcast > 120) {
        lastTapBroadcast = now;
        io.emit('tapped', { username: p.username, team: t });
      }
    }
  });

  socket.on('disconnect', () => {
    const t = socketTeam.get(socket.id);
    if (t) teamCounts[t]--;
    socketTeam.delete(socket.id);
    if (players.has(socket.id)) {
      players.delete(socket.id);
      emitLobby();
    }
  });
});

// admin reset from the host screen (e.g. after a drop or to start a new round)
app.post('/api/reset', express.json(), (req, res) => {
  resetRound();
  res.sendStatus(200);
});

app.post('/api/start', express.json(), (req, res) => {
  startRound();
  res.sendStatus(200);
});

function tick() {
  const dt = TICK_MS / 1000;

  if (state.status === 'playing') {
    // decay all three bars
    for (const key of ['left', 'right', 'hold']) {
      state[key].power = Math.max(0, state[key].power - DECAY_PER_SEC * dt);
    }

    // steering: right team pushes robot right, left team pushes left
    const steeringForce = (state.right.power - state.left.power) * FORCE_CONST;
    state.robot.v = (state.robot.v + steeringForce) * FRICTION;
    state.robot.v = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, state.robot.v));
    state.robot.x = Math.max(0, Math.min(TRACK_WIDTH, state.robot.x + state.robot.v));

    const nearCoin = Math.abs(state.robot.x - state.coin.x) <= PICKUP_RADIUS;

    // HOLD picks up the coin only once the robot is close enough.
    if (!state.coin.held && nearCoin && state.hold.power >= state.hold.target - 8) {
      state.coin.held = true;
    }

    if (state.coin.held) {
      state.coin.x = state.robot.x;
    }

    // After pickup, HOLD becomes the grip meter. If it drains fully, the coin drops.
    if (state.coin.held && state.hold.power <= 0 && !state.coinDropped) {
      state.coinDropped = true;
      state.coin.held = false;
      state.coin.x = state.robot.x;
      state.status = 'dropped';
      io.emit('dropped');
      scheduleReset(2500);
    }

    // win check: in zone, gripped, and steering balanced (holding steady)
    const inZone = state.robot.x >= WALLET_ZONE.start && state.robot.x <= WALLET_ZONE.end;
    const balanced = Math.abs(state.left.power - state.right.power) <= BALANCE_TOLERANCE;
    const gripped = state.coin.held && state.hold.power > 0;

    if (inZone && balanced && gripped) {
      state.winTimer += dt;
      if (state.winTimer >= WIN_HOLD_SECONDS) {
        onWin();
      }
    } else {
      state.winTimer = 0;
    }
  } else if (state.status === 'guessing') {
    maybeFinishGuessing();
  }

  io.emit('state', {
    ...state,
    teamCounts,
    players: Array.from(players.values()),
    walletZone: WALLET_ZONE,
    coinStartX: COIN_START_X,
    pickupRadius: PICKUP_RADIUS,
    trackWidth: TRACK_WIDTH,
    potMon: (Number(potWei) / 1e18).toFixed(2),
    buyInMon: BUY_IN_MON,
  });
}

setInterval(tick, TICK_MS);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

function getLocalUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 npm start`);
    process.exit(1);
  }
  if (error.code === 'EPERM') {
    console.error(`Could not listen on ${HOST}:${PORT}. Try a different port: PORT=3001 npm start`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  const baseUrls = getLocalUrls(PORT);
  console.log(`Onchain Chaos server running on port ${PORT}`);
  console.log(`  Host screen:  ${baseUrls[0]}/host.html`);
  console.log(`  Controller:   ${baseUrls[0]}/controller.html`);
  if (baseUrls.length > 1) {
    console.log('  Phone URLs on this Wi-Fi:');
    for (const url of baseUrls.slice(1)) {
      console.log(`    ${url}/controller.html`);
    }
  }
});
