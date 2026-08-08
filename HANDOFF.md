# ONCHAIN CHAOS — Handoff Notes (Monad Blitz London)

Context: one-day hackathon, hand-in 6pm, Aug 8 2026. This file exists so a fresh session (any tool — Codex, Claude, whoever) can pick up the build with zero prior context. Re-read this fully before changing anything.

## The idea

A crowd game for the big screen. Everyone in the room joins via QR code on their phone (no app install). The room is split into three teams — **LEFT**, **RIGHT**, **HOLD** — and must cooperate to steer a robot over to a coin, pick it up, and carry it into a wallet zone on screen, without dropping it. All three teams must succeed at once: robot in the zone, coin still gripped, steering balanced, held steady for ~3 seconds.

Pitch: "What happens when a whole room plays a game on-chain?" Monad's high throughput is the point — 40+ people tapping simultaneously is itself the demo. Off-chain real-time tech (Socket.IO) drives the fast game loop; Monad only records the meaningful stuff (the final win → NFT mint, and optionally each join).

### Locked mechanic
- 3 teams: LEFT (push robot left), RIGHT (push robot right), HOLD (grip strength / pickup ability).
- Each team has a power bar (0–100) with a **target line**. Tapping fills the bar; it decays continuously if the team stops tapping. The skill is holding the bar AT the line — not under (not enough force), not over (overshoot).
- Movement is continuous/physics-based (velocity + friction), not stepped — this is what creates "don't overshoot" tension.
- The robot must physically reach the coin first. HOLD team must have their bar on-target (within 8 of the target line) when the robot is near the coin for pickup to happen.
- Once picked up, HOLD becomes a grip meter: below its target line → coin visibly slips; hits 0 → coin drops, round fails.
- Win = robot parked in wallet zone + coin still gripped + LEFT/RIGHT roughly balanced, sustained for ~3 seconds (not just a single touch).
- Bars must be big and loud (under/on-target/over states) — a room of 40 needs to self-correct at a glance.

## Current status

**Off-chain game loop is built and working, including a username lobby, operator flow (start/reset), coin pickup mechanic, per-player tap counting, a win → guess-your-taps → leaderboard → MON payout loop, MetaMask mobile wallet connect, and a Render deploy path.** The champion NFT mint is the one Monad piece not yet wired in.

Build order being followed (don't skip ahead):
1. ✅ Phone → controller → robot moves, picks up coin, delivers it, win/drop detected. **DONE**, playable end-to-end locally.
2. ✅ Username lobby (join with a name, wait screen, host-triggered START, controllers reveal on start) and a real public deploy path (Render, not Vercel — see Deploying section). **DONE.**
3. ✅ Tap-guess leaderboard + MON buy-in/payout. **Game-flow and MetaMask wiring DONE** (see "Win → guess-your-taps → leaderboard → MON payout" below) — code-complete and tested with simulated clients, but still needs a `POT_WALLET_PRIVATE_KEY` set up and one real-device MetaMask test before relying on it live.
4. ⬜ Load-test with a realistic number of simultaneous phones and re-tune constants if needed. **Not yet done for real** — only tested with a handful of simulated socket clients, not real devices on real wifi.
5. ⬜ Success → Monad transaction (win → NFT mint). **NOT STARTED.** This is the next concrete task — the `onWin()` hook now also drives the guessing/leaderboard flow, so add the mint call at the top of that function, before/alongside the existing `console.log`.

### What's in the repo

```
onchain-chaos/
  package.json          — deps: express, socket.io, viem (for the payout tx); "engines.node" set for Render
  render.yaml            — Render service config (npm install / npm start, free plan)
  server.js             — game server: Socket.IO, lobby/join, physics tick loop, win/drop detection, operator endpoints
  public/
    host.html            — lobby screen (player list + START) that swaps to the robot screen once playing
    controller.html       — phone page: name entry -> lobby wait -> team-colored big button controller
    simulator.html         — dev tool for simulating a crowd of fake tappers from one browser tab
    assets/logo.png        — the "ONCHAIN CHAOS" wordmark, used as the title image on both host.html and controller.html
```

### Visual style

Both screens now use a dark/violet theme (`#08080c` background, `#8b5cf6` violet accent, monospace font) matching a reference mockup, instead of the earlier navy/yellow palette. Team-specific colors (LEFT blue `#2f6fed`, HOLD green `#2fed8f`, RIGHT orange `#ed8f2f`) and the functional under/on-target/over bar coloring (grey/green/red) were deliberately kept as-is — those are gameplay signal, not decoration, don't reskin them away. `host.html`'s game screen also gained a live-scrolling **LOG** panel (last 8 entries) showing `username tapped TEAM`, fed by a new `tapped` socket event emitted from the `tap` handler in server.js — throttled to at most one broadcast per 120ms since it's cosmetic flavor, not something that should scale with room size the way the physics tick does.

### Run it (locally — this is how it should run at the venue too)

```
npm install     # already run once, node_modules exists
npm start       # starts server on 0.0.0.0:3000
```
On start, the server logs every usable URL (localhost + every non-internal network interface it finds), e.g.:
```
Host screen:  http://localhost:3000/host.html
Controller:   http://localhost:3000/controller.html
Phone URLs on this Wi-Fi:
  http://<laptop-ip>:3000/controller.html
```
The host screen also fetches `/api/join-urls` and displays the controller URL(s) live, so you don't have to go find them in the terminal at the venue.

**⚠️ Do not deploy `server.js` to Vercel.** Vercel's free tier runs serverless functions — short-lived, no persistent memory, no long-lived WebSocket connections. This app needs a process that stays running and keeps `state`/`teamCounts`/`players` in memory and a 20fps `setInterval` loop alive continuously — Vercel will silently break this (players get dropped, state resets randomly). This was confirmed as a deliberate decision, not a TODO — see "Deploying (Render)" below for the path actually used at the venue.

If a tunnel is ever needed instead (e.g. Render is down and you need a fallback fast), run locally and tunnel out:
```
npx cloudflared tunnel --url http://localhost:3000
# or
npx ngrok http 3000
```
and put the tunnel's public URL in the QR code / on the host screen instead of the local IP.

### Deploying (Render)

The app now runs on **Render** (render.com) instead of the laptop/tunnel — a normal git-push deploy that still gives Socket.IO a real, persistent Node process (unlike Vercel).

- `render.yaml` in the repo root describes the service (`npm install` build, `npm start` start, free plan). Render auto-detects this on a new Web Service pointed at the repo, or you can paste the same two commands into the dashboard by hand.
- `server.js` already binds to `0.0.0.0` and reads `process.env.PORT`, which is exactly what Render expects — no server code changes needed for this to work.
- Once deployed, Render gives one stable public URL (`https://<service-name>.onrender.com`). That's the link to put in the QR code / share with the room — `host.html` and `controller.html` are both served from it, same as locally.
- Free-tier Render web services spin down after ~15 min idle and take ~30–60s to wake back up on the next request. **Load the host screen and at least one controller a minute or two before people start scanning the QR code**, so the instance is already warm for the demo. If this ends up being a problem live, upgrading to a paid instance (no spin-down) is the fix.
- `node_modules` is `.gitignore`d now (it was accidentally committed before) — Render's `npm install` build step reinstalls everything fresh from `package.json`/`package-lock.json`, so this doesn't affect the deploy, it just keeps the repo small and avoids shipping a Mac-built `node_modules` to Render's Linux build image.

### How the game logic works (server.js)

- **Join flow**: a socket connecting no longer auto-assigns a team. The controller page shows a name-entry screen first; on submit it emits `join` with `{ username }`. Server sanitizes/truncates the name (`sanitizeUsername()`), assigns a team via `assignTeam()` (fewest players wins, same balancing as before), stores `{ username, team, taps }` in the `players` map, and replies with `joined` (team + targets). Every join/disconnect also broadcasts a `lobby` event (`{ players, teamCounts }`) to everyone, and the same `players` array now rides along on every `state` tick too, so a host-screen refresh mid-lobby self-heals instead of showing a stale/empty list.
- Client emits `tap` → server adds a **per-player-scaled** amount to that team's power: `TAP_INCREMENT / playersOnTeam`, and increments that player's `taps` counter (`players.get(socket.id).taps++`) — this is the running per-player tap count the tap-guess/leaderboard feature (see Next steps) will read from. This means the total force a team can generate doesn't runaway-scale with headcount — a team of 20 and a team of 3 both fill their bar at roughly the same rate per tap-per-person. This was specifically added to make the constants less sensitive to how many people are actually in the room; it's still only been tested with a few simulated clients, not real load, so verify this assumption holds once more devices are available.
- Game only runs (physics, decay, win/drop checks) when `state.status === 'playing'`. States are `waiting → playing → won → guessing → leaderboard → (auto-reset) → waiting`, or `waiting → playing → dropped → (auto-reset) → waiting` on a fail.
  - `waiting`: this is now the **lobby phase** on both screens. `host.html` shows a dedicated lobby screen (join URL, live player chips colored by team, player count, START button) instead of the robot board. `controller.html` shows the name-entry screen (if not yet joined) or a "you're in, waiting for host" screen (if joined) — it does **not** reveal the big colored team button yet. Players stay assigned to the same team across the whole session (team is only assigned once, at `join`, not re-rolled between rounds).
  - Operator presses **START ROUND** (either the lobby screen's big button or the in-game one — both just `POST /api/start`) → resets round state fresh and flips to `playing`. This is also the moment every already-joined controller flips from its "waiting" screen to the actual team-colored tap button — the "screens turn into a controller" reveal happens here, driven purely by the `state.status` change over the existing `state` socket event, no extra event needed.
  - **RESET** button (`POST /api/reset`) is available anytime to hard-reset back to `waiting` (lobby) — this does *not* clear `players`/`teamCounts`, so nobody has to rejoin/re-enter their name for a second round.
  - A player who joins **while a round is already in progress** skips the lobby screen entirely and drops straight into their team controller, same as before this change — only the very first paint depends on current `state.status`.
- A 20fps tick loop (`TICK_MS = 50`) while `playing`:
  - Decays all 3 team powers by `DECAY_PER_SEC`.
  - Steering force = `(right.power - left.power) * FORCE_CONST`; robot velocity gets this force, clamped to `±MAX_SPEED`, then damped by `FRICTION` each tick (glide + deceleration, and the clamp stops a full-room mash from launching the robot straight past the wallet).
  - Coin starts at a fixed `COIN_START_X`, separate from the robot's start position. Robot must get within `PICKUP_RADIUS` of the coin AND have HOLD's power at-or-above `target - 8` at that moment for pickup to trigger. Once held, the coin's position just follows the robot.
  - Grip: once held, if `hold.power` hits 0, coin drops, status → `dropped`, auto-resets after 2.5s.
  - Win: if robot is inside `WALLET_ZONE`, coin is held, hold.power > 0, and `|left.power - right.power| <= BALANCE_TOLERANCE`, a `winTimer` accumulates; at `WIN_HOLD_SECONDS` (3s) it fires `onWin()`.
- **`onWin()` sets status to `won` (2.5s full-screen "CROWD WINS" celebration on both screens) then hands off to the guess/leaderboard/payout flow below.** The Monad champion-NFT mint (Next steps item 1) still needs to be wired into `onWin()` itself — search for `onWin` in server.js.

### Win → guess-your-taps → leaderboard → MON payout

After a win, instead of resetting immediately the game runs a second mini-loop, driven entirely by `state.status`:

1. **`won`** (`WIN_CELEBRATION_MS` = 2.5s) — full-screen "🎉 CROWD WINS!" takeover on both `host.html` and `controller.html` (not a small banner — deliberately covers the whole screen, see `#celebration-screen` in both files).
2. **`guessing`** (`GUESS_WINDOW_MS` = 20s, or ends early once every joined player has guessed) — full-screen "🤔 CHECK YOUR PHONES" takeover on the host with a live countdown; each phone shows a number-input prompt ("how many times do you think YOU tapped?"). `startGuessingPhase()`/`maybeFinishGuessing()` in server.js drive this; a player's guess comes in via the `guess` socket event and is stored on `players.get(socket.id).guess`.
3. **`leaderboard`** (`LEADERBOARD_DISPLAY_MS` = 15s) — `finishGuessing()` ranks every player by `|guess - actualTaps|` (closest wins; anyone who never guessed sorts last via `diff = Infinity`), broadcasts `state.leaderboard` + `state.winnerUsername`, and calls `onPayout(winner)`. The host shows a full ranked table; the winner's own phone shows "🏆 WINNER! You won X MON", everyone else sees their own guess/rank.
4. Auto-resets back to `waiting` (lobby) after the display window — same `resetRound()` as before, so nobody has to rejoin. `paid`/`buyInTx`/`guess` are cleared per-player on reset (so buy-in and guessing both happen fresh each round); `address` and `username` persist.

**Buy-in / pot / payout — the MetaMask piece:**
- Confirmed with the user this is testnet MON (attendees already have demo wallets from faucet setup) — poker chips, not real-money gambling.
- No smart contract — deliberately kept to plain wallet-to-wallet MON transfers, same "server holds a private key, signs one tx" pattern already proven with GMBoard, since a from-scratch escrow contract was too much new-code risk for a same-day deadline.
- **Buy-in** (client-side, `controller.html`'s `connectWallet()`): on the lobby screen, "CONNECT WALLET & BUY IN" — since mobile browsers don't have `window.ethereum`, if it's missing we bounce to `https://metamask.app.link/dapp/<url>` (MetaMask's own in-app browser, which does have it), then `eth_requestAccounts` → `wallet_switchEthereumChain`/`wallet_addEthereumChain` to Monad testnet (10143) → `eth_sendTransaction` sending `BUY_IN_WEI` (0.5 MON, tune the constant in server.js) to the pot wallet address. The resulting txHash is reported to the server via the `buyIn` socket event — **trust-based, not chain-verified**, i.e. the server takes the reported hash at face value rather than polling the RPC for confirmation, which was a deliberate speed-over-rigor call for a live demo; revisit if this ever needs to be tamper-resistant.
- **Payout** (server-side, `onPayout()` in server.js): sums `BUY_IN_WEI × paid-player-count` into `potWei`, and on `finishGuessing()` sends the whole pot to the winner's connected address via `viem`, signed by `POT_WALLET_PRIVATE_KEY`.
- **Setup needed before this goes live** (nothing works — buy-in UI hides itself, payout logs a stub message — until this is done):
  1. Create a wallet **dedicated to this pot** (don't reuse the main dev wallet `0x41d02...` — keeps blast radius limited to demo funds only). Any method works: MetaMask "Add account", or run `node -e "console.log(require('viem/accounts').generatePrivateKey())"` from this repo (viem's already a dependency) to get a fresh key locally.
  2. Fund it with a little testnet MON from the faucet — just enough for the final payout tx's own gas.
  3. Set `POT_WALLET_PRIVATE_KEY` as an environment variable — locally in a `.env`-style export (never commit it; `.env` is already `.gitignore`d) and on Render under the service's Environment settings. The pot wallet's public address is *derived* from this key at boot (`payoutAccount.address`, logged on startup) and served to clients via `GET /api/config` — there's no separate address env var to keep in sync.
  4. Restart the server — the startup log line changes from `POT_WALLET_PRIVATE_KEY not set — ... log-only stub mode` to `Pot wallet configured: 0x... — payouts are LIVE.` That's the confirmation it's wired up.
- Tested end-to-end with simulated Socket.IO clients (win → celebration → guessing countdown → leaderboard ranked correctly, including a player who never guessed sorting last) — **not yet tested with a real MetaMask wallet doing a real buy-in/payout tx**, since that needs the pot wallet set up per above first.

### Known open work / things to tune

- **Still needs a real multi-device load test.** The per-player scaling (above) should make crowd size less of a problem than before, but it hasn't been tried with more than a few simultaneous connections. Test with as many phones/tabs as you can before relying on it live, and be ready to adjust `TAP_INCREMENT`, `DECAY_PER_SEC`, `FORCE_CONST`, `MAX_SPEED`, `FRICTION`, `BALANCE_TOLERANCE` at the top of server.js.
- No QR code generator yet — need a page/image that encodes whatever URL players should hit (local IP or tunnel URL depending on venue wifi).
- No difficulty ramp between rounds yet — `TARGETS.left/right/hold` are hardcoded; the spec allows moving these between rounds for difficulty, not implemented.
- Team counts are shown on the host screen (`s.teamCounts`) but there's no rebalancing if it gets lopsided mid-game (e.g. one team disconnects a lot) beyond new joiners preferring the smallest team.

## Next steps (in order)

1. **Wire the win → Monad mint.** Priority task.
   - Write an ERC-721 contract (same pattern as the GMBoard learning contract below — replace `sayGM` with a `mint(address to)` / champion or badge mint function).
   - Deploy via Remix with "Injected Provider - MetaMask" (NOT the Remix VM) to Monad testnet, chain ID 10143.
   - From `server.js`'s `onWin()`, call that contract server-side (e.g. via `viem` or `ethers`, using a server-held private key, since this is a server-triggered mint, not something a user signs). Decide up front whether the champion NFT mints to one fixed "team/demo wallet" (simplest, no per-player addresses needed) or to individual players (requires the join-tx step below first). **For a working demo under time pressure, mint to one fixed wallet — simplest path.**
2. **(Stretch) Join → Monad transaction.** Each player's join could be a tiny on-chain tx giving them an on-chain identity, enabling per-player badge NFTs later. Requires either MetaMask on every phone (friction, slow) or a burner-wallet SDK (e.g. Privy) for silent wallets. Cut this first if time runs short — the win→NFT mint is what makes the demo work.
3. **Tap-guess leaderboard + MON buy-in/payout — DONE, needs the pot wallet set up.** Full flow built: win → full-screen celebration → full-screen "guess your taps" countdown → leaderboard ranked by guess accuracy → winner's phone shows "WINNER! You won X MON" → server sends the pot via `viem`. MetaMask mobile connect (deep-link into MetaMask's in-app browser, since regular mobile browsers have no `window.ethereum`) is wired into `controller.html`'s lobby screen as a combined "connect + buy in" button. See the "Win → guess-your-taps → leaderboard → MON payout" section above for exactly how it works and the **setup steps needed before it does anything live** (create + fund a pot wallet, set `POT_WALLET_PRIVATE_KEY`). Until that's done the app runs fine, buy-in just stays hidden and payout logs a stub message instead of sending MON.
   - Tested with simulated Socket.IO clients end-to-end (including the "someone never guesses" timeout fallback). **Not yet tested with a real phone + MetaMask** doing an actual buy-in transaction — do that once the pot wallet is funded, ideally before relying on it at the venue.
4. Add the QR code page/flow pointing at the right URL for the venue.
5. Load-test with more simultaneous controllers than available people right now (open many browser tabs / ask friends to join, or use `public/simulator.html`); re-tune constants.
6. Optional flex: log each tap as an on-chain tx too, to flood the block explorer live during the demo. Not core loop — cut first if time is short.

## Key reference facts (Monad testnet)

- Chain ID: **10143**
- RPC: `https://testnet-rpc.monad.xyz`
- Token: MON (testnet, free from faucet)
- Explorer: `https://testnet.monadexplorer.com`
- Monad **mainnet** is chain ID 143 — real money, avoid entirely for this project.
- Wallet used for building: `0x41d02ef60E12C8bDD806b0b90866452C83e8A553`

### Already proven working
- MetaMask set up (Chrome + phone), fresh wallet, Monad testnet added, mainnet disabled to avoid accidental real-money txs.
- Wallet funded with testnet MON via faucet.
- The "GMBoard" learning contract was deployed via Remix (Injected Provider - MetaMask, NOT Remix VM) and its `sayGM()` function called successfully — proved the full loop: write contract → deploy → transact → read state back. That loop is the template for the NFT mint contract in step 1 above.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract GMBoard {
    uint256 public gmCount;
    string public lastMessage;
    address public lastSender;

    event GM(address indexed sender, string message);

    function sayGM(string calldata message) external {
        gmCount += 1;
        lastMessage = message;
        lastSender = msg.sender;
        emit GM(msg.sender, message);
    }
}
```

## Safety reminders (still apply)

- Testnet only. Never paste the seed phrase anywhere — no legit faucet/tool/support ever asks for it, only the public `0x...` address.
- Confirm chain ID is 10143 before any transaction (MetaMask defaults to mainnet 143 — real money — if not switched).
- Faucet drips are rate-limited (~12–24h) — don't stress-test the balance away right before the demo.
- MetaMask's approval popup sometimes hides behind the browser window — if a transaction seems to hang, check for it there.
- Remix's "Deploy" environment must be "Injected Provider - MetaMask", not the default Remix VM, or it deploys to a fake local chain instead of the real testnet.
- Don't deploy `server.js` to Vercel (see Deployment section above) — run it locally, tunnel if needed.
