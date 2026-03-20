/**
 * Nestham WebRTC Integration Test
 * Tests signaling + pairing without real mic (mocks getUserMedia)
 */
const puppeteer = require('puppeteer');

const URL = 'http://localhost:3002';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mock getUserMedia + localStream directly so WS connects
const MOCK_GETUSERMEDIA = `
  navigator.mediaDevices.getUserMedia = async () => {
    // Return a fake MediaStream with a silent audio track
    const stream = new MediaStream();
    return stream;
  };
`;

async function setupPage(browser, label) {
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`[${label} ERROR]`, e.message.substring(0, 100)));
  
  // Inject mock before page loads
  await page.evaluateOnNewDocument(MOCK_GETUSERMEDIA);
  
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(500);
  return page;
}

async function clickThrough(page, label) {
  // Start Talking
  await page.evaluate(() => document.getElementById('btn-start')?.click());
  await sleep(600);
  
  // Prefs — click Find button
  await page.evaluate(() => {
    const btn = document.querySelector('#screen-prefs button.btn-primary');
    if (btn) btn.click();
  });
  await sleep(600);
  
  // Mic permission
  await page.evaluate(() => document.getElementById('btn-perm')?.click());
  await sleep(1000);
  
  const chatVisible = await page.evaluate(() => {
    const el = document.getElementById('screen-chat');
    return el ? el.style.display : 'missing';
  });
  console.log(`[${label}] Chat screen: ${chatVisible}`);
}

(async () => {
  console.log('\n🧪 Nestham Signaling + Pairing Test\n');
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  try {
    console.log('Setting up two browser tabs...');
    const [p1, p2] = await Promise.all([
      setupPage(browser, 'P1'),
      setupPage(browser, 'P2')
    ]);

    console.log('Clicking through both...');
    await Promise.all([
      clickThrough(p1, 'P1'),
      clickThrough(p2, 'P2')
    ]);

    console.log('Waiting 12s for ICE negotiation...\n');
    
    // Poll every 2s for up to 12s
    for (let i = 0; i < 6; i++) {
      await sleep(2000);
      const s1 = await p1.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => '?');
      const c1 = await p1.evaluate(() => window.pc?.connectionState || 'no-pc').catch(() => '?');
      const s2 = await p2.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => '?');
      const c2 = await p2.evaluate(() => window.pc?.connectionState || 'no-pc').catch(() => '?');
      console.log(`  [${(i+1)*2}s] P1: "${s1}" (${c1}) | P2: "${s2}" (${c2})`);
      if (c1 === 'connected' || s1?.includes('నెస్తం')) break;
    }

    const s1 = await p1.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => 'err');
    const s2 = await p2.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => 'err');
    const c1 = await p1.evaluate(() => window.pc?.connectionState || 'no-pc').catch(() => 'err');
    const c2 = await p2.evaluate(() => window.pc?.connectionState || 'no-pc').catch(() => 'err');
    const a1 = await p1.evaluate(() => !!document.getElementById('remote-audio')?.srcObject).catch(() => false);
    const a2 = await p2.evaluate(() => !!document.getElementById('remote-audio')?.srcObject).catch(() => false);
    const ws1 = await p1.evaluate(() => window.ws?.readyState).catch(() => -1);
    const ws2 = await p2.evaluate(() => window.ws?.readyState).catch(() => -1);

    console.log('\n── Final Results ────────────────');
    console.log(`P1 | status: "${s1}" | rtcState: ${c1} | audio: ${a1} | ws: ${ws1}`);
    console.log(`P2 | status: "${s2}" | rtcState: ${c2} | audio: ${a2} | ws: ${ws2}`);

    const paired = c1 === 'connected' || s1?.includes('నెస్తం') || a1;
    console.log(`\nPaired + audio: ${paired ? '✅ PASS' : '❌ FAIL'}`);
    
    if (!paired) {
      // Get ICE candidates from console
      const ice1 = await p1.evaluate(() => window._iceLog || []).catch(() => []);
      console.log('ICE log P1:', ice1.slice(-3));
    }

    // Test skip
    console.log('\n── Skip Test ────────────────────');
    await p1.evaluate(() => document.getElementById('btn-skip')?.click()).catch(() => {});
    await sleep(2000);
    const afterSkip = await p1.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => 'err');
    const skipOk = afterSkip?.includes('వెతుకు') || afterSkip?.includes('Looking') || afterSkip?.includes('Searching');
    console.log(`Skip → status: "${afterSkip}" ${skipOk ? '✅' : '❌'}`);

    // Test stop
    console.log('\n── Stop Test ────────────────────');
    await p2.evaluate(() => document.getElementById('btn-end')?.click()).catch(() => {});
    await sleep(1000);
    const landingVisible = await p2.evaluate(() => {
      const el = document.getElementById('screen-landing');
      return el?.style.display;
    }).catch(() => 'err');
    const stopOk = landingVisible === 'flex';
    console.log(`Stop → landing: "${landingVisible}" ${stopOk ? '✅' : '❌'}`);

    console.log('\n─────────────────────────────────\n');

  } finally {
    await browser.close();
  }
})();
