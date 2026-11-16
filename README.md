# Halli Galli Online

Real-time multiplayer Halli Galli for 2–6 players. Zero dependencies — just Node 18+.

## Run

```bash
node server.js          # or: npm start
# open http://localhost:3000
```

One player clicks **Create room** and shares the 4-letter code (or the invite link); the others click **Join**. The host starts the game.

## Play over the internet

- **Quick:** `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) and share the URL.
- **Permanent:** deploy to any Node host (Render, Railway, Fly.io…). Start command `node server.js`; it respects `PORT`.
- Same Wi-Fi: friends open `http://<your-LAN-ip>:3000`.

## Rules implemented

- 56 cards: 4 fruits × (5×"1", 3×"2", 3×"3", 2×"4", 1×"5").
- On your turn flip your top card onto your face-up pile.
- If the visible top cards add up to exactly 5 of one fruit, anyone can ring. First ring wins every face-up card (shuffled under their deck).
- Wrong ring: pay one card to each other player.
- No cards at all (deck and pile) = out. Last player standing wins.
- Idle or disconnected players are auto-flipped (12s / 1.2s) so the game never stalls. Refreshing the page reconnects you.

Keys: **Space** = bell, **Enter/F** = flip.

Architecture: server is authoritative (in-memory rooms); state is pushed with Server-Sent Events, actions are plain POSTs. The server never sends hidden info (only top cards and counts).

## Accounts, ranking & ranked mode

- On the home screen, **Register** or **Log in** with a username + password. Guests can still play, unranked.
- Rooms are **casual by default**. The host can toggle **Ranked mode** in the lobby: only signed-in players can be in a ranked room, and Elo changes at the end of the game. Casual games never change ratings.
- Rating is multiplayer Elo (everyone starts at 1000; new players move faster for their first 10 ranked games). Placement = winner first, then by elimination order. Tiers: Bronze, Silver (900+), Gold (1100+), Platinum (1300+), Diamond (1500+), Master (1700+).
- The **leaderboard** is shown on the home screen and in the lobby, with tier badges next to each player and a "● in room" marker.
- Accounts and ratings are stored in `data.json` next to `server.js` (set `DATA_FILE` to move it). Passwords are salted + scrypt-hashed. Use an `https://` URL when playing over the internet, since passwords travel in the login request.
- Free hosts with ephemeral disks (e.g. Render free tier) wipe `data.json` on redeploy; use a persistent disk or `DATA_FILE` on a mounted volume to keep ranks.
