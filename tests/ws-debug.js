const puppeteer = require('puppeteer');
const URL = 'http://localhost:3002';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MOCK = `
  window._wsMessages = [];
  window._pcStates = [];
  navigator.mediaDevices.getUserMedia = async () => new MediaStream();
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url) {
    const ws = new OrigWS(url);
    ws.addEventListener('message', e => {
      try { window._wsMessages.push(JSON.parse(e.data)); } catch(x) {}
    });
    return ws;
  };
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.OPEN = OrigWS.OPEN;
  window.WebSocket.CLOSING = OrigWS.CLOSING;
  window.WebSocket.CLOSED = OrigWS.CLOSED;
`;

async function setupAndJoin(page) {
  await page.evaluateOnNewDocument(MOCK);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(300);
  await page.evaluate(() => document.getElementById('btn-start')?.click());
  await sleep(400);
  await page.evaluate(() => document.querySelector('#screen-prefs button.btn-primary')?.click());
  await sleep(400);
  await page.evaluate(() => document.getElementById('btn-perm')?.click());
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  
  const [p1, p2] = [await browser.newPage(), await browser.newPage()];
  
  console.log('Both tabs joining...');
  await Promise.all([setupAndJoin(p1), setupAndJoin(p2)]);
  
  console.log('Waiting 10s...');
  await sleep(10000);

  const [msgs1, msgs2] = await Promise.all([
    p1.evaluate(() => window._wsMessages).catch(() => []),
    p2.evaluate(() => window._wsMessages).catch(() => [])
  ]);
  const [s1, s2] = await Promise.all([
    p1.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => '?'),
    p2.evaluate(() => document.getElementById('status-text')?.textContent).catch(() => '?')
  ]);

  console.log('\nP1 WS messages:', msgs1.map(m => m.type));
  console.log('P1 status:', s1);
  console.log('\nP2 WS messages:', msgs2.map(m => m.type));
  console.log('P2 status:', s2);

  await browser.close();
})();
