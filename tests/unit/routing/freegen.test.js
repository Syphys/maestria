// Slice 7c — Free-gen probe: model writes ~400 words on a topic IT
// picks, response is embedded, projected onto shared anchors, stored
// as `topic_coverage_per_leaf`. SPEC §4 carve-out: the embedder is
// invoked once on the characterization path, but only the per-leaf
// cosines are persisted (not a 768-d opaque vector).
import { describe, expect, test } from '@playwright/test';
import { runFreeGenProbe, FREEGEN_PROMPT } from '../../../src/main/modelhub/routing/freegen';
import anchors from '../../../src/main/modelhub/routing/questions/probe-anchors.json';

const DIM = 4;
// Toy embedder: maps each text to a fixed direction by string-hashing
// its content into a small basis. Deterministic, dependency-free.
function toyEmbedder(directionMap) {
  // directionMap: { regex: Float32Array, regex2: Float32Array, ... }
  return async (texts) =>
    texts.map((t) => {
      for (const [re, vec] of directionMap) {
        if (re.test(t)) return vec;
      }
      return new Float32Array(DIM); // all-zeros fallback
    });
}

const codeDir = new Float32Array([1, 0, 0, 0]);
const medDir = new Float32Array([0, 1, 0, 0]);
const genericDir = new Float32Array([0, 0, 1, 0]);

// Build the per-anchor directions to mimic the real cosine pattern.
const ANCHORS = {
  code: codeDir,
  'code.python': codeDir,
  'code.cpp': codeDir,
  'code.sql': codeDir,
  'code.web': codeDir,
  'code.algo-dur': codeDir,
  'code.generic': codeDir,
  'tools.tooluse': codeDir,
  // generic / fallback for everything else
};
function dirFor(text) {
  // Anchor descriptions and code-heavy responses → codeDir. We match
  // any of: "code" (anchor word + response), "python" / "c++" / "sql"
  // / "javascript" / "programming" / "algorithm" / "JSON tool call",
  // covering both the code.* branch & leaf anchors and the test's
  // code-LLM response.
  if (/\bcode\b|python|c\+\+|sql|javascript|programming|algorithm|JSON|tool call/i.test(text))
    return codeDir;
  if (/cardiology|medical|pharmacokinetics|gene|cellular|anatomy/i.test(text))
    return medDir;
  return genericDir;
}

describe('runFreeGenProbe (slice 7c)', () => {
  test('code-LLM response ⇒ high topic coverage on code.* leaves', async () => {
    const codeResponse =
      'python, c++, sql, javascript, algorithms\n\nThe Python descriptor protocol resolves attribute access via __get__ and __set__, and the C++ template instantiation rules are notoriously subtle around argument-dependent lookup. SQL window functions over partitions...';
    const ask = {
      async complete() {
        return codeResponse;
      },
    };
    const embed = async (texts) => texts.map((t) => dirFor(t));
    const result = await runFreeGenProbe(ask, embed, anchors);

    // Code-like response embeds in codeDir direction; code.* anchors
    // also embed in codeDir → cosine ≈ 1. Other branches ≈ 0.
    expect(result.topic_coverage_per_leaf['code.python']).toBeCloseTo(1, 5);
    expect(result.topic_coverage_per_leaf['code.cpp']).toBeCloseTo(1, 5);
    expect(result.topic_coverage_per_leaf['math.algebre']).toBeCloseTo(0, 5);
    expect(result.topic_coverage_per_branch.code).toBeCloseTo(1, 5);
    expect(result.response_words).toBeGreaterThan(20);
  });

  test('medical-LLM response ⇒ high coverage drops on code.* (zero)', async () => {
    const medResponse =
      'cardiology, pharmacokinetics, cellular biology, gene expression, anatomy\n\nThe baroreceptors of the carotid sinus modulate sympathetic outflow via the nucleus tractus solitarii. Class III antiarrhythmics like amiodarone prolong repolarization by blocking the rapid component of the delayed rectifier potassium current...';
    const ask = {
      async complete() {
        return medResponse;
      },
    };
    const embed = async (texts) => texts.map((t) => dirFor(t));
    const result = await runFreeGenProbe(ask, embed, anchors);

    // Med-like response embeds in medDir; code anchors are codeDir →
    // cosine ≈ 0 (orthogonal). The model has NO topic coverage of code.
    expect(result.topic_coverage_per_leaf['code.python']).toBeCloseTo(0, 5);
    expect(result.topic_coverage_per_branch.code).toBeCloseTo(0, 5);
  });

  test('empty response ⇒ throws (caller decides to swallow)', async () => {
    const ask = {
      async complete() {
        return '';
      },
    };
    const embed = async (texts) => texts.map(() => new Float32Array(DIM));
    await expect(runFreeGenProbe(ask, embed, anchors)).rejects.toThrow(
      /freegen: empty/,
    );
  });

  test('<think> stripped before embedding (D11)', async () => {
    const ask = {
      async complete() {
        return '<think>thinking…</think>\npython, c++, sql\n\nGenerics and types...';
      },
    };
    const embed = async (texts) => texts.map((t) => dirFor(t));
    const result = await runFreeGenProbe(ask, embed, anchors);
    expect(result.response_excerpt).not.toMatch(/<think>/);
    expect(result.response_words).toBeGreaterThan(3);
  });

  test('FREEGEN_PROMPT does NOT inject a topic (model has agency)', () => {
    // Guard against drift: the prompt MUST stay topic-agnostic. If
    // someone bakes a leading topic in, the probe biases toward that
    // direction in every model's embedding.
    expect(FREEGEN_PROMPT).not.toMatch(/code|math|medical|legal|physics/i);
    // It MUST still ask for technical depth (otherwise tinyllama gets
    // a misleadingly-high "specialised" reading from generic chitchat).
    expect(FREEGEN_PROMPT).toMatch(/specialised|specialized|technical|expert/i);
  });
});
