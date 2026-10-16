# SKYTHREAD — working rules for Claude

Start every session by reading `DEVAM-ET.md` (status, what is left, how to resume), then `docs/ROADMAP.md`, `docs/DECISIONS.md` and the designs in `docs/design/`. The project owner writes in Turkish; answer in Turkish.

## Rules the project owner set

1. **No code in the main conversation.** The main conversation orchestrates only: it plans, delegates, reviews results, merges and pushes. All code is written by subagents, and you choose the model and effort per task (complex simulation/netcode/rendering: strongest model, high effort; reviews and small fixes: lighter).
2. **Investigate first, then ask.** Before big decisions, study the code and ask the owner multiple-choice questions. Decisions already made are recorded in `docs/ROADMAP.md` (Decisions) and `DEVAM-ET.md` section 4 — apply them, don't ask again.
3. **Clean up bugs you meet while writing code.** After each milestone, a separate agent reviews the diff for bugs, and the findings get fixed.
4. **Every milestone:** `npm run typecheck`, `npm run build`, `npm run build:server`, the relevant Playwright specs (and `npm run test:server`) pass → commit → push. Never weaken, skip or quarantine a test; fix the root cause. Measure time-dependent checks in simulation ticks, not wall-clock time (software GL is slow).
5. **In-game text is Turkish** (`src/i18n/tr.ts`); code comments and `docs/` are English. Match the surrounding code style; no new runtime dependencies without a reason.
6. **No real brands or trademarked characters.** Bosses are inspired by Spider-Man villains but original (Koçbaşı, Kuzgun, Diken); shop signs are invented.
7. **Parallel work** uses separate `git worktree`s, each with its own dev port (`SKYTHREAD_DEV_PORT=5302` …) and Playwright `--workers=1`. The full suite (with the soak test) runs only on the main checkout, alone; it runs out of memory when other browser tests run at the same time.
8. **Be frugal with usage limits.** Don't fan out more agents than needed; prefer a fresh agent per chunk over one very long agent context; don't re-run long specs without a reason.
9. The simulation code in `src/combat/**` (except `client/` and `render/`), `src/sim/**`, `src/net/{protocol,codec,names,maps,clock,interp}.ts` and `src/maps/ids.ts` must stay pure (no DOM, no rendering, no Node APIs): the same code runs in the browser and on the Node server. Purity specs check this.

## Useful commands

```bash
npm ci
npm run dev                      # game, http://127.0.0.1:5173
npm run server:test              # game server for online play in dev (127.0.0.1:8787)
npm run typecheck && npm run build && npm run build:server
npm run test:server              # Node-side tests, fast
npx playwright test tests/<name>.spec.ts --workers=1
npm test                         # whole suite incl. the 30-minute soak (run alone)
docker compose up -d --build     # deployment (see README "Deploy")
```
