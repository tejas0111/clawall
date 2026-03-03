import test from 'node:test';
import assert from 'node:assert/strict';

import { clawallTransformChatInput } from '../src/plugins/clawall-openclaw-plugin/index.js';

test('routes natural transfer text to /clawall_transfer', () => {
  const to = '0xf3c2acfa854a5d6a76db76042d30d18ca78ba4487c9dbf7439b9e1c45a24a8fd';
  const input = `send 0.004 sui to ${to}`;
  const out = clawallTransformChatInput(input);
  assert.equal(out, `/clawall_transfer ${input}`);
});

test('routes natural transfer+usd intent to /clawall_transfer_quote', () => {
  const to = '0xf3c2acfa854a5d6a76db76042d30d18ca78ba4487c9dbf7439b9e1c45a24a8fd';
  const input = `send 0.004 sui to ${to} and tell me exact price in usd`;
  const out = clawallTransformChatInput(input);
  assert.equal(out, `/clawall_transfer_quote ${input}`);
});

test('does not transform slash commands', () => {
  const input = '/clawall_transfer send 0.004 sui to 0x' + 'a'.repeat(64);
  const out = clawallTransformChatInput(input);
  assert.equal(out, null);
});

