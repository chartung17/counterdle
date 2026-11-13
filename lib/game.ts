// Core game logic for Counterdle.
//
// Word lists:
//   - Answers (~2,308 words): https://gist.github.com/slushman/34e60d6bc479ac8fc698df8c226e4264
//     Credit: slushman (https://gist.github.com/slushman)
//   - Guesses (~14,855 words): https://github.com/tabatkins/wordle-list/blob/main/words
//     Credit: Tab Atkins Jr. (https://github.com/tabatkins)
//
// The adversarial engine answers each guess with the response (bucket of
// still-possible answers) that maximizes the number of guesses the player
// will still need, assuming the player plays perfectly from there:
//
//   - depthSearch computes that minimax depth for every bucket. "Needs 2
//     more guesses" is detected exactly by scanning every legal guess; deeper
//     buckets use a pruned beam search that returns an upper bound which is
//     exact in the vast majority of cases.
//   - Before committing to a response, the engine double-checks it against
//     every legal guess (solvableIn3), so a bucket it believes needs 4+ more
//     guesses provably can't be solved in 3.
//
// Responses of equal depth are equally devious, so the engine picks among
// them at random: replaying the same guesses can lead to different games.
//
// Hard mode restricts which words count as legal guesses (both for the
// player's input validation, and for the set of guesses the adversary
// assumes the player COULD make when estimating difficulty): a guess must
// reuse every revealed clue. Because each possible response reveals
// different clues, the engine re-filters the legal guesses per response, and
// again at every level of its search.

export type TileState = "correct" | "present" | "absent";
export type Pattern = TileState[];

// Hard-mode constraints revealed so far, following NYT Wordle's rule: every
// green letter must stay in its spot, and every revealed letter (green or
// yellow) must be reused, as many times as it has been revealed. Grey letters
// may be reused, and a yellow letter may go back in the same spot.
export type RevealedClue = {
  // Position -> letter that's confirmed correct (green) there.
  greens: (string | null)[]; // length 5
  // Letter -> how many times it must appear in every later guess.
  minCounts: Record<string, number>;
};

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

export function isWin(pattern: Pattern): boolean {
  return pattern.every((s) => s === "correct");
}

// ---------------------------------------------------------------------------
// Hard mode: legal-guess filtering
// ---------------------------------------------------------------------------

// Merge a new (guess, pattern) result into the accumulated hard-mode
// constraints.
export function accumulateClue(
  prev: RevealedClue,
  guess: string,
  pattern: Pattern
): RevealedClue {
  const greens = [...prev.greens];
  const minCounts = { ...prev.minCounts };
  // Letters revealed (green or yellow) in this guess, counted per letter: a
  // guess with two yellow Es means every later guess needs two Es.
  const revealed: Record<string, number> = {};
  for (let i = 0; i < 5; i++) {
    const letter = guess[i];
    if (pattern[i] === "correct") greens[i] = letter;
    if (pattern[i] !== "absent") revealed[letter] = (revealed[letter] || 0) + 1;
  }
  for (const [letter, count] of Object.entries(revealed)) {
    minCounts[letter] = Math.max(minCounts[letter] || 0, count);
  }
  return { greens, minCounts };
}

export function emptyClue(): RevealedClue {
  return { greens: Array(5).fill(null), minCounts: {} };
}

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];

// Why `word` breaks hard mode, in NYT's wording, or null if it's legal.
export function hardModeViolation(word: string, clue: RevealedClue): string | null {
  for (let i = 0; i < 5; i++) {
    const g = clue.greens[i];
    if (g && word[i] !== g) return `${ORDINALS[i]} letter must be ${g.toUpperCase()}`;
  }
  const counts: Record<string, number> = {};
  for (const ch of word) counts[ch] = (counts[ch] || 0) + 1;
  for (const [letter, minCount] of Object.entries(clue.minCounts)) {
    if ((counts[letter] || 0) < minCount) return `Guess must contain ${letter.toUpperCase()}`;
  }
  return null;
}

export function isLegalHardModeGuess(word: string, clue: RevealedClue): boolean {
  return hardModeViolation(word, clue) === null;
}

export function filterLegalGuesses(words: string[], clue: RevealedClue): string[] {
  return words.filter((w) => isLegalHardModeGuess(w, clue));
}

// ---------------------------------------------------------------------------
// Pattern computation
// ---------------------------------------------------------------------------
//
// The adversary evaluates millions of (guess, target) pairs per turn, so the
// search works on words packed into integers (5 bits per letter, position i
// in bits 5i..5i+4) plus a 26-bit "letters present" mask for each target,
// and computes patterns without allocating. Packing and the mask fast path
// (a guess letter missing from the target is grey without any scanning)
// make this ~3x faster than a straightforward string implementation.

function packWord(word: string): number {
  let x = 0;
  for (let i = 0; i < 5; i++) x |= (word.charCodeAt(i) - 97) << (5 * i);
  return x;
}

function letterMask(word: string): number {
  let m = 0;
  for (let i = 0; i < 5; i++) m |= 1 << (word.charCodeAt(i) - 97);
  return m;
}

// (greenMask | yellowMask << 5) -> base-3 pattern code, position 0 most
// significant (2 = correct, 1 = present, 0 = absent).
const CODE_BY_MASKS = new Uint8Array(1024);
for (let gm = 0; gm < 32; gm++) {
  for (let ym = 0; ym < 32; ym++) {
    let c = 0;
    for (let i = 0; i < 5; i++) c = c * 3 + ((gm >> i) & 1 ? 2 : (ym >> i) & 1 ? 1 : 0);
    CODE_BY_MASKS[gm | (ym << 5)] = c;
  }
}

const WIN_CODE = 242; // 22222 in base 3

function codeOf(g: number, t: number, tLetters: number): number {
  const x = g ^ t;
  let gm = 0;
  if ((x & 0x1f) === 0) gm |= 1;
  if ((x & 0x3e0) === 0) gm |= 2;
  if ((x & 0x7c00) === 0) gm |= 4;
  if ((x & 0xf8000) === 0) gm |= 8;
  if ((x & 0x1f00000) === 0) gm |= 16;
  if (gm === 31) return WIN_CODE;
  let used = gm;
  let ym = 0;
  for (let i = 0; i < 5; i++) {
    if (gm & (1 << i)) continue;
    const gi = (g >>> (5 * i)) & 31;
    if (!((tLetters >>> gi) & 1)) continue; // letter not in target: grey
    for (let j = 0; j < 5; j++) {
      if (!(used & (1 << j)) && ((t >>> (5 * j)) & 31) === gi) {
        used |= 1 << j;
        ym |= 1 << i;
        break;
      }
    }
  }
  return CODE_BY_MASKS[gm | (ym << 5)];
}

// Base-3 pattern code (0-242) of `guess` against `target`.
export function patternCode(guess: string, target: string): number {
  return codeOf(packWord(guess), packWord(target), letterMask(target));
}

export function computePattern(guess: string, target: string): Pattern {
  return intToPattern(patternCode(guess, target));
}

// ---------------------------------------------------------------------------
// Internal word representation
// ---------------------------------------------------------------------------
//
// Inside the search a bucket is an array of word ids; PACKED/LETTERS hold
// each id's packed form and letter mask. Guess lists are converted once and
// cached per array instance.

const idByWord = new Map<string, number>();
const wordById: string[] = [];
let PACKED = new Int32Array(4096);
let LETTERS = new Int32Array(4096);

function wordId(word: string): number {
  let id = idByWord.get(word);
  if (id === undefined) {
    id = wordById.length;
    if (id === PACKED.length) {
      const p = new Int32Array(id * 2);
      p.set(PACKED);
      PACKED = p;
      const l = new Int32Array(id * 2);
      l.set(LETTERS);
      LETTERS = l;
    }
    PACKED[id] = packWord(word);
    LETTERS[id] = letterMask(word);
    idByWord.set(word, id);
    wordById.push(word);
  }
  return id;
}

type GuessList = { words: string[]; packed: Int32Array };
const guessListCache = new WeakMap<string[], GuessList>();

function asGuessList(words: string[]): GuessList {
  let list = guessListCache.get(words);
  if (!list) {
    list = { words, packed: Int32Array.from(words, packWord) };
    guessListCache.set(words, list);
  }
  return list;
}

function bucketKey(bucket: number[]): string {
  return [...bucket].sort((a, b) => a - b).join(",");
}

// Pre-computed x*log2(x): ranking guesses by sum(c*log2 c) ascending is the
// same as ranking by Shannon entropy descending for a fixed bucket size.
const XLOGX_SIZE = 4096;
const XLOGX = new Float64Array(XLOGX_SIZE);
for (let i = 2; i < XLOGX_SIZE; i++) XLOGX[i] = i * Math.log2(i);
const xlogx = (c: number) => (c < XLOGX_SIZE ? XLOGX[c] : c * Math.log2(c));

// Scratch buffers for non-recursive inner loops.
const scratchCounts = new Int32Array(243);
const scratchTouched = new Int32Array(243);
const scratchStamp = new Int32Array(243);
let stampGen = 0;
// Next generation for scratchStamp. Stamps live in an Int32Array, so the
// counter must wrap before 2^31 or stale stamps would never match again
// (which would make every guess look like a perfect separator).
function nextStamp(): number {
  if (stampGen >= 0x3fffffff) {
    scratchStamp.fill(0);
    stampGen = 0;
  }
  return ++stampGen;
}

// ---------------------------------------------------------------------------
// Minimax depth search
// ---------------------------------------------------------------------------
//
// depth(B) = the number of guesses the player needs, in the worst case, to
// solve bucket B (counting the final, winning guess) when the adversary
// always gives the hardest response:
//
//   depth(B) = |B|                                 if |B| <= 2
//   depth(B) = min over guesses g of
//                max over responses r of (r is the win ? 1 : 1 + depth(B_r))
//
// The player may guess ANY legal word, not just words still in B: an
// outside word often splits B better (and real solvers rely on this).
//
// Two facts make this tractable in a browser:
//
//   * depth(B) == 2 exactly when one guess gives every word in B a distinct
//     pattern (a "separator"). Testing that needs no recursion, and almost
//     every guess is rejected after a couple of words, so we scan the ENTIRE
//     legal-guess list. "Does this need 2 more guesses or 3?" is therefore
//     always answered exactly.
//
//   * For depth >= 3 we search a beam of candidate guesses (every word in B
//     plus the highest-entropy guesses from a position-aware pre-filter)
//     with alpha-beta style pruning: once some guess achieves depth d, any
//     guess leaving a part that can't be solved in d - 2 more guesses
//     (checked with the exact separator test) is dropped immediately.
//
// Every value comes from an actual strategy, so it is an UPPER bound on the
// true depth. It is exact whenever the beam contains an optimal guess, which
// holds for nearly all buckets (399/400 of a random sample of 3-40 word
// buckets in testing). The rare misses are handled at the top level by
// confirmAdversarialChoice, below.

type SearchCtx = {
  // Hard mode: clues revealed so far on this branch (null in normal mode).
  clue: RevealedClue | null;
  depthCache: Map<string, number>;
  sepCache: Map<string, boolean>;
};

function newSearchCtx(): SearchCtx {
  return { clue: null, depthCache: new Map(), sepCache: new Map() };
}

// How many candidate guesses get a full recursive evaluation, by bucket size.
function beamWidth(n: number): number {
  if (n <= 8) return 40;
  if (n <= 20) return 20;
  if (n <= 60) return 10;
  return 6;
}
// How many guesses survive the cheap pre-filter to have their entropy
// computed exactly. Raising this is cheap (no allocation per candidate) and
// directly improves how often the beam contains the optimal guess.
const PREFILTER_COUNT = 400;

function clueKey(clue: RevealedClue): string {
  let s = clue.greens.map((g) => g ?? "_").join("");
  for (const letter of Object.keys(clue.minCounts).sort()) s += letter + clue.minCounts[letter];
  return s;
}

// Cache key for `bucket` searched with the guess list implied by ctx.clue.
function nodeKey(bucket: number[], ctx: SearchCtx): string {
  return ctx.clue ? bucketKey(bucket) + "|" + clueKey(ctx.clue) : bucketKey(bucket);
}

// Same rule as isLegalHardModeGuess, applied to a packed guess list.
function filterGuessList(list: GuessList, clue: RevealedClue): GuessList {
  const green = clue.greens.map((g) => (g ? g.charCodeAt(0) - 97 : -1));
  const required = Object.entries(clue.minCounts)
    .filter(([, c]) => c > 0)
    .map(([letter, c]) => [letter.charCodeAt(0) - 97, c]);
  const counts = new Int32Array(26);
  const words: string[] = [];
  const packedOut: number[] = [];
  outer: for (let j = 0; j < list.packed.length; j++) {
    const p = list.packed[j];
    for (let i = 0; i < 5; i++) {
      if (green[i] >= 0 && ((p >>> (5 * i)) & 31) !== green[i]) continue outer;
    }
    if (required.length) {
      for (let i = 0; i < 5; i++) counts[(p >>> (5 * i)) & 31]++;
      let ok = true;
      for (const [c, min] of required) if (counts[c] < min) ok = false;
      for (let i = 0; i < 5; i++) counts[(p >>> (5 * i)) & 31] = 0;
      if (!ok) continue;
    }
    words.push(list.words[j]);
    packedOut.push(p);
  }
  return { words, packed: Int32Array.from(packedOut) };
}

// The guess list (and context) for the part of a bucket reached by
// `guess` -> `code`. Normal mode: unchanged. Hard mode: that response adds
// clues, which takes options away from the player.
function childContext(
  list: GuessList,
  ctx: SearchCtx,
  guess: string,
  code: number
): { list: GuessList; ctx: SearchCtx } {
  if (!ctx.clue) return { list, ctx };
  const clue = accumulateClue(ctx.clue, guess, intToPattern(code));
  return { list: filterGuessList(list, clue), ctx: { ...ctx, clue } };
}

// Exact: can one guess from `list` give every word in `bucket` a distinct
// pattern? Bucket words are tried first; they are often separators and are
// always legal (even in hard mode, since they fit every clue).
function hasSeparator(bucket: number[], list: GuessList, ctx: SearchCtx, key: string): boolean {
  const n = bucket.length;
  if (n <= 2) return true;
  if (n > 243) return false;
  const cached = ctx.sepCache.get(key);
  if (cached !== undefined) return cached;

  const tp = new Int32Array(n);
  const tl = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    tp[i] = PACKED[bucket[i]];
    tl[i] = LETTERS[bucket[i]];
  }
  const separates = (g: number): boolean => {
    const gen = nextStamp();
    for (let i = 0; i < n; i++) {
      const c = codeOf(g, tp[i], tl[i]);
      if (scratchStamp[c] === gen) return false;
      scratchStamp[c] = gen;
    }
    return true;
  };
  let found = false;
  for (let i = 0; i < n && !found; i++) found = separates(tp[i]);
  const packed = list.packed;
  for (let j = 0; j < packed.length && !found; j++) found = separates(packed[j]);
  ctx.sepCache.set(key, found);
  return found;
}

// Cheap, position-aware pre-ranking of guesses. A guess is useful when its
// letters split the bucket, so each letter scores x * (n - x), where x is
// the number of bucket words containing it (and, separately, containing it
// at that exact position, for the green signal). That is 0 for letters in
// none or all of the words and peaks for letters in half of them. Positions
// matter: anagram-heavy buckets like {alert, alter, later} share every
// letter and can only be split by position.
function prefilter(bucket: number[], list: GuessList, count: number): number[] {
  const packed = list.packed;
  const G = packed.length;
  if (G <= count) return Array.from({ length: G }, (_, j) => j);
  const n = bucket.length;
  const present = new Int32Array(26);
  const atPos = new Int32Array(5 * 26);
  for (const id of bucket) {
    const p = PACKED[id];
    let m = LETTERS[id];
    for (let i = 0; i < 5; i++) atPos[i * 26 + ((p >>> (5 * i)) & 31)]++;
    while (m) {
      const c = 31 - Math.clz32(m);
      present[c]++;
      m &= ~(1 << c);
    }
  }
  const presentScore = new Int32Array(26);
  for (let c = 0; c < 26; c++) presentScore[c] = present[c] * (n - present[c]);
  const posScore = new Int32Array(5 * 26);
  for (let k = 0; k < 5 * 26; k++) posScore[k] = atPos[k] * (n - atPos[k]);

  const scores = new Float64Array(G);
  for (let j = 0; j < G; j++) {
    const p = packed[j];
    let seen = 0;
    let s = 0;
    for (let i = 0; i < 5; i++) {
      const c = (p >>> (5 * i)) & 31;
      s += posScore[i * 26 + c];
      if (!(seen & (1 << c))) {
        seen |= 1 << c;
        s += presentScore[c];
      }
    }
    scores[j] = s;
  }
  const threshold = scores.slice().sort()[G - count];
  const out: number[] = [];
  for (let j = 0; j < G && out.length < count; j++) if (scores[j] > threshold) out.push(j);
  for (let j = 0; j < G && out.length < count; j++) if (scores[j] === threshold) out.push(j);
  return out;
}

type Part = { code: number; ids: number[] };
type Candidate = { word: string; parts: Part[] }; // non-win parts, largest first

function partitionBy(g: number, bucket: number[]): Part[] {
  const byCode = new Map<number, number[]>();
  for (const id of bucket) {
    const c = codeOf(g, PACKED[id], LETTERS[id]);
    if (c === WIN_CODE) continue;
    const list = byCode.get(c);
    if (list) list.push(id);
    else byCode.set(c, [id]);
  }
  const parts: Part[] = [];
  for (const [code, ids] of byCode) parts.push({ code, ids });
  parts.sort((a, b) => b.ids.length - a.ids.length);
  return parts;
}

function rankCandidates(bucket: number[], list: GuessList, width: number, hardMode: boolean): Candidate[] {
  const n = bucket.length;
  type Scored = { packed: number; word: string; inBucket: boolean; sum: number; max: number };
  const scored: Scored[] = [];
  const score = (packed: number, word: string, inBucket: boolean) => {
    let t = 0;
    let max = 0;
    let win = false;
    for (const id of bucket) {
      const c = codeOf(packed, PACKED[id], LETTERS[id]);
      if (c === WIN_CODE) win = true;
      const k = ++scratchCounts[c];
      if (k === 1) scratchTouched[t++] = c;
      if (k > max) max = k;
    }
    let sum = 0;
    for (let k = 0; k < t; k++) {
      sum += xlogx(scratchCounts[scratchTouched[k]]);
      scratchCounts[scratchTouched[k]] = 0;
    }
    // A guess that leaves the whole bucket in one non-winning part tells the
    // player nothing and can never be part of an optimal strategy.
    if (max === n && !win) return;
    scored.push({ packed, word, inBucket, sum, max });
  };
  const inBucket = new Set<string>();
  for (const id of bucket) {
    inBucket.add(wordById[id]);
    score(PACKED[id], wordById[id], true);
  }
  for (const j of prefilter(bucket, list, PREFILTER_COUNT)) {
    if (!inBucket.has(list.words[j])) score(list.packed[j], list.words[j], false);
  }
  // Best entropy first; then smaller worst case; then words that could win.
  scored.sort((a, b) => a.sum - b.sum || a.max - b.max || Number(b.inBucket) - Number(a.inBucket));

  // Keep the top `width` guesses that induce distinct partitions. (In hard
  // mode the response codes matter too: they decide the next legal list.)
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (out.length >= width) break;
    const parts = partitionBy(s.packed, bucket);
    let sig = s.inBucket ? "W" : "";
    for (const p of parts) sig += (hardMode ? p.code + ":" : "") + p.ids.join(".") + ",";
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ word: s.word, parts });
  }
  return out;
}

function depthSearch(bucket: number[], list: GuessList, ctx: SearchCtx): number {
  const n = bucket.length;
  if (n <= 2) return n;

  const key = nodeKey(bucket, ctx);
  const cached = ctx.depthCache.get(key);
  if (cached !== undefined) return cached;

  if (hasSeparator(bucket, list, ctx, key)) {
    ctx.depthCache.set(key, 2);
    return 2;
  }

  // No separator, so depth >= 3.
  let best = Infinity;
  for (const cand of rankCandidates(bucket, list, beamWidth(n), ctx.clue !== null)) {
    let worst = 1; // a winning response costs just this guess
    for (const part of cand.parts) {
      const size = part.ids.length;
      // Lower bound for the part: its size if <= 2, else 2 if separable, else
      // 3. (Hard mode tests separability against this node's list, a
      // superset of the child's, so the bound stays valid.)
      const lower =
        size <= 2 ? size : hasSeparator(part.ids, list, ctx, nodeKey(part.ids, ctx)) ? 2 : 3;
      if (1 + lower >= best) {
        worst = Infinity;
        break;
      }
      let d = size;
      if (size > 2) {
        const child = childContext(list, ctx, cand.word, part.code);
        d = depthSearch(part.ids, child.list, child.ctx);
      }
      if (1 + d > worst) worst = 1 + d;
      if (worst >= best) break;
    }
    if (worst < best) best = worst;
    if (best <= 3) break; // meets the lower bound
  }
  // Unreachable in practice (any bucket word makes progress), but guessing
  // every word in turn always works.
  if (best === Infinity) best = n;

  ctx.depthCache.set(key, best);
  return best;
}

// ---------------------------------------------------------------------------
// Exhaustive depth-3 check
// ---------------------------------------------------------------------------
//
// The beam's blind spot is the rare guess that splits a bucket into parts
// that are ALL separable (so the bucket needs only 3 more guesses) while
// ranking far down by entropy. On real opening buckets there can be as few
// as 2 such guesses out of ~15k, or the first one can rank 500th+. If the adversary picked such a bucket
// believing it needed 4 more guesses, a player who found the guess would
// win in 4 total.
//
// So the bucket the adversary is about to commit to is checked against
// EVERY legal guess. Patterns are computed once into a flat table, and each
// part's separability is then plain array lookups (cached, and almost always
// rejected within a few words). This is exact, so together with the exact
// depth-2 test above, a game (in either mode) can never be won in 4 guesses
// unless the player's guesses genuinely make that unavoidable.

function solvableIn3(bucket: number[], list: GuessList, ctx: SearchCtx): boolean {
  const n = bucket.length;
  if (n <= 3) return true;
  const packed = list.packed;
  const G = packed.length;
  const tp = new Int32Array(n);
  const tl = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    tp[i] = PACKED[bucket[i]];
    tl[i] = LETTERS[bucket[i]];
  }

  // rows[g * n + i] = pattern of guess g against bucket[i]. Also record each
  // guess's largest part and number of distinct patterns: a guess can only
  // separate a part of size m if it produces at least m distinct patterns on
  // the whole bucket, so separator scans only need the guesses with
  // distinct[g] >= m (byDistinct is sorted so that is a prefix).
  const rows = new Uint8Array(G * n);
  const maxPart = new Int32Array(G);
  const distinct = new Int32Array(G);
  for (let g = 0; g < G; g++) {
    const off = g * n;
    const gp = packed[g];
    let t = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const c = codeOf(gp, tp[i], tl[i]);
      rows[off + i] = c;
      const k = ++scratchCounts[c];
      if (k === 1) scratchTouched[t++] = c;
      if (k > max && c !== WIN_CODE) max = k;
    }
    for (let k = 0; k < t; k++) scratchCounts[scratchTouched[k]] = 0;
    maxPart[g] = max;
    distinct[g] = t;
  }
  const byDistinct = Array.from({ length: G }, (_, g) => g).sort((a, b) => distinct[b] - distinct[a]);
  const maxDistinct = G > 0 ? distinct[byDistinct[0]] : 0;

  const sepCache = new Map<string, boolean>();
  // Separable using any guess in the list (the exact answer in normal mode;
  // a necessary condition in hard mode).
  const separableByRows = (idx: number[]): boolean => {
    if (idx.length <= 2) return true;
    if (idx.length > maxDistinct) return false;
    const key = idx.join(",");
    let found = sepCache.get(key);
    if (found !== undefined) return found;
    found = false;
    const m = idx.length;
    for (let r = 0; r < G && !found && distinct[byDistinct[r]] >= m; r++) {
      const g = byDistinct[r];
      const gen = nextStamp();
      const off = g * n;
      let ok = true;
      for (const i of idx) {
        const c = rows[off + i];
        if (scratchStamp[c] === gen) {
          ok = false;
          break;
        }
        scratchStamp[c] = gen;
      }
      found = ok;
    }
    sepCache.set(key, found);
    return found;
  };

  // Most guesses fail on their largest part, so test that first without
  // building the full partition.
  const buf = new Int32Array(n);
  const partOf = (off: number, code: number): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (rows[off + i] === code) idx.push(i);
    return idx;
  };
  for (let g = 0; g < G; g++) {
    const m = maxPart[g];
    if (m > maxDistinct || m === n) continue;
    const off = g * n;
    if (m >= 3) {
      // Find the (first) largest part's code.
      let t = 0;
      let bigCode = -1;
      for (let i = 0; i < n; i++) {
        const c = rows[off + i];
        if (c === WIN_CODE) continue;
        const k = ++scratchCounts[c];
        if (k === 1) scratchTouched[t++] = c;
        if (k === m && bigCode < 0) bigCode = c;
      }
      for (let k = 0; k < t; k++) scratchCounts[scratchTouched[k]] = 0;
      let len = 0;
      for (let i = 0; i < n; i++) if (rows[off + i] === bigCode) buf[len++] = i;
      if (!separableByRows(Array.from(buf.subarray(0, len)))) continue;
    }
    // Largest part is fine; check every part of size >= 3.
    const codes = new Set<number>();
    for (let i = 0; i < n; i++) if (rows[off + i] !== WIN_CODE) codes.add(rows[off + i]);
    let ok = true;
    for (const code of codes) {
      const idx = partOf(off, code);
      if (idx.length <= 2) continue;
      if (!separableByRows(idx)) {
        ok = false;
        break;
      }
      if (ctx.clue) {
        // Hard mode: re-check against the guesses still legal after this
        // response (rarely reached; most guesses fail the test above).
        const ids = idx.map((i) => bucket[i]);
        const child = childContext(list, ctx, list.words[g], code);
        if (!hasSeparator(ids, child.list, child.ctx, nodeKey(ids, child.ctx))) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return true;
  }
  return false;
}

// Buckets above this size skip the exhaustive check: it costs ~0.5s+ there
// and isn't needed. On the opening move (always the full answer list) we ran
// it offline on every response bigger than this to every legal first guess
// (19,103 buckets): none can be solved in 3. Later in the game, 3 more
// guesses already means 5+ in total. Hard mode only removes options, so the
// same holds there.
const IN3_MAX_BUCKET = 300;

// Beam-based check for higher targets: can `bucket` be solved within
// `target` guesses using one of the best REFINE_CANDIDATES first guesses?
const REFINE_CANDIDATES = 30;
function solvableWithinByBeam(
  bucket: number[],
  list: GuessList,
  ctx: SearchCtx,
  target: number
): boolean {
  for (const cand of rankCandidates(bucket, list, REFINE_CANDIDATES, ctx.clue !== null)) {
    let ok = true;
    for (const part of cand.parts) {
      if (part.ids.length <= 2) {
        if (1 + part.ids.length > target) ok = false;
        if (!ok) break;
        continue;
      }
      const child = childContext(list, ctx, cand.word, part.code);
      if (1 + depthSearch(part.ids, child.list, child.ctx) > target) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Difficulty scoring
// ---------------------------------------------------------------------------

// Worst-case number of guesses still needed to solve `bucket` (an upper bound
// that is exact in the vast majority of cases; see depthSearch).
export function scoreBucketDifficulty(bucket: string[], legalGuesses: string[]): number {
  if (bucket.length <= 1) return bucket.length;
  return depthSearch(bucket.map(wordId), asGuessList(legalGuesses), newSearchCtx());
}

// ---------------------------------------------------------------------------
// Main adversarial bucket selection
// ---------------------------------------------------------------------------

export function chooseAdversarialBucket(
  guess: string,
  pool: string[],
  legalGuesses: string[],
  // Hard mode only: the clues revealed BEFORE this guess. Each response is
  // then scored against the (smaller) list of guesses that remain legal once
  // that response's clues are added, at every level of the search.
  hardModeClue: RevealedClue | null = null
): { pattern: Pattern; nextPool: string[] } {
  const g = packWord(guess);
  const byCode = new Map<number, number[]>();
  for (const word of pool) {
    const id = wordId(word);
    const c = codeOf(g, PACKED[id], LETTERS[id]);
    const l = byCode.get(c);
    if (l) l.push(id);
    else byCode.set(c, [id]);
  }

  const baseList = asGuessList(legalGuesses);
  const shared = newSearchCtx();
  type Option = {
    code: number;
    ids: number[];
    list: GuessList;
    ctx: SearchCtx;
    score: number;
    deeperThan3?: boolean; // proven by solvableIn3
  };
  const options: Option[] = [];
  for (const [code, ids] of byCode) {
    if (code === WIN_CODE) continue;
    let list = baseList;
    let ctx = shared;
    if (hardModeClue) {
      const clue = accumulateClue(hardModeClue, guess, intToPattern(code));
      list = filterGuessList(baseList, clue);
      ctx = { ...shared, clue };
    }
    const score = ids.length <= 2 ? ids.length : depthSearch(ids, list, ctx);
    options.push({ code, ids, list, ctx, score });
  }
  if (options.length === 0) {
    // The guess was the only word left.
    return { pattern: intToPattern(WIN_CODE), nextPool: [guess] };
  }

  // Responses of equal depth are equally devious; pick among them at random.
  // Before committing, confirm the pick really is that deep (the beam score
  // is an upper bound): if it isn't, lower its score and draw again. Drawing
  // in random order and stopping at the first confirmed option is a uniform
  // pick among the confirmed-hardest options, and usually costs a single
  // check rather than one per tied option.
  for (;;) {
    const best = Math.max(...options.map((o) => o.score));
    const tied = options.filter((o) => o.score === best);
    for (let i = tied.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tied[i], tied[j]] = [tied[j], tied[i]];
    }
    let chosen: Option | null = null;
    for (const o of tied) {
      if (o.score >= 4 && !o.deeperThan3 && o.ids.length <= IN3_MAX_BUCKET) {
        if (solvableIn3(o.ids, o.list, o.ctx)) {
          o.score = 3;
          continue;
        }
        o.deeperThan3 = true;
      }
      if (o.score >= 5 && solvableWithinByBeam(o.ids, o.list, o.ctx, o.score - 1)) {
        o.score--;
        continue;
      }
      chosen = o;
      break;
    }
    if (chosen) {
      return {
        pattern: intToPattern(chosen.code),
        nextPool: chosen.ids.map((id) => wordById[id]),
      };
    }
  }
}
