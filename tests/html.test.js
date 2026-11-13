import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatChatText } from '../src/utils/html.js';

test('escapeHtml neutralises tags, quotes and ampersands', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
});
test('escapeHtml tolerates null/undefined/numbers', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(5), '5');
});
test('formatChatText keeps bold and newlines but no injected markup', () => {
  assert.equal(formatChatText('**hi**\n<b>x</b>'), '<strong>hi</strong><br>&lt;b&gt;x&lt;/b&gt;');
});
