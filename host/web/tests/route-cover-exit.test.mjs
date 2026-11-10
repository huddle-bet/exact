// A route a push covers stays mounted, so no exit receipt reaches it. Its `-exact-exit-animation` plays when the
// projection stops showing it (navigation.js `routeShows`): the route stays visible until the keyframes end, and
// showing it again cancels them. The projection runs over nodes as the hosts write them, in Chrome's animation clock.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { cdpBrowser, chromium } from '../../../scripts/agent-launch.mjs';
import { need } from '../../../scripts/coverage.mjs';
import { readyPage } from './page.mjs';

const WEB = resolve(new URL('..', import.meta.url).pathname);
const { unavailable } = chromium();
const check = need('chrome', unavailable);

const page = `<style>
  @keyframes leave { to { opacity: 0; transform: translateX(-20px) } }
  body { margin: 0 } main { position: relative; height: 400px }
  [navigationKey] { position: absolute; inset: 0 }
</style>
<div id="exact-root"><main id="nav" navigationKey="a" navigationBack="back">
  <div navigationKey="a" id="a" style="--exact-exit-animation:leave 200ms linear both"><button id="in-a">A</button></div>
  <div navigationKey="b" id="b"><button id="in-b">B</button></div>
  <div navigationKey="c" id="c" style="--exact-exit-animation:leave 200ms linear both"><button id="in-c">C</button></div>
</main></div>
<script type="module">
  import { navigation } from './navigation.js';
  const root = document.getElementById('exact-root'), nav = document.getElementById('nav');
  navigation.connect(root, () => false, () => {}, () => {}, () => {}, () => false);
  window.show = key => { nav.setAttribute('navigationKey', key); navigation.project(root, () => {}); };
  window.state = id => { const e = document.getElementById(id); return { visibility: e.style.visibility, animation: e.style.animation, running: e.getAnimations().length, inert: e.inert }; };
  window.show('a');
  window.ready = true;
</script>`;

async function inChrome(test) {
  const server = createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); return; }
    if (req.url === '/navigation.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(resolve(WEB, 'navigation.js'))); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const suite = await cdpBrowser({ args: ['--window-size=600,900'] }), { cdp } = suite;
  try {
    const { sessionId } = await suite.page();
    const evaluate = async (expression) => {
      const reply = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    };
    await readyPage(cdp, sessionId, `http://127.0.0.1:${server.address().port}/`);
    await test(evaluate);
  } finally {
    await suite.close();
    server.close();
  }
}

// Bug caught: the covered route is hidden at once (visibility: hidden) and its exit keyframes never show.
check('a covered route plays its exit animation, then hides', () => inChrome(async (evaluate) => {
  await evaluate("show('b')");
  expect(await evaluate("state('a')")).toEqual({ visibility: '', animation: '200ms linear 0s 1 normal both running leave', running: 1, inert: true });
  expect(await evaluate("state('b').visibility")).toBe('');
  await evaluate("document.getElementById('a').getAnimations().forEach(a => a.finish())");
  await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  expect(await evaluate("state('a')")).toEqual({ visibility: 'hidden', animation: '', running: 0, inert: true });
}), 60000);

// Bug caught: going back before the keyframes end leaves the route faded out (the fill stays) or hidden.
check('showing a covered route again cancels its exit animation', () => inChrome(async (evaluate) => {
  await evaluate("show('b')");
  await evaluate("show('a')");
  expect(await evaluate("state('a')")).toEqual({ visibility: '', animation: '', running: 0, inert: false });
  await evaluate('new Promise(r => setTimeout(r, 300))');
  expect(await evaluate("state('a').visibility")).toBe('');
}), 60000);

// Bug caught: a route without the row, or one never shown, plays a stray exit; both hide at once as before.
check('a route with no exit animation, or never shown, hides at once', () => inChrome(async (evaluate) => {
  expect(await evaluate("state('c')")).toMatchObject({ visibility: 'hidden', running: 0 });
  await evaluate("show('b')");
  await evaluate("show('a')");
  expect(await evaluate("state('b')")).toMatchObject({ visibility: 'hidden', running: 0 });
}), 60000);
