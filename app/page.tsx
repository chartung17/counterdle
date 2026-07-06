"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ANSWERS } from "@/lib/answers";
import { GUESSES } from "@/lib/guesses";
import {
  Pattern,
  TileState,
  RevealedClue,
  isWin,
  chooseAdversarialBucket,
  emptyClue,
  accumulateClue,
  isLegalHardModeGuess,
  filterLegalGuesses,
} from "@/lib/game";

const WORD_LENGTH = 5;
const MAX_VISIBLE_ROWS_MIN = 6;

type GuessResult = {
  word: string;
  pattern: Pattern;
};

type GameState = "playing" | "won" | "gaveup";

export default function Home() {
  const [pool, setPool] = useState<string[]>(ANSWERS);
  const [guesses, setGuesses] = useState<GuessResult[]>([]);
  const [currentInput, setCurrentInput] = useState("");
  const [gameState, setGameState] = useState<GameState>("playing");
  const [error, setError] = useState<string | null>(null);
  const [shakingRow, setShakingRow] = useState(false);
  const [flippingRow, setFlippingRow] = useState<number | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [hardMode, setHardMode] = useState(false);
  const [revealedWord, setRevealedWord] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);

  const clueRef = useRef<RevealedClue>(emptyClue());
  const guessSet = useRef<Set<string>>(new Set(GUESSES));
  // Track words guessed this game for random-guess exclusion in normal mode
  const guessedWordsRef = useRef<Set<string>>(new Set());

  const showError = (msg: string) => {
    setError(msg);
    setShakingRow(true);
    setTimeout(() => {
      setError(null);
      setShakingRow(false);
    }, 600);
  };

  const submitGuess = useCallback(() => {
    if (gameState !== "playing") return;
    const word = currentInput.toLowerCase().trim();

    if (word.length !== WORD_LENGTH) {
      showError(`Need ${WORD_LENGTH} letters`);
      return;
    }

    if (!guessSet.current.has(word)) {
      showError("Not in word list");
      return;
    }

    if (hardMode && !isLegalHardModeGuess(word, clueRef.current)) {
      showError("Must use revealed clues");
      return;
    }

    const legalGuesses = hardMode
      ? filterLegalGuesses(GUESSES, clueRef.current)
      : GUESSES;

    setThinking(true);
    setTimeout(() => {
      const { pattern, nextPool } = chooseAdversarialBucket(word, pool, legalGuesses);
      const newGuess: GuessResult = { word, pattern };
      const rowIndex = guesses.length;

      clueRef.current = accumulateClue(clueRef.current, word, pattern);
      guessedWordsRef.current.add(word);

      setFlippingRow(rowIndex);
      setTimeout(() => setFlippingRow(null), 400);

      setGuesses((prev) => [...prev, newGuess]);
      setCurrentInput("");
      setPool(nextPool);
      setThinking(false);

      if (isWin(pattern)) {
        setGameState("won");
      }
    }, 10);
  }, [currentInput, pool, guesses, gameState, hardMode]);

  const handleBackspace = useCallback(() => {
    setCurrentInput((prev) => prev.slice(0, -1));
  }, []);

  const handleLetter = useCallback((letter: string) => {
    setCurrentInput((prev) => (prev.length < WORD_LENGTH ? prev + letter : prev));
  }, []);

  const handleGiveUp = useCallback(() => {
    if (gameState !== "playing" || pool.length === 0) return;
    const word = pool[Math.floor(Math.random() * pool.length)];
    setRevealedWord(word);
    setGameState("gaveup");
  }, [gameState, pool]);

  const handleRandomGuess = useCallback(() => {
    if (gameState !== "playing" || thinking) return;
    if (hardMode) {
      // In hard mode: random legal guess (any valid word satisfying revealed clues)
      const legal = filterLegalGuesses(GUESSES, clueRef.current);
      if (legal.length === 0) return;
      setCurrentInput(legal[Math.floor(Math.random() * legal.length)]);
    } else {
      // In normal mode: random word from remaining possible answers, excluding
      // words already guessed this game
      const candidates = ANSWERS.filter((w) => !guessedWordsRef.current.has(w));
      if (candidates.length === 0) return;
      setCurrentInput(candidates[Math.floor(Math.random() * candidates.length)]);
    }
  }, [gameState, thinking, hardMode]);

  const resetGame = useCallback((newHardMode?: boolean) => {
    setPool(ANSWERS);
    setGuesses([]);
    setCurrentInput("");
    setGameState("playing");
    setError(null);
    setRevealedWord(null);
    clueRef.current = emptyClue();
    guessedWordsRef.current = new Set();
    if (newHardMode !== undefined) setHardMode(newHardMode);
  }, []);

  // Global keyboard listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (thinking) return;
      if (gameState !== "playing") {
        // Only handle Enter to restart when game is over
        if (e.key === "Enter" && (gameState === "won" || gameState === "gaveup")) {
          resetGame();
        }
        return;
      }
      if (e.key === "Enter") {
        submitGuess();
      } else if (e.key === "Backspace") {
        handleBackspace();
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        handleLetter(e.key.toLowerCase());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [gameState, thinking, submitGuess, handleBackspace, handleLetter, resetGame]);

  const currentRowIndex = guesses.length;
  const numRows = Math.max(
    guesses.length + (gameState === "playing" ? 1 : 0),
    MAX_VISIBLE_ROWS_MIN
  );
  const overlayVisible = gameState === "won" || gameState === "gaveup";

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px", background: "var(--bg)" }}>
      {/* Header */}
      <header style={{ width: "100%", maxWidth: 480, display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 16, marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "0.15em", color: "var(--accent)" }}>COUNTERDLE</h1>
          <p style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.08em", marginTop: 2 }}>adversarial word game</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {gameState === "playing" && (
            <div className="counter-pulse" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", fontSize: 12, color: "var(--muted)", letterSpacing: "0.05em" }}>
              <span style={{ color: "var(--accent)", fontWeight: 700 }}>{pool.length}</span>
              <span> possible</span>
            </div>
          )}
          <button onClick={() => setShowInfo(!showInfo)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, color: "var(--muted)", cursor: "pointer", padding: "6px 10px", fontSize: 14 }}>?</button>
        </div>
      </header>

      {/* Info panel */}
      {showInfo && (
        <div style={{ width: "100%", maxWidth: 480, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 20, fontSize: 13, lineHeight: 1.7, color: "var(--muted)" }}>
          <p style={{ color: "var(--text)", fontWeight: 600, marginBottom: 8 }}>How Counterdle works</p>
          <p>
            Counterdle is inspired by{" "}
            <a href="https://qntm.org/files/absurdle/absurdle.html" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Absurdle</a>.
            There&apos;s no secret word at the start. After each guess, the game picks the response that{" "}
            <em style={{ color: "var(--accent)" }}>maximizes how many guesses you&apos;ll still need</em>{" "}
            — using exact worst-case search for small remaining-word sets, and a calibrated heuristic for larger ones.
            Responses that are roughly equally devious are chosen among{" "}
            <em style={{ color: "var(--accent)" }}>at random</em>, so identical guesses can lead to different games.
          </p>
          <p style={{ marginTop: 10 }}>
            <strong style={{ color: "var(--text)" }}>Hard mode</strong> requires every guess to reuse all clues revealed so far (green letters must stay in place; yellow letters must appear somewhere). The adversary also knows you have fewer escape routes and adjusts accordingly.
          </p>
          <p style={{ marginTop: 10 }}>
            Valid guesses: <strong style={{ color: "var(--text)" }}>14,855</strong> words. Possible answers: <strong style={{ color: "var(--text)" }}>2,308</strong> words. The counter shows how many answers are still consistent with every clue so far.
          </p>
          <p style={{ marginTop: 10 }}>
            Counterdle is{" "}
            <a href="https://github.com/chartung17/counterdle" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>open source</a>.
          </p>
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)", cursor: guesses.length === 0 ? "pointer" : "not-allowed", opacity: guesses.length === 0 ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={hardMode}
                disabled={guesses.length > 0}
                onChange={(e) => { if (guesses.length === 0) setHardMode(e.target.checked); }}
              />
              Hard mode
            </label>
            {guesses.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>(restart to change)</span>
            )}
          </div>
          <button onClick={() => setShowInfo(false)} style={{ marginTop: 12, background: "var(--accent)", border: "none", borderRadius: 6, color: "#0d0d0f", cursor: "pointer", padding: "6px 14px", fontFamily: "inherit", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>got it</button>
        </div>
      )}

      {/* Board + overlay */}
      <div style={{ position: "relative", marginBottom: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, filter: overlayVisible ? "blur(2px)" : "none", transition: "filter 0.2s" }}>
          {Array.from({ length: numRows }).map((_, rowIdx) => {
            const guess = guesses[rowIdx];
            const isCurrent = rowIdx === currentRowIndex && gameState === "playing";
            const isFlipping = flippingRow === rowIdx;
            const isShaking = isCurrent && shakingRow;

            return (
              <div key={rowIdx} className={isShaking ? "row-shake" : ""} style={{ display: "flex", gap: 5 }}>
                {Array.from({ length: WORD_LENGTH }).map((_, colIdx) => {
                  const guessedLetter = guess?.word[colIdx];
                  const currentLetter = isCurrent ? currentInput[colIdx] : undefined;
                  const state = guess?.pattern[colIdx];
                  const letter = guessedLetter || currentLetter || "";

                  let bg = "var(--surface)";
                  let fg = "var(--text)";
                  let borderColor = letter && isCurrent ? "var(--accent)" : "var(--border)";

                  if (state === "correct") { bg = "var(--correct)"; fg = "var(--correct-fg)"; borderColor = "var(--correct)"; }
                  else if (state === "present") { bg = "var(--present)"; fg = "var(--present-fg)"; borderColor = "var(--present)"; }
                  else if (state === "absent") { bg = "var(--absent)"; fg = "var(--absent-fg)"; borderColor = "var(--absent)"; }

                  return (
                    <div key={colIdx} className={isFlipping ? "tile-flip" : ""} style={{ width: 56, height: 56, display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid ${borderColor}`, borderRadius: 8, fontSize: 22, fontWeight: 700, letterSpacing: "0.05em", background: bg, color: fg, textTransform: "uppercase", transition: "background 0.15s, border-color 0.15s" }}>
                      {letter}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {overlayVisible && (
          <>
            <div className="backdrop-fade" style={{ position: "absolute", top: -12, left: -12, right: -12, bottom: -12, background: "rgba(13, 13, 15, 0.55)", borderRadius: 16 }} />
            <div className="overlay-pop" style={{ position: "absolute", top: "50%", left: "50%", width: "calc(100% + 24px)", maxWidth: 320, background: "var(--surface)", border: `1px solid ${gameState === "won" ? "var(--correct)" : "var(--border)"}`, borderRadius: 14, padding: 24, textAlign: "center", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
              {gameState === "won" && (
                <>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🎉</div>
                  <p style={{ fontSize: 16, fontWeight: 700, color: "var(--correct-fg)", letterSpacing: "0.1em", marginBottom: 4 }}>
                    you beat it in {guesses.length} guess{guesses.length !== 1 ? "es" : ""}
                  </p>
                  <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>
                    the answer was:{" "}
                    <span style={{ color: "var(--text)", fontWeight: 700, textTransform: "uppercase" }}>{guesses[guesses.length - 1].word}</span>
                  </p>
                </>
              )}
              {gameState === "gaveup" && (
                <>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🏳️</div>
                  <p style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", letterSpacing: "0.1em", marginBottom: 4 }}>you gave up</p>
                  <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>
                    one word that fit every clue was:{" "}
                    <span style={{ color: "var(--text)", fontWeight: 700, textTransform: "uppercase" }}>{revealedWord}</span>
                    {pool.length > 1 && <><br /><span style={{ fontSize: 11 }}>({pool.length} words were still possible)</span></>}
                  </p>
                </>
              )}
              <button
                onClick={() => resetGame()}
                style={{ background: "var(--accent)", border: "none", borderRadius: 10, color: "#0d0d0f", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, letterSpacing: "0.08em", padding: "10px 24px" }}
              >
                PLAY AGAIN
              </button>
              <p style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>or press Enter</p>
            </div>
          </>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 16px", fontSize: 13, color: "var(--accent)", marginBottom: 16, letterSpacing: "0.05em" }}>
          {error}
        </div>
      )}

      {thinking && (
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.05em" }}>thinking...</div>
      )}

      {/* On-screen keyboard */}
      <OnScreenKeyboard
        guesses={guesses}
        currentInput={currentInput}
        disabled={gameState !== "playing" || thinking}
        onLetter={handleLetter}
        onBackspace={handleBackspace}
        onSubmit={submitGuess}
        onGiveUp={handleGiveUp}
        onRandomGuess={handleRandomGuess}
      />
    </main>
  );
}

function OnScreenKeyboard({
  guesses,
  currentInput,
  disabled,
  onLetter,
  onBackspace,
  onSubmit,
  onGiveUp,
  onRandomGuess,
}: {
  guesses: GuessResult[];
  currentInput: string;
  disabled: boolean;
  onLetter: (letter: string) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  onGiveUp: () => void;
  onRandomGuess: () => void;
}) {
  const rows = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["z", "x", "c", "v", "b", "n", "m"],
  ];

  const letterStates: Record<string, TileState> = {};
  for (const guess of guesses) {
    for (let i = 0; i < guess.word.length; i++) {
      const ch = guess.word[i];
      const st = guess.pattern[i];
      const existing = letterStates[ch];
      if (!existing) letterStates[ch] = st;
      else if (existing === "absent" && st !== "absent") letterStates[ch] = st;
      else if (existing === "present" && st === "correct") letterStates[ch] = st;
    }
  }

  const keyStyle = (state: TileState | undefined, width = 32): React.CSSProperties => {
    let bg = "var(--keyboard-unguessed)";
    let fg = "var(--text)";
    let border = "var(--border)";
    if (state === "correct") { bg = "var(--correct)"; fg = "var(--correct-fg)"; border = "var(--correct)"; }
    else if (state === "present") { bg = "var(--present)"; fg = "var(--present-fg)"; border = "var(--present)"; }
    else if (state === "absent") { bg = "var(--absent)"; fg = "var(--absent-fg)"; border = "var(--absent)"; }
    return {
      width,
      height: 44,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: bg,
      border: `1px solid ${border}`,
      borderRadius: 6,
      fontSize: 13,
      fontWeight: 600,
      color: fg,
      textTransform: "uppercase",
      transition: "background 0.2s",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1,
      userSelect: "none",
      fontFamily: "inherit",
    };
  };

  const canSubmit = currentInput.length === 5 && !disabled;
  const canBackspace = currentInput.length > 0 && !disabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 480 }}>
      {rows.map((row, ri) => (
        <div key={ri} style={{ display: "flex", gap: 5, justifyContent: "center" }}>
          {ri === 2 && (
            <button
              onClick={onGiveUp}
              disabled={disabled}
              style={{ ...keyStyle(undefined, 52), fontSize: 10, letterSpacing: "0.03em" }}
            >
              GIVE UP
            </button>
          )}
          {row.map((key) => (
            <button
              key={key}
              onClick={() => !disabled && onLetter(key)}
              disabled={disabled}
              style={keyStyle(letterStates[key])}
            >
              {key}
            </button>
          ))}
          {ri === 2 && (
            <button
              onClick={onBackspace}
              disabled={!canBackspace}
              style={{ ...keyStyle(undefined, 52), opacity: canBackspace ? 1 : 0.35, cursor: canBackspace ? "pointer" : "default" }}
            >
              ⌫
            </button>
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
        <button
          onClick={onRandomGuess}
          disabled={disabled}
          style={{
            ...keyStyle(undefined, 120),
            fontSize: 11,
            letterSpacing: "0.04em",
          }}
        >
          RANDOM
        </button>
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          style={{
            ...keyStyle(undefined, 160),
            background: canSubmit ? "var(--accent)" : "var(--keyboard-unguessed)",
            color: canSubmit ? "#0d0d0f" : "var(--muted)",
            border: "none",
            fontWeight: 700,
            letterSpacing: "0.1em",
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          SUBMIT
        </button>
      </div>
    </div>
  );
}