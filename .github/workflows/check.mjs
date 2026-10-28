import { chromium } from 'playwright';
import fs from 'node:fs';

const URLS = (process.env.TARGET_URLS || '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
const TOPIC = process.env.NTFY_TOPIC;
const DEBUG = process.env.DEBUG === '1';
const SEND_TEST = process.env.SEND_TEST === '1';
const STATE_FILE = 'state/last.json';
const FAIL_WARN_AT = 6;

export function decide(prev, scans) {
  const state = { notified: [], fails: 0, ...prev };
  const avail = [];
  let anyFail = false;
  for (const s of scans) {
    if (!s.ok) {
      anyFail = true;
      continue;
    }
    for (const d of s.days) if (d.available) avail.push(`${s.key}|day:${d.label}`);
    for (const t of s.times) if (t.available) avail.push(`${s.key}|time:${t.label}`);
  }
  const fresh = avail.filter((a) => !state.notified.includes(a));
  const next = { ...state };
  const actions = [];

  if (anyFail && scans.every((s) => !s.ok)) {
    next.fails = (state.fails || 0) + 1;
    if (next.fails === FAIL_WARN_AT) actions.push({ type: 'warn' });
  } else {
    next.fails = 0;
  }
  if (!anyFail || avail.length) {
    if (fresh.length) actions.push({ type: 'found', fresh });
    next.notified = avail;
  }
  return { next, actions };
}

async function scan(page, url, idx) {
  const key = `u${idx}`;
  const result = { key, url, ok: false, days: [], times: [] };
  for (let attempt = 0; attempt < 2 && !result.ok; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const data = await page.evaluate(() => {
        const SEL = 'button, a, td, li, div[role="button"]';
        const BAD_CLS = /disabled|unselectable|soldout|sold-out|dimmed|closed|prev|other|outside|\boff\b/i;
        const isOff = (el) => {
          let n = el;
          for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
            const cls = (n.className && n.className.toString()) || '';
            if (n.disabled || n.getAttribute('aria-disabled') === 'true') return true;
            if (BAD_CLS.test(cls)) return true;
          }
          return false;
        };
        const days = [];
        const times = [];
        for (const el of document.querySelectorAll(SEL)) {
          if (el.querySelector(SEL)) continue;
          if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const sold = /매진|마감|종료|품절/.test(text);
          const off = isOff(el);
          const t = text.match(/(\d{1,2}):(\d{2})/);
          if (t && text.length <= 40) {
            times.push({ label: `${t[1].padStart(2, '0')}:${t[2]}`, available: !sold && !off, text });
            continue;
          }
          const d = text.match(/^(\d{1,2})(\s*일)?(\s*(매진|마감|예약\s*가능|잔여.*))?$/);
          if (d) days.push({ label: String(Number(d[1])), available: !sold && !off, text });
        }
        return { days, times, bodyText: document.body.innerText.slice(0, 4000) };
      });
      Object.assign(result, data);
      result.ok = result.days.length >= 20;
    } catch (e) {
      result.error = String(e);
    }
  }
  return result;
}

async function notify(title, message, click) {
  if (!TOPIC) throw new Error('NTFY_TOPIC 이 설정되지 않았습니다');
  const res = await fetch('https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TOPIC, title, message, click, priority: 5, tags: ['admission_tickets'] }),
  });
  if (!res.ok) throw new Error(`ntfy 전송 실패: ${res.status}`);
}

async function main() {
  if (!URLS.length) throw new Error('TARGET_URLS 가 비어 있습니다');
  fs.mkdirSync('debug', { recursive: true });
  fs.mkdirSync('state', { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1100, height: 1600 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const scans = [];
  for (const [i, url] of URLS.entries()) {
    const page = await ctx.newPage();
    const s = await scan(page, url, i);
    if (DEBUG || !s.ok) {
      await page.screenshot({ path: `debug/page-${i}.png`, fullPage: true }).catch(() => {});
      fs.writeFileSync(`debug/page-${i}.html`, await page.content().catch(() => ''));
      fs.writeFileSync(`debug/scan-${i}.json`, JSON.stringify(s, null, 2));
    }
    scans.push(s);
    await page.close();
  }
  await browser.close();

  const prev = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const { next, actions } = decide(prev, scans);

  for (const s of scans) {
    const a = s.days.filter((d) => d.available).map((d) => d.label);
    console.log(`[${s.key}] ok=${s.ok} 날짜셀=${s.days.length} 예약가능일=[${a.join(',')}] 회차=${s.times.length} ${s.error || ''}`);
  }

  if (SEND_TEST) {
    await notify('테스트 알림', '알림이 정상적으로 도착했다면 설정 완료예요.', URLS[0]);
  }
  for (const act of actions) {
    if (act.type === 'found') {
      await notify('서도호전 예매 자리 발견!', `예약 가능 표시가 새로 생겼어요. 지금 네이버에서 확인하세요. (${act.fresh.length}건)`, URLS[0]);
    } else if (act.type === 'warn') {
      await notify('감시 점검 필요', '예약 페이지를 약 1시간째 읽지 못하고 있어요. GitHub Actions 로그와 debug 아티팩트를 확인해주세요.', URLS[0]);
    }
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
