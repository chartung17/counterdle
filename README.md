# Counterdle

An adversarial Wordle variant that counters your every move.

## How it's different from Absurdle

The original [Absurdle](https://qntm.org/files/absurdle/absurdle.html) deterministically picks the **largest** remaining bucket (most words still possible) after each guess.

**Counterdle** instead uses **minimax adversarial search**: after each guess, it evaluates every possible response by computing the number of guesses you'd *still* need, in the worst case, if you played perfectly from there — and picks the response that maximizes it. When multiple responses are equally devious, it chooses one **at random** — so even replaying the same guesses can lead to different games.

Under the hood:

- "Can this be finished in 2 more guesses?" is answered **exactly**, by checking every legal guess.
- Deeper positions use a pruned beam search, which gives an upper bound that matches the true value in the vast majority of cases.
- Before committing to a response it believes needs 4+ more guesses, the engine **proves** that response can't be solved in 3, again by checking every legal guess.

Together these mean that (in normal or hard mode) **you can't win in 4 guesses** unless your guesses genuinely leave no response that needs more — and no opening guess does that.

In **hard mode**, every response is scored against only the guesses that stay legal once that response's clues are revealed, at every level of the search, so the adversary can steer you into traps like `_ASTE` that hard mode forces you to work through one word at a time.

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

- Next.js 16 (static export)
- TypeScript
- No runtime dependencies beyond React/Next
- Minimax depth computed on-the-fly in the browser, with memoization and allocation-free pattern scoring
