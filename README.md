# Counterdle

An adversarial Wordle variant that counters your every move.

## How it's different from Absurdle

The original [Absurdle](https://qntm.org/files/absurdle/absurdle.html) deterministically picks the **largest** remaining bucket (most words still possible) after each guess.

**Counterdle** instead uses **minimax adversarial search**: after each guess, it evaluates every possible response by computing the maximum number of guesses you'd *still* need to force a solve, and picks the response that maximizes that depth. When multiple responses are equally devious, it chooses one **at random** — so even replaying the same guesses can lead to different games.

## Deploy to GitHub Pages

1. Fork or push this repo to GitHub
2. Go to **Settings → Pages**
3. Set **Source** to **GitHub Actions**
4. Push to `main` — the workflow in `.github/workflows/deploy.yml` handles the rest

If your repo is at a sub-path (e.g. `/counterdle`), add `basePath: "/counterdle"` to `next.config.ts`.

## Run locally

```bash
npm install
npm run dev
```

## Tech

- Next.js 15 (static export)
- TypeScript
- No runtime dependencies beyond React/Next
- Minimax depth computed on-the-fly with memoization
