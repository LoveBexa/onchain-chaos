// ONCHAIN CHAOS — game server
// Off-chain real-time layer only. Nothing here touches Monad yet.
// When the crowd wins, onWin() below is the hook where the mint call goes later.

const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---- tunables (adjust these live at the venue based on crowd size) ----
const TICK_MS = 50; // 20fps game loop
const TAP_INCREMENT = 12.5; // base power added per tap before team-size scaling
const DECAY_PER_SEC = 35; // power lost per second when not tapped
const FORCE_CONST = 0.016; // how hard power translates into robot velocity
const FRICTION = 0.86; // per-tick velocity damping (glide + slow down)
const MAX_SPEED = 14; // prevents the crowd from launching past the targets
const TRACK_WIDTH = 1000; // arbitrary units, robot x ranges 0..TRACK_WIDTH
const COIN_START_X = 430;
const PICKUP_RADIUS = 45;
const WALLET_ZONE = { start: 820, end: 950 };
const BALANCE_TOLERANCE = 15; // |left-right| must be under this to count as "steady"
const WIN_HOLD_SECONDS = 3;

const TARGETS = { left: 70, right: 70, hold: 60 };

function freshState() {
  return {
    left: { power: 0, target: TARGETS.left },
    right: { power: 0, target: TARGETS.right },
    hold: { power: 0, target: TARGETS.hold },
    robot: { x: 50, v: 0 },
    coin: { x: COIN_START_X, held: false },
    coinDropped: false,
    winTimer: 0,
    status: 'waiting', // waiting | playing | won | dropped
  };
}

let state = freshState();
const teamCounts = { left: 0, right: 0, hold: 0 };
const socketTeam = new Map();
let resetTimeout = null;

function assignTeam() {
  // balance new joiners across the three teams
  let team = 'right';
  if (teamCounts.hold < teamCounts[team]) team = 'hold';
  if (teamCounts.left < teamCounts[team]) team = 'left';
  teamCounts[team]++;
  return team;
}

function resetRound() {
  if (resetTimeout) {
    clearTimeout(resetTimeout);
    resetTimeout = null;
  }
  state = freshState();
  io.emit('reset');
}

function startRound() {
  if (resetTimeout) {
    clearTimeout(resetTimeout);
    resetTimeout = null;
  }
  state = freshState();
  state.status = 'playing';
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
  scheduleReset(6000);
}

io.on('connection', (socket) => {
  const team = assignTeam();
  socketTeam.set(socket.id, team);
  socket.emit('assigned', { team, targets: TARGETS });

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
  });

  socket.on('disconnect', () => {
    const t = socketTeam.get(socket.id);
    if (t) teamCounts[t]--;
    socketTeam.delete(socket.id);
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
  }

  io.emit('state', {
    ...state,
    teamCounts,
    walletZone: WALLET_ZONE,
    coinStartX: COIN_START_X,
    pickupRadius: PICKUP_RADIUS,
    trackWidth: TRACK_WIDTH,
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
