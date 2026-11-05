import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeEntities, escapeMarkdown, toField } from '../../src/cards/shared.ts';

test('escapeMarkdown neutralises Discord markdown', () => {
  assert.equal(escapeMarkdown('*bold* _it_ ~strike~ `code` | table'), '\\*bold\\* \\_it\\_ \\~strike\\~ \\`code\\` \\| table');
  assert.equal(escapeMarkdown('> quoted'), '\\> quoted');
  assert.equal(escapeMarkdown('- list'), '\\- list');
  assert.equal(escapeMarkdown('1. ordered'), '1\\. ordered');
  assert.equal(escapeMarkdown('plain text'), 'plain text');
  assert.equal(escapeMarkdown(undefined), '');
});

test('decodeEntities handles numeric and named entities', () => {
  assert.equal(decodeEntities('Yoan (&#064;phodhipo)'), 'Yoan (@phodhipo)');
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), "a & b <c> \"d\" 'e'");
  assert.equal(decodeEntities('&#x2022; dot'), '• dot');
});

test('toField clips inside the limit and never leaves a dangling escape', () => {
  assert.equal(toField('abc', 10), 'abc');

  const clipped = toField('x'.repeat(50), 10);
  assert.equal(clipped.length, 10);
  assert.ok(clipped.endsWith('…'));

  // 9 characters then a markdown char: escaping grows the string, so the cut
  // can land between the backslash and the character it protects.
  const edge = toField(`${'a'.repeat(8)}*`, 10);
  assert.equal(edge.length, 10);
  assert.ok(!edge.endsWith('\\…'));
});
