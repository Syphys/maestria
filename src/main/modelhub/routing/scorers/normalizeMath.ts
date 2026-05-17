// Shared LaTeX → plain-math preprocessor for the deterministic math/numeric
// scorers. Arbitration: DECISIONS.md D10.
//
// The first live characterization exposed math-algebra-01 = 0.40: a *scorer*
// defect, not a model weakness. Strong instruct models answer in LaTeX
// (`\sqrt{15}`, `\frac{a}{b}`, `\pm`, `$…$`, `\times`), which the ported
// Slice-1 regexes (built for `sqrt(`, `√`, literal `/`, `±`) never match.
//
// This is a normalization pass, NOT a parser: it is deterministic,
// dependency-free, idempotent on already-plain text (so the existing
// Unicode fixtures keep passing unchanged), and conservative — it only
// rewrites unambiguous LaTeX math markup into the plain forms the scorers
// already understand. Newlines are preserved so line/length heuristics
// (clear-steps, concise) are unaffected when callers run it on the body.

/**
 * Rewrite common LaTeX math markup into plain ASCII/Unicode the scorers
 * already accept: `\sqrt{15}`→`sqrt(15)`, `\frac{A}{B}`→`((A)/(B))`,
 * `\pm`→`±`, `\cdot`/`\times`→`*`, strips `$ \( \) \[ \]` and stray
 * `\command` / braces. Inside-out so one level of nesting
 * (`\frac{2\sqrt{15}}{3}`) resolves correctly.
 */
export function normalizeMath(input: string): string {
  let s = input;

  // 1. Spacing / delimiter macros and math-mode wrappers.
  s = s.replace(/\\left|\\right|\\!|\\,|\\;|\\:|\\quad|\\qquad/g, '');
  s = s.replace(/\$\$?/g, ''); // $…$ and $$…$$
  s = s.replace(/\\[()[\]]/g, ''); // \( \) \[ \]

  // 2. Operators (before sqrt/frac so they survive inside arguments).
  s = s.replace(/\\pm/g, '±').replace(/\\mp/g, '∓');
  s = s.replace(/\\cdot|\\times|\\ast/g, '*');
  s = s.replace(/\\div/g, '/');

  // 3. sqrt / frac, innermost first (handles one level of nesting).
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\\(?:d|t)?sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
    s = s.replace(
      /\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      '(($1)/($2))',
    );
  } while (s !== prev);
  // bare `\sqrt 15` (no braces)
  s = s.replace(/\\(?:d|t)?sqrt\s+(\d+(?:\.\d+)?)/g, 'sqrt($1)');

  // 4. Any remaining \command (e.g. \boxed, \displaystyle, \alpha) → space;
  //    its braced argument content is kept (braces stripped next).
  s = s.replace(/\\[a-zA-Z]+\s*/g, ' ');

  // 5. Leftover grouping braces (LaTeX super/subscript groups, \boxed{…}, …).
  s = s.replace(/[{}]/g, '');

  return s;
}
