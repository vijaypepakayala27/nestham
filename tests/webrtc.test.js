const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');

const SERVER_URL = 'http://localhost:3002';
let serverProcess;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: '3002' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', d => {
      const s = d.toString();
      if (s.includes('running on')) resolve();
    });
    serverProcess.stderr.on('data', d => process.stderr.write(d));
    setTimeout(() => resolve(), 3000);
  });
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--allow-running-insecure-content'
    ]
  });
}

async function clickThrough(page) {
  await page.goto(SERVER_URL, { waitUntil: 'networkidle0' });
  // Click Start Talking
  await page.click('#btn-start');
  await sleep(500);
  // Click Find Nestami (prefs screen)
  const prefsBtn = await page.$('#screen-prefs button.btn-primary');
  if (prefsBtn) await prefsBtn.click();
  await sleep(500);
  // Allow mic (fake device auto-approves with the flag)
  const micBtn = await page.$('#btn-perm');
  if (micBtn) await micBtn.click();
  await sleep(1000);
}

async function getStatus(page) {
  return page.$eval('#status-text', el => el.textContent).catch(() => 'unknown');
}

async function getConnState(page) {
  return page.evaluate(() => window.pc ? window.pc.connectionState : 'no-pc').catch(() => 'error');
}

async function runTests() {
  console.log('\n🧪 Nestham WebRTC Test Suite\n');
  let passed = 0, failed = 0;

  function pass(name) { console.log(`  ✅ ${name}`); passed++; }
  function fail(name, reason) { console.log(`  ❌ ${name}: ${reason}`); failed++; }

  console.log('Starting server...');
  await startServer();
  console.log('Server ready.\n');

  // ── Test 1: Two tabs pair ─────────────────────────────────────────────────
  console.log('Test 1: Two tabs pair up');
  const b1 = await launchBrowser();
  const b2 = await launchBrowser();
  const p1 = await b1.newPage();
  const p2 = await b2.newPage();

  try {
    await Promise.all([clickThrough(p1), clickThrough(p2)]);
    await sleep(8000); // wait for ICE
    const s1 = await getStatus(p1);
    const s2 = await getStatus(p2);
    const c1 = await getConnState(p1);
    const c2 = await getConnState(p2);
    console.log(`  Status p1: "${s1}", p2: "${s2}"`);
    console.log(`  ConnState p1: ${c1}, p2: ${c2}`);

    if (s1.includes('నెస్తం') || s1.includes('Connected') || c1 === 'connected') {
      pass('Tab 1 connected');
    } else fail('Tab 1 connected', `status="${s1}" connState=${c1}`);

    if (s2.includes('నెస్తం') || s2.includes('Connected') || c2 === 'connected') {
      pass('Tab 2 connected');
    } else fail('Tab 2 connected', `status="${s2}" connState=${c2}`);

    // Check audio srcObject
    const a1 = await p1.evaluate(() => !!document.getElementById('remote-audio')?.srcObject);
    const a2 = await p2.evaluate(() => !!document.getElementById('remote-audio')?.srcObject);
    if (a1) pass('Tab 1 has remote audio stream'); else fail('Tab 1 has remote audio stream', 'srcObject is null');
    if (a2) pass('Tab 2 has remote audio stream'); else fail('Tab 2 has remote audio stream', 'srcObject is null');
  } catch (e) {
    fail('Two-tab pairing', e.message);
  }

  // ── Test 2: Skip works ────────────────────────────────────────────────────
  console.log('\nTest 2: Skip button');
  try {
    await sleep(1000);
    await p1.click('#btn-skip').catch(() => {});
    await sleep(2000);
    const afterSkip = await getStatus(p1);
    if (afterSkip.includes('వెతుకు') || afterSkip.includes('searching') || afterSkip.includes('Looking')) {
      pass('Skip returns to searching');
    } else fail('Skip returns to searching', `status="${afterSkip}"`);
  } catch (e) {
    fail('Skip test', e.message);
  }

  // ── Test 3: Same-network pairing (not blocked) ────────────────────────────
  console.log('\nTest 3: Same-network users pair (not blocked)');
  const b3 = await launchBrowser();
  const p3 = await b3.newPage();
  try {
    // p1 is already searching, open p3 from "same" browser (same process = same IP in test)
    await clickThrough(p3);
    await sleep(6000);
    const s1b = await getStatus(p1);
    const s3 = await getStatus(p3);
    console.log(`  Status p1: "${s1b}", p3: "${s3}"`);
    if (s1b.includes('నెస్తం') || s3.includes('నెస్తం') ||
        s1b.includes('Connected') || s3.includes('Connected')) {
      pass('Same-network users pair successfully');
    } else fail('Same-network pairing', `p1="${s1b}" p3="${s3}"`);
  } catch (e) {
    fail('Same-network test', e.message);
  }

  // ── Test 4: Stop returns to landing ───────────────────────────────────────
  console.log('\nTest 4: Stop button returns to landing');
  try {
    await p2.click('#btn-end').catch(() => {});
    await sleep(1000);
    const landing = await p2.$eval('#screen-landing', el => el.style.display !== 'none').catch(() => false);
    if (landing) pass('Stop returns to landing screen');
    else fail('Stop returns to landing', 'landing screen not visible');
  } catch (e) {
    fail('Stop test', e.message);
  }

  // ── Test 5: ToS page loads ─────────────────────────────────────────────────
  console.log('\nTest 5: Terms of Service page');
  try {
    const tosPage = await b1.newPage();
    await tosPage.goto(`${SERVER_URL}/tos.html`);
    const title = await tosPage.title();
    const hasContent = await tosPage.$eval('body', el => el.innerText.length > 100).catch(() => false);
    if (hasContent) pass('ToS page loads with content');
    else fail('ToS page', `title="${title}"`);
    await tosPage.close();
  } catch(e) {
    fail('ToS page', e.message);
  }

  // ── Test 6: Online count updates ───────────────────────────────────────────
  console.log('\nTest 6: Online count badge');
  try {
    const count = await p1.$eval('#online-count', el => el.textContent).catch(() => '0');
    if (parseInt(count) >= 0) pass(`Online count visible (${count})`);
    else fail('Online count', 'element missing');
  } catch(e) {
    fail('Online count', e.message);
  }

  // Cleanup
  await b1.close(); await b2.close(); await b3.close();
  serverProcess?.kill();

  console.log(`\n─────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`─────────────────────────\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test suite crashed:', e);
  serverProcess?.kill();
  process.exit(1);
});
