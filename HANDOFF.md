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

**Off-chain game loop is built and working, including a username lobby, operator flow (start/reset), coin pickup mechanic, per-player tap counting, and a Render deploy path.** Nothing touches Monad yet — that's the deliberate next checkpoint.

Build order being followed (don't skip ahead):
1. ✅ Phone → controller → robot moves, picks up coin, delivers it, win/drop detected. **DONE**, playable end-to-end locally.
2. ✅ Username lobby (join with a name, wait screen, host-triggered START, controllers reveal on start) and a real public deploy path (Render, not Vercel — see Deploying section). **DONE.**
3. ⬜ Load-test with a realistic number of simultaneous phones and re-tune constants if needed. **Not yet done for real** — only tested with a handful of simulated socket clients, not real devices on real wifi.
4. ⬜ Success → Monad transaction (win → NFT mint, optionally join → tx too). **NOT STARTED.** This is the next concrete task.
5. ⬜ Tap-guess leaderboard + MON buy-in/payout (see "Next steps" below). **NOT STARTED**, blocked on a wallet-connection decision.

### What's in the repo

```
onchain-chaos/
  package.json          — deps: express, socket.io; now has "engines.node" for Render
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
- Game only runs (physics, decay, win/drop checks) when `state.status === 'playing'`. States are `waiting → playing → won | dropped → (auto-reset) → waiting`.
  - `waiting`: this is now the **lobby phase** on both screens. `host.html` shows a dedicated lobby screen (join URL, live player chips colored by team, player count, START button) instead of the robot board. `controller.html` shows the name-entry screen (if not yet joined) or a "you're in, waiting for host" screen (if joined) — it does **not** reveal the big colored team button yet. Players stay assigned to the same team across the whole session (team is only assigned once, at `join`, not re-rolled between rounds).
  - Operator presses **START ROUND** (either the lobby screen's big button or the in-game one — both just `POST /api/start`) → resets round state fresh and flips to `playing`. This is also the moment every already-joined controller flips from its "waiting" screen to the actual team-colored tap button — the "screens turn into a controller" reveal happens here, driven purely by the `state.status` change over the existing `state` socket event, no extra event needed.
  - **RESET** button (`POST /api/reset`) is available anytime to hard-reset back to `waiting` (lobby) — this does *not* clear `players`/`teamCounts`, so nobody has to rejoin/re-enter their name for a second round.
  - A player who joins **while a round is already in progress** skips the lobby screen entirely and drops straight into their team controller, same as before this change — only the very first paint depends on current `state.status`.
- A 20fps tick loop (`TICK_MS = 50`) while `playing`:
  - Decays all 3 team powers by `DECAY_PER_SEC`.
  - Steering force = `(right.power - left.power) * FORCE_CONST`; robot velocity gets this force, clamped to `±MAX_SPEED`, then damped by `FRICTION` each tick (glide + deceleration, and the clamp stops a full-room mash from launching the robot straight past the wallet).
  - Coin starts at a fixed `COIN_START_X`, separate from the robot's start position. Robot must get within `PICKUP_RADIUS` of the coin AND have HOLD's power at-or-above `target - 8` at that moment for pickup to trigger. Once held, the coin's position just follows the robot.
  - Grip: once held, if `hold.power` hits 0, coin drops, status → `dropped`, auto-resets after 2.5s.
  - Win: if robot is inside `WALLET_ZONE`, coin is held, hold.power > 0, and `|left.power - right.power| <= BALANCE_TOLERANCE`, a `winTimer` accumulates; at `WIN_HOLD_SECONDS` (3s) it fires `onWin()`, which sets status to `won` and auto-resets after 6s.
- **`onWin()` currently just does `console.log(...)`.** This is the exact hook to wire the Monad mint call into — search for `onWin` in server.js.

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
3. **(New, blocked) Tap-guess leaderboard + real MON buy-in/payout.** The ask: on a win, pop up a "how many times do you think you tapped?" prompt for every player, then a leaderboard ranked by guess accuracy against their real tap count (already tracked server-side — see `players[i].taps` in server.js). The top player wins the room's MON buy-in pot. Confirmed with the user this is **testnet MON, not real currency** — every hackathon attendee already has a demo wallet — so this is closer to poker chips than real-money gambling, and is fine to build.
   - **Foundation already in place**: `server.js` now tracks `taps` per player (incremented in the `tap` handler) and includes it in every `players` array sent to clients, so the leaderboard has real data to compare guesses against with no further server-side plumbing for the counting part.
   - **Still needed**: (a) the guess-prompt UI on `controller.html` and leaderboard UI on `host.html`; (b) a Solidity contract (pot escrow: players deposit a MON buy-in, contract pays the full pot to the winning address) — same Remix/Injected-MetaMask deploy pattern as GMBoard/the NFT mint; (c) **a decision on how each phone connects a wallet to actually send the buy-in tx** — MetaMask mobile deep-link (simplest to build, can be flaky opening/returning from the MetaMask app on some phones) vs. a burner-wallet SDK like Privy (smoother UX, but needs a Privy account/API key set up first, which hasn't happened yet). Pick this before starting the contract/UI work — it changes both the contract shape (does it verify `msg.sender` against a connected wallet, or a server-attributed address?) and the client code.
   - Given the 6pm deadline, treat this as sequenced *after* the Monad mint hook (item 1) is working — that's the simpler, already-scoped win condition and the one thing that must not slip.
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
