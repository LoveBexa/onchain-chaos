# ONCHAIN CHAOS — Handoff Notes (Monad Blitz London)

Context: one-day hackathon, hand-in 6pm, Aug 8 2026. Moving from Claude to Codex mid-build — this file is so Codex (or anyone) can pick up with zero prior context.

## The idea

A crowd game for the big screen. Everyone in the room joins via QR code on their phone (no app install). The room is split into three teams — **LEFT**, **RIGHT**, **HOLD** — and must cooperate to steer a robot carrying a coin into a wallet zone on screen, without dropping the coin. All three teams must succeed at once: robot in the zone, coin still gripped, steering balanced, held steady for ~3 seconds.

Pitch: "What happens when a whole room plays a game on-chain?" Monad's high throughput is the point — 40+ people tapping simultaneously is itself the demo. Off-chain real-time tech (Socket.IO) drives the fast game loop; Monad only records the meaningful stuff (joining, and the final win → NFT mint).

Full mechanic spec, design rationale, and the original hackathon brief (tech stack, timeline, safety rules) are preserved in the conversation history — the key mechanic points are restated below since they're load-bearing for anyone continuing the build.

### Locked mechanic
- 3 teams: LEFT (push robot left), RIGHT (push robot right), HOLD (keep coin gripped).
- Each team has a power bar (0–100) with a **target line**. Tapping fills the bar; it decays continuously if the team stops tapping. The skill is holding the bar AT the line — not under (not enough force), not over (overshoot).
- Movement is continuous/physics-based (velocity + friction), not stepped — this is what creates "don't overshoot" tension.
- HOLD bar is a grip meter: below its target line → coin visibly slips; hits 0 → coin drops, round fails.
- Win = robot parked in wallet zone + coin still gripped + LEFT/RIGHT roughly balanced, sustained for ~3 seconds (not just a single touch).
- Bars must be big and loud (under/on-target/over states) — a room of 40 needs to self-correct at a glance.

## Current status

**Off-chain game loop is built and working.** Nothing touches Monad yet — that's the deliberate next checkpoint, not done yet.

Build order being followed (don't skip ahead):
1. ✅ Phone → controller → robot moves on screen (off-chain, Socket.IO). **DONE.**
2. ⬜ Robot reaches wallet + win condition fires reliably with a real multi-player test. **Partially done** — win logic exists in code but has only been smoke-tested with 2-3 browser tabs, not a real crowd.
3. ⬜ Success → Monad transaction (join tx and/or win → NFT mint). **NOT STARTED.**

### What's in the repo

```
onchain-chaos/
  package.json          — deps: express, socket.io
  server.js             — game server: Socket.IO, physics tick loop, win detection
  public/
    host.html            — the big screen: robot, coin, wallet zone, 3 bars
    controller.html       — phone page: big team-colored button + mini bar
```

Run it:
```
npm install     # already run once, node_modules exists
npm start       # starts server on port 3000
```
- Host screen: http://localhost:3000/host.html (this is what gets projected)
- Controller: http://localhost:3000/controller.html (open multiple tabs to simulate players; each gets auto-assigned round-robin to LEFT/RIGHT/HOLD)
- For real phones on the same wifi as the laptop: `http://<laptop-local-ip>:3000/controller.html` (was `http://10.0.2.99:3000/controller.html` at time of writing — **re-check this IP on the day/venue wifi**, it will change).

### How the game logic works (server.js)

- Each connecting socket is assigned to whichever of the 3 teams currently has the fewest players (`assignTeam()`).
- Client emits `tap` on button press → server adds `TAP_INCREMENT` to that team's power (capped at 100).
- A 20fps tick loop (`TICK_MS = 50`):
  - Decays all 3 team powers by `DECAY_PER_SEC` (this constant decay is what forces continuous tapping, not one big mash).
  - Steering force = `(right.power - left.power) * FORCE_CONST`; robot velocity gets this force applied, then damped by `FRICTION` each tick (this is what makes it glide/overshoot instead of snapping).
  - Grip: if `hold.power` hits 0, coin drops, round status becomes `dropped`, auto-resets after 2.5s via `POST /api/reset`.
  - Win: if robot.x is inside `WALLET_ZONE`, hold.power > 0, and `|left.power - right.power| <= BALANCE_TOLERANCE`, a `winTimer` accumulates; at `WIN_HOLD_SECONDS` (3s) it fires `onWin()`.
- **`onWin()` currently just does `console.log(...)`.** This is the exact hook to wire the Monad mint call into. Search for `onWin` in server.js.

### Known open work / things to tune

- **Physics constants are untested with real crowd sizes.** `TAP_INCREMENT`, `DECAY_PER_SEC`, `FORCE_CONST`, `FRICTION`, `BALANCE_TOLERANCE` were guessed for testing with 2-3 browser tabs, not 40 phones. With real crowd volume, aggregate tap rate per team will be much higher — decay rate almost certainly needs to increase significantly (or tap increment needs to shrink) or the bars will pin at 100 instantly. **Load-test with as many devices as you can before the real demo, or at minimum simulate with a keyboard-mashing script.**
- No QR code page yet — need a simple page/image that points at `http://<venue-wifi-ip>:3000/controller.html`.
- No visual "team distribution" — if uneven numbers join each team (e.g. way more people tap LEFT because the QR/instructions favor it), that unbalances the physics. Might want a way to see/display team counts on the host screen.
- No round reset/start button visible on host screen (reset is auto-triggered only on coin drop). May want a manual "next round" button for the operator.
- No difficulty ramp / target line changes between rounds yet (spec allows moving `TARGETS.left/right/hold` between rounds for difficulty — currently hardcoded in server.js).

## Next steps (in order)

1. **Wire the win → Monad mint.** This is the next concrete task.
   - Write an ERC-721 contract (start from the same pattern as the GMBoard learning contract already deployed — see below — just replace `sayGM` with a `mint(address to)` or similar champion/badge mint function).
   - Deploy via Remix with "Injected Provider - MetaMask", environment set correctly, to Monad testnet (chain ID 10143).
   - From `server.js`'s `onWin()`, make a transaction call to that contract (likely via `viem` or `ethers` with a server-held wallet/key, since this is a server-triggered mint, not a user-signed one — decide whether the champion NFT goes to a fixed "team wallet" or needs per-player addresses, which requires the join step below).
2. **(Optional but part of the original story) Join → Monad transaction.** Each player's join could be a tiny on-chain transaction ("I am joining the on-chain crowd") giving them an on-chain identity, so a per-player badge NFT is possible later. This requires either MetaMask on each phone (friction) or a burner-wallet SDK (e.g. Privy) for silent wallets — flagged in the original brief as the "no MetaMask needed" option. **Given time constraints, this is a stretch goal — the win→NFT mint from step 1 is the priority for a working demo.**
3. Add the QR code page/flow.
4. Load-test with more simultaneous controllers than you have people for right now; re-tune constants in server.js.
5. Optional flex: log each tap as an on-chain transaction too, to flood the block explorer live during the demo ("look how much Monad can take"). Not core loop — cut this first if time is short.

## Key reference facts (Monad testnet)

- Chain ID: **10143**
- RPC: `https://testnet-rpc.monad.xyz`
- Token: MON (testnet, free from faucet)
- Explorer: `https://testnet.monadexplorer.com`
- Monad **mainnet** is chain ID 143 — real money, avoid entirely for this project.
- Wallet used for building: `0x41d02ef60E12C8bDD806b0b90866452C83e8A553`

### Already proven working (before this build session)
- MetaMask set up (Chrome + phone), fresh wallet, Monad testnet added, mainnet disabled to avoid accidental real-money txs.
- Wallet funded with testnet MON via faucet.
- The "GMBoard" learning contract was deployed via Remix (Injected Provider - MetaMask, NOT Remix VM) and its `sayGM()` function called successfully — this proved the full loop: write contract → deploy → transact → read state back. That loop is the template for the NFT mint contract in step 1 above.

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
