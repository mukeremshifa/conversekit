#!/usr/bin/env node
/**
 * Tests the widget's markdown renderer, with emphasis on the security
 * property: reply text is model output that may have ingested
 * attacker-controlled documents, so no HTML from it may reach the DOM.
 *
 *   npm run test:widget
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'public/widget.js'), 'utf8');

// Lift the pure renderer functions out of the IIFE — they have no DOM
// dependencies, so they can be evaluated standalone.
const start = src.indexOf('  function escapeHtml(');
const end = src.indexOf('  // ── DOM helper');
if (start < 0 || end < 0) { console.error('Could not locate the renderer block in widget.js'); process.exit(2); }
const renderMarkdown = new Function(`${src.slice(start, end)}\nreturn renderMarkdown;`)();

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const has = (label, input, needle) => {
  const out = renderMarkdown(input);
  check(label, out.includes(needle), `got: ${out}`);
};
const lacks = (label, input, needle) => {
  const out = renderMarkdown(input);
  check(label, !out.includes(needle), `got: ${out}`);
};

console.log('\nFormatting');
has('bold', 'Costs **199 AED** total.', '<strong>199 AED</strong>');
has('italic', 'That is *quite* cheap.', '<em>quite</em>');
has('inline code', 'Use `data-bot-id` here.', '<code>data-bot-id</code>');
has('bullet list', '- Cleaning\n- Whitening', '<ul><li>Cleaning</li><li>Whitening</li></ul>');
has('numbered list', '1. First\n2. Second', '<ol><li>First</li><li>Second</li></ol>');
has('paragraphs', 'One.\n\nTwo.', '<p>One.</p><p>Two.</p>');
has('single newline becomes a break', 'Line one\nLine two', 'Line one<br>Line two');
has('heading renders as bold', '## Pricing', '<strong>Pricing</strong>');
lacks('heading is not a real h2', '## Pricing', '<h2');

console.log('\nLinks');
has('markdown link', 'See [our pricing](https://x.com/p).', 'href="https://x.com/p"');
has('links open safely', 'See [p](https://x.com).', 'rel="noopener noreferrer"');
has('bare url is linkified', 'Visit https://example.com now', 'href="https://example.com"');
has('mailto is allowed', 'Mail [us](mailto:a@b.com).', 'href="mailto:a@b.com"');

console.log('\nXSS — model output must never produce live HTML');
lacks('raw script tag is escaped', 'Hi <script>alert(1)</script>', '<script');
has('raw script tag shows as text', 'Hi <script>alert(1)</script>', '&lt;script&gt;');
lacks('img onerror is escaped', '<img src=x onerror=alert(1)>', '<img');
lacks('javascript: link is dropped', '[click](javascript:alert(1))', 'javascript:');
has('javascript: keeps only the label', '[click](javascript:alert(1))', 'click');
lacks('data: url is dropped', '[x](data:text/html;base64,PHN2Zz4=)', 'data:text/html');
lacks('vbscript: url is dropped', '[x](vbscript:msgbox)', 'vbscript:');
lacks('event handler attribute cannot form', 'a" onmouseover="alert(1)', 'onmouseover="alert');
lacks('iframe is escaped', '<iframe src="//evil"></iframe>', '<iframe');
lacks('svg onload is escaped', '<svg onload=alert(1)>', '<svg');
lacks('closing tag injection is escaped', '</p><script>x</script>', '<script');
{
  // A link label is inserted into markup, so it must stay inert too.
  const out = renderMarkdown('[<img src=x onerror=alert(1)>](https://ok.com)');
  check('link label cannot smuggle html', !out.includes('<img'), `got: ${out}`);
}
{
  const out = renderMarkdown('[a](https://x.com" onmouseover="alert(1))');
  check('quote in href cannot break out', !/onmouseover\s*=\s*"alert/.test(out), `got: ${out}`);
}

console.log('\nRobustness');
check('empty input', renderMarkdown('') === '');
check('unterminated bold does not throw', typeof renderMarkdown('**bo') === 'string');
check('lone asterisk survives', renderMarkdown('2 * 3 = 6').includes('2 * 3'));
{
  // Partial markers appear mid-stream on every delta.
  const partials = ['', '**', '**bo', '**bold**', '**bold** and [l', '**bold** and [l](https://x.com)'];
  check('every streaming prefix renders', partials.every((p) => typeof renderMarkdown(p) === 'string'));
}

console.log(bad === 0 ? '\nAll widget markdown tests passed.\n' : `\n${bad} failure(s).\n`);
process.exit(bad === 0 ? 0 : 1);
