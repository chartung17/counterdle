// Core game logic for Counterdle.
//
// Word lists:
//   - Answers (~2,308 words): https://gist.github.com/slushman/34e60d6bc479ac8fc698df8c226e4264
//     Credit: slushman (https://gist.github.com/slushman)
//   - Guesses (~14,855 words): https://github.com/tabatkins/wordle-list/blob/main/words
//     Credit: Tab Atkins Jr. (https://github.com/tabatkins)
//
// The adversarial engine picks the response (bucket) that maximizes the
// number of guesses the player will still need:
//   - For small buckets (<= EXACT_MINIMAX_THRESHOLD words), we compute the
//     TRUE minimax depth via recursion. This is only tractable because the
//     bucket itself is small and we only recurse on buckets, never on the
//     full pool.
//   - For larger buckets we fall back to an information-theoretic estimate
//     (bits needed / best achievable bits per guess), which is cheap and a
//     good proxy for minimax depth without the combinatorial blowup.
// Buckets within TIE_THRESHOLD (relative) of the best score are treated as
// equally hard and chosen among at random, so the game doesn't play out
// deterministically even when one bucket is nominally a hair "better."
//
// Hard mode restricts which words count as legal guesses (both for the
// player's input validation, and for the set of guesses the adversary
// assumes the player COULD make when estimating difficulty): a guess must
// reuse every revealed clue. This is the standard Wordle hard-mode rule,
// and it genuinely changes the minimax value, not just the player's options.

export type TileState = "correct" | "present" | "absent";
export type Pattern = TileState[];

export type RevealedClue = {
  // Position -> letter that's confirmed correct (green) there.
  greens: (string | null)[]; // length 5
  // Letters confirmed present somewhere (yellow), with minimum count known.
  minCounts: Record<string, number>;
  // Positions where a given letter is known NOT to be (yellow elsewhere, or
  // absent entirely if minCounts[letter] is undefined/0).
  excludedPositions: Record<string, Set<number>>;
};

// ---------------------------------------------------------------------------
// Pattern computation
// ---------------------------------------------------------------------------

export function computePattern(guess: string, target: string): Pattern {
  const result: TileState[] = Array(5).fill("absent");
  const targetCounts: Record<string, number> = {};

  for (let i = 0; i < 5; i++) {
    if (guess[i] === target[i]) {
      result[i] = "correct";
    } else {
      targetCounts[target[i]] = (targetCounts[target[i]] || 0) + 1;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (result[i] === "absent" && targetCounts[guess[i]] > 0) {
      result[i] = "present";
      targetCounts[guess[i]]--;
    }
  }

  return result;
}

// Encode a pattern as a base-3 integer (0–242) for fast hashing/comparison.
export function patternToInt(pattern: Pattern): number {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const v = pattern[i] === "correct" ? 2 : pattern[i] === "present" ? 1 : 0;
    n = n * 3 + v;
  }
  return n;
}

export function intToPattern(n: number): Pattern {
  const vals: TileState[] = [];
  for (let i = 0; i < 5; i++) {
    const v = n % 3;
    vals.unshift(v === 2 ? "correct" : v === 1 ? "present" : "absent");
    n = Math.floor(n / 3);
  }
  return vals;
}

const WIN_INT = 242; // 22222 in base 3

export function isWin(pattern: Pattern): boolean {
  return pattern.every((s) => s === "correct");
}

// ---------------------------------------------------------------------------
// Hard mode: legal-guess filtering
// ---------------------------------------------------------------------------

// Merge a new (guess, pattern) result into the accumulated revealed-clue
// state, used to filter which future guesses are legal under hard mode.
export function accumulateClue(
  prev: RevealedClue,
  guess: string,
  pattern: Pattern
): RevealedClue {
  const greens = [...prev.greens];
  const minCounts = { ...prev.minCounts };
  const excludedPositions: Record<string, Set<number>> = {};
  for (const [k, v] of Object.entries(prev.excludedPositions)) {
    excludedPositions[k] = new Set(v);
  }

  // Count letters revealed as present (green or yellow) in this guess, to
  // compute a minimum-occurrence count per letter.
  const presentCounts: Record<string, number> = {};

  for (let i = 0; i < 5; i++) {
    const letter = guess[i];
    const state = pattern[i];
    if (state === "correct") {
      greens[i] = letter;
      presentCounts[letter] = (presentCounts[letter] || 0) + 1;
    } else if (state === "present") {
      presentCounts[letter] = (presentCounts[letter] || 0) + 1;
      if (!excludedPositions[letter]) excludedPositions[letter] = new Set();
      excludedPositions[letter].add(i);
    }
  }

  // Grey (absent) tiles: the letter is confirmed NOT at this position. If
  // the letter never appeared as green/yellow anywhere in this guess, it's
  // confirmed absent from the word entirely, but we still only need the
  // position-level exclusion to correctly filter future guesses — a
  // zero-or-unset minCount already prevents requiring it, and any future
  // guess placing that letter at THIS position should be rejected even if
  // the letter is otherwise legitimately present elsewhere (duplicate
  // letter case, e.g. "rower" with one R confirmed at the end and another
  // R correctly marked absent at the front).
  for (let i = 0; i < 5; i++) {
    const letter = guess[i];
    const state = pattern[i];
    if (state === "absent") {
      if (!excludedPositions[letter]) excludedPositions[letter] = new Set();
      excludedPositions[letter].add(i);
    }
  }

  for (const [letter, count] of Object.entries(presentCounts)) {
    minCounts[letter] = Math.max(minCounts[letter] || 0, count);
  }

  return { greens, minCounts, excludedPositions };
}

export function emptyClue(): RevealedClue {
  return { greens: Array(5).fill(null), minCounts: {}, excludedPositions: {} };
}

// Is `word` a legal hard-mode guess given everything revealed so far?
export function isLegalHardModeGuess(word: string, clue: RevealedClue): boolean {
  for (let i = 0; i < 5; i++) {
    if (clue.greens[i] && word[i] !== clue.greens[i]) return false;
  }
  const counts: Record<string, number> = {};
  for (const ch of word) counts[ch] = (counts[ch] || 0) + 1;
  for (const [letter, minCount] of Object.entries(clue.minCounts)) {
    if ((counts[letter] || 0) < minCount) return false;
  }
  for (const [letter, positions] of Object.entries(clue.excludedPositions)) {
    for (const pos of positions) {
      if (word[pos] === letter) return false;
    }
  }
  return true;
}

export function filterLegalGuesses(words: string[], clue: RevealedClue): string[] {
  return words.filter((w) => isLegalHardModeGuess(w, clue));
}

// ---------------------------------------------------------------------------
// Entropy estimation (heuristic path, for buckets too large to minimax)
// ---------------------------------------------------------------------------

function entropyOfGuessAgainstBucket(guess: string, bucket: string[]): number {
  const counts = new Int32Array(243);
  for (const target of bucket) {
    counts[patternToInt(computePattern(guess, target))]++;
  }
  const n = bucket.length;
  let entropy = 0;
  for (let i = 0; i < 243; i++) {
    if (counts[i] > 0) {
      const p = counts[i] / n;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// Large-bucket difficulty estimate
// ---------------------------------------------------------------------------
//
// PROBLEM WITH THE OLD APPROACH (fixed here):
//   1. It evaluated entropy for every sampled candidate by calling
//      entropyOfGuessAgainstBucket, which itself calls computePattern once
//      per bucket word. Sampling from the full ~14,855-word legal-guess
//      list was the main cost driver for large buckets.
//   2. It estimated guesses as bitsNeeded / bitsPerGuess — i.e. it assumed
//      a SINGLE guess's entropy could be sustained across every subsequent
//      guess. That's not how information actually plays out: the first
//      guess's entropy reflects splitting the ORIGINAL bucket, but each
//      following guess only has the (much smaller, much less splittable)
//      residual bucket to work with. For a 1228-word bucket this produced
//      absurd estimates around 1.9 guesses, when realistically a bucket
//      that large needs several more guesses than that.
//
// FIX:
//   - Speed: pre-filter candidate guesses by a CHEAP letter-frequency score
//     (no pattern computation at all) before doing any entropy work. Only
//     the top FREQ_PREFILTER_COUNT candidates by that score go on to have
//     their actual entropy computed. Common, distinct letters correlate
//     strongly with high entropy, so this captures most of the value of an
//     exhaustive search at a fraction of the cost.
//   - Accuracy: instead of a single bits-needed/bits-per-guess division, we
//     look at the actual partition produced by the best sampled guess and
//     take the size of its LARGEST resulting sub-bucket. That sub-bucket is
//     the genuine bottleneck — it's what the player is still stuck with
//     after their best possible next guess. We convert that residual size
//     to an estimated guess count via a calibrated formula:
//
//         estimate = 1 + log2(maxSubBucketSize) / CALIBRATION_K
//
//     CALIBRATION_K was fit against true minimax depths computed for
//     buckets in the 16-25 word range (where exact minimax is still cheap
//     to verify): true minimax of 3 consistently corresponded to
//     maxSubBucket sizes of 3-7, and minimax of 4 corresponded to
//     maxSubBucket around 12. K=1.3 fits this data reasonably (see
//     game.ts commit history / calibration notes) while also producing
//     sane estimates (~6 guesses) for pathologically large buckets like
//     the 1228-word bucket "mamma" produces as a first guess, where the
//     best achievable single-guess split still leaves a 106-word residual.
//
//     This is necessarily an approximation, not a proof — exact minimax
//     for buckets this large is computationally infeasible in-browser.

const FREQ_PREFILTER_COUNT = 150;
const CALIBRATION_K = 1.3;

// Build a letter-frequency table across the given word list. Pure counting,
// no pattern computation — cheap even for the full legal-guess list.
function buildLetterFrequency(words: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const word of words) {
    const seen = new Set<string>();
    for (const ch of word) {
      if (!seen.has(ch)) {
        seen.add(ch);
        freq[ch] = (freq[ch] || 0) + 1;
      }
    }
  }
  return freq;
}

// Score a single word by how well it covers DISCRIMINATING letters within
// the bucket — i.e. letters that some (but not all) bucket words share.
// A letter appearing in every bucket word carries zero discriminating
// power (everyone matches on it already); a letter appearing in exactly
// one bucket word is maximally discriminating (it pinpoints that word).
// We weight a letter's value as (bucketSize - timesSeenInBucket), so RARE
// bucket letters score highest and UNIVERSAL bucket letters score zero.
// This is the opposite of naive "common letters are good" frequency
// scoring, which is the right heuristic for guessing in general but wrong
// here: within one bucket, the letters everyone already shares tell you
// nothing new, and the letters that vary are what actually split the
// bucket apart.
function letterFrequencyScore(
  word: string,
  bucketFreq: Record<string, number>,
  bucketSize: number
): number {
  let score = 0;
  const seen = new Set<string>();
  for (const ch of word) {
    if (!seen.has(ch)) {
      seen.add(ch);
      const occurrences = bucketFreq[ch] || 0;
      // Letters not present in the bucket at all still have some value
      // (they can rule things out / reveal nothing, which is neutral —
      // give them a small baseline rather than zero so words with no
      // bucket-letter overlap aren't strictly worse than ones with only
      // universal-letter overlap).
      score += occurrences === 0 ? 0.5 : bucketSize - occurrences;
    }
  }
  return score;
}

// Pick the top-N legal guesses by discriminating-letter coverage against
// the CURRENT bucket (see letterFrequencyScore above for why this favors
// rare-within-bucket letters rather than common ones).
function topCandidatesByLetterFrequency(
  bucket: string[],
  legalGuesses: string[],
  count: number
): string[] {
  if (legalGuesses.length <= count) return legalGuesses;
  const freq = buildLetterFrequency(bucket);
  const scored = legalGuesses.map((g) => ({
    g,
    score: letterFrequencyScore(g, freq, bucket.length),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.g);
}

// Find the best guess (by entropy against `bucket`) among a cheaply
// pre-filtered candidate set, and return the size of the LARGEST sub-bucket
// that guess produces — the genuine post-guess bottleneck.
function bestGuessMaxSubBucketSize(bucket: string[], legalGuesses: string[]): number {
  if (bucket.length <= 1) return bucket.length;

  const prefiltered = topCandidatesByLetterFrequency(
    bucket,
    legalGuesses,
    FREQ_PREFILTER_COUNT
  );

  let bestEntropy = -1;
  let bestMaxSub = bucket.length;

  for (const guess of prefiltered) {
    const counts = new Int32Array(243);
    for (const target of bucket) {
      counts[patternToInt(computePattern(guess, target))]++;
    }
    let maxSub = 0;
    let entropy = 0;
    const n = bucket.length;
    for (let i = 0; i < 243; i++) {
      if (counts[i] > 0) {
        if (counts[i] > maxSub) maxSub = counts[i];
        const p = counts[i] / n;
        entropy -= p * Math.log2(p);
      }
    }
    if (entropy > bestEntropy) {
      bestEntropy = entropy;
      bestMaxSub = maxSub;
    }
  }

  return bestMaxSub;
}

function estimateGuessesNeeded(bucket: string[], legalGuesses: string[]): number {
  if (bucket.length <= 1) return bucket.length;
  const maxSub = bestGuessMaxSubBucketSize(bucket, legalGuesses);
  if (maxSub <= 1) return 2; // best guess fully resolves the bucket next turn
  return 1 + Math.log2(maxSub) / CALIBRATION_K;
}

// ---------------------------------------------------------------------------
// Exact minimax for small buckets
// ---------------------------------------------------------------------------
//
// minimaxDepth(bucket, legalGuesses) = the true worst-case number of
// guesses needed to solve `bucket`, assuming the player plays optimally
// (minimizing) and the adversary plays optimally (maximizing, by picking
// the worst consistent response to each guess).
//
//   minimaxDepth(B) = 0                                  if |B| == 0
//   minimaxDepth(B) = 1                                  if |B| == 1
//   minimaxDepth(B) = min over guesses g of
//                       1 + max over non-win buckets of g against B of
//                             minimaxDepth(bucket)
//
// CRITICAL: the player is not restricted to guessing words drawn from the
// bucket itself — any word in the full legal-guess list is a legal guess,
// and a word OUTSIDE the bucket can split it more evenly than any word
// inside it (this is exactly how real Wordle solvers find guesses like
// "paste" or "lambs" that aren't themselves candidate answers but probe
// useful letters). Restricting candidates to bucket words is a common but
// unsound simplification — it understates how fast the player can solve a
// bucket, which lets the adversary pick buckets that only LOOK hard.
//
// Searching the FULL legal-guess list (~14,855 words) exhaustively at every
// recursion node is intractable: even after deduping by partition
// signature, the dedup pass itself costs O(|legalGuesses| * |bucket|) at
// EVERY recursive call, and the recursion tree for a 15-word bucket can
// have dozens of nodes — this measured at 200+ seconds for a single
// top-level call.
//
// Instead we prune candidates by ENTROPY before deduping: only the top
// MINIMAX_CANDIDATE_CAP guesses (by Shannon entropy of their partition of
// the bucket) are considered as minimax candidates. This is not formally
// exhaustive, but entropy is a strong proxy for partition quality — the
// guess that actually achieves the true minimax-optimal split is
// overwhelmingly likely to also be near the top of the entropy ranking,
// since a more even split (high entropy) directly trends toward a lower
// worst-case sub-bucket size. We then dedupe the surviving candidates by
// partition signature (cheap now that the candidate set is small) before
// recursing.
export const EXACT_MINIMAX_THRESHOLD = 6;
const MINIMAX_CANDIDATE_CAP = 50;

function topCandidatesByEntropy(
  bucket: string[],
  legalGuesses: string[],
  cap: number
): string[] {
  if (legalGuesses.length <= cap) return legalGuesses;

  // Cheap pre-filter by letter frequency before computing any patterns,
  // same approach used for the large-bucket heuristic above — cuts the
  // number of expensive entropy computations from |legalGuesses| down to
  // a small multiple of `cap`, while still surfacing the words most likely
  // to discriminate well within this specific bucket.
  const prefiltered = topCandidatesByLetterFrequency(
    bucket,
    legalGuesses,
    Math.max(cap * 4, 200)
  );

  const scored: Array<{ guess: string; entropy: number }> = [];
  for (const guess of prefiltered) {
    scored.push({ guess, entropy: entropyOfGuessAgainstBucket(guess, bucket) });
  }
  scored.sort((a, b) => b.entropy - a.entropy);
  return scored.slice(0, cap).map((s) => s.guess);
}

function dedupeByPartitionSignature(
  bucket: string[],
  candidateGuesses: string[]
): string[] {
  const seenSignatures = new Set<string>();
  const deduped: string[] = [];

  for (const guess of candidateGuesses) {
    // Partition signature: pattern produced against each bucket word, in
    // bucket order. Two guesses with the identical signature produce
    // literally the same partition of this bucket, so only one needs to
    // be tried.
    let sig = "";
    for (const word of bucket) {
      sig += patternToInt(computePattern(guess, word)) + ",";
    }
    if (!seenSignatures.has(sig)) {
      seenSignatures.add(sig);
      deduped.push(guess);
    }
  }

  return deduped;
}

function minimaxDepth(
  bucket: string[],
  legalGuesses: string[],
  cache: Map<string, number>
): number {
  if (bucket.length === 0) return 0;
  if (bucket.length === 1) return 1;

  const key = bucket.length + ":" + [...bucket].sort().join(",");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // Prune to the top entropy-ranked candidates first (bounded cost
  // regardless of legalGuesses size), then dedupe by partition signature
  // (cheap once the candidate set is small).
  const topCandidates = topCandidatesByEntropy(bucket, legalGuesses, MINIMAX_CANDIDATE_CAP);
  const candidateGuesses = dedupeByPartitionSignature(bucket, topCandidates);

  let best = Infinity;

  for (const guess of candidateGuesses) {
    const subBuckets = new Map<number, string[]>();
    for (const word of bucket) {
      const p = patternToInt(computePattern(guess, word));
      if (!subBuckets.has(p)) subBuckets.set(p, []);
      subBuckets.get(p)!.push(word);
    }

    // A guess that produces a single sub-bucket equal in size to the
    // parent bucket provides zero information (every bucket word looks
    // identical under this guess) and would recurse forever on the exact
    // same bucket. Skip it — it can never be part of an optimal strategy.
    if (subBuckets.size === 1) {
      const onlyBucket = subBuckets.values().next().value!;
      if (onlyBucket.length === bucket.length) continue;
    }

    let worst = 0;
    for (const [patInt, words] of subBuckets) {
      if (patInt === WIN_INT) {
        // The guess itself resolves this slice in one guess.
        worst = Math.max(worst, 1);
      } else {
        worst = Math.max(worst, 1 + minimaxDepth(words, legalGuesses, cache));
      }
    }

    if (worst < best) best = worst;
    if (best === 1) break; // can't do better than solving in one guess
  }

  // If every candidate guess failed to make progress (shouldn't normally
  // happen since bucket words themselves always self-distinguish once
  // |bucket| > 1, but guards against a pathological legalGuesses set),
  // fall back to a safe upper bound: guessing every bucket word in turn
  // solves it in at most |bucket| guesses.
  if (best === Infinity) {
    best = bucket.length;
  }

  cache.set(key, best);
  return best;
}

// ---------------------------------------------------------------------------
// Difficulty scoring — dispatches to exact minimax or the heuristic
// ---------------------------------------------------------------------------

export function scoreBucketDifficulty(
  bucket: string[],
  legalGuesses: string[],
  minimaxCache: Map<string, number>
): number {
  if (bucket.length <= EXACT_MINIMAX_THRESHOLD) {
    return minimaxDepth(bucket, legalGuesses, minimaxCache);
  }
  return estimateGuessesNeeded(bucket, legalGuesses);
}

// ---------------------------------------------------------------------------
// Main adversarial bucket selection
// ---------------------------------------------------------------------------

// Relative tie threshold: buckets scoring within this fraction of the best
// score are considered equally hard and chosen among at random. A wider
// threshold makes the adversary's behavior less deterministic.
const TIE_THRESHOLD = 0.12;

export function chooseAdversarialBucket(
  guess: string,
  pool: string[],
  legalGuesses: string[]
): { pattern: Pattern; nextPool: string[] } {
  const start = Date.now();
  const buckets = new Map<number, string[]>();
  for (const word of pool) {
    const p = patternToInt(computePattern(guess, word));
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p)!.push(word);
  }

  let winBucket: { patInt: number; words: string[] } | null = null;
  const candidates: Array<{ patInt: number; words: string[] }> = [];

  for (const [patInt, words] of buckets) {
    if (patInt === WIN_INT) {
      winBucket = { patInt, words };
    } else {
      candidates.push({ patInt, words });
    }
  }

  if (candidates.length === 0) {
    const { patInt, words } = winBucket!;
    return { pattern: intToPattern(patInt), nextPool: words };
  }

  const minimaxCache = new Map<string, number>();
  let bestScore = -1;
  const scored: Array<{ patInt: number; words: string[]; score: number }> = [];

  for (const c of candidates) {
    const score = scoreBucketDifficulty(c.words, legalGuesses, minimaxCache);
    scored.push({ ...c, score });
    if (score > bestScore) bestScore = score;
  }

  // Treat anything within TIE_THRESHOLD (relative) of the best as tied.
  const cutoff = bestScore * (1 - TIE_THRESHOLD);
  const tied = scored.filter((s) => s.score >= cutoff);

  const chosen = tied[Math.floor(Math.random() * tied.length)];
  const end = Date.now();
  console.log(tied)
  console.log(((end-start) / 1000).toFixed(1));
  return { pattern: intToPattern(chosen.patInt), nextPool: chosen.words };
}