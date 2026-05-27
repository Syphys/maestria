// Quintuplon detector — flags responses where the model loops on its
// own output (Qwen3.5 / DeepSeek-Prover Unsloth quants). The
// characterizer uses this to invalidate (score 0) any response whose
// content is dominated by repetition, so a scorer matching the correct
// answer at the start of a 13k-token garbage loop doesn't fake a pass.
import { describe, expect, test } from '@playwright/test';
import { detectQuintuplon } from '../../../src/main/modelhub/routing/characterize';

describe('detectQuintuplon', () => {
  test('empty / short text is never a loop', () => {
    expect(detectQuintuplon('')).toBe(false);
    expect(detectQuintuplon('hello world')).toBe(false);
  });

  test('5 identical 30+ char lines in a row ⇒ loop', () => {
    const line = 'The prompt is: Solve for x: 3x² + Nx + N = 0';
    const text = Array(6).fill(line).join('\n');
    expect(detectQuintuplon(text)).toBe(true);
  });

  test('4 identical lines is below the threshold', () => {
    const line = 'The prompt is: Solve for x: 3x² + Nx + N = 0';
    const text = Array(4).fill(line).join('\n');
    expect(detectQuintuplon(text)).toBe(false);
  });

  test('short identical lines (< 20 chars) are NOT considered a loop', () => {
    // Avoids false positives on bulleted lists, code, etc.
    const text = Array(10).fill('- ok').join('\n');
    expect(detectQuintuplon(text)).toBe(false);
  });

  test('non-consecutive identical lines do not trigger', () => {
    const lines = [
      'The prompt is: Solve for x: 3x² + Nx + N = 0',
      'some other line of similar length here please',
      'The prompt is: Solve for x: 3x² + Nx + N = 0',
      'some other line of similar length here please',
      'The prompt is: Solve for x: 3x² + Nx + N = 0',
    ];
    expect(detectQuintuplon(lines.join('\n'))).toBe(false);
  });

  test('block-level repetition (no newlines) is also caught', () => {
    // Mimics the math-algebra-01 loop where the same ~200-char
    // « Final Answer / Verification » template repeats with no line
    // breaks aligned to its boundary.
    const block =
      '### Final Answer\nThe solutions are x = (6 + sqrt(15))/3 and x = (6 - sqrt(15))/3 ### Verification Substitute back into the original equation to verify - this confirms the answer is correct as computed above.';
    expect(block.length).toBeGreaterThanOrEqual(200);
    const text = block.repeat(6);
    expect(detectQuintuplon(text)).toBe(true);
  });

  test('legitimate creative prose with varied content ⇒ no loop', () => {
    const text = [
      'Once upon a time in a kingdom far away there lived a young princess.',
      'She had long golden hair that shimmered in the morning sunlight.',
      'Every day she would walk through the gardens and feed the doves.',
      'The doves would coo softly and follow her wherever she wandered.',
      'One day a stranger arrived at the castle gates seeking shelter.',
      'The princess welcomed him in and offered a warm meal by the fire.',
    ].join('\n');
    expect(detectQuintuplon(text)).toBe(false);
  });
});
