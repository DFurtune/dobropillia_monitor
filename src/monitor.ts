import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================
// Config
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const CHAT_ID   = process.env.CHAT_ID ?? '';
const PAGE_URL  = 'https://mrd.gov.ua/news/1764342276/';
const SEEN_FILE = path.resolve(__dirname, '..', 'seen_pdfs.json');

// Special run modes (set via env vars)
const DRY_RUN   = process.env.DRY_RUN === 'true';       // run without sending TG messages
const MARK_SEEN = process.env.MARK_ALL_SEEN === 'true'; // mark all current PDFs as seen

// Telegram max message length is 4096 — keep buffer for [x/y] prefix
const MAX_CHUNK = 3800;

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// ============================================================
// Types
// ============================================================
interface PdfLink {
  url: string;
  name: string;
  date: string;
}

interface Section {
  count: number;
  addresses: string[];
}

interface ParsedDecision {
  date: string;
  section1: Section;           // Granted — technical report
  section2: Section;           // Granted — remote inspection act
  section3: { count: number }; // Rejected
  section4: { count: number }; // Suspended
}

// ============================================================
// Seen PDFs — anti-duplicate storage in seen_pdfs.json
// ============================================================
function loadSeen(): Set<string> {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')) as string[]);
    }
  } catch {
    console.warn('[WARN] Could not read seen_pdfs.json — starting fresh');
  }
  return new Set();
}

function saveSeen(seen: Set<string>): void {
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify([...seen].sort(), null, 2),
    'utf-8'
  );
  console.log(`[SEEN] Saved ${seen.size} entries to seen_pdfs.json`);
}

// ============================================================
// Telegram — send message with automatic chunking
// ============================================================
function splitIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length > MAX_CHUNK) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = next;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function sendTelegram(text: string): Promise<void> {
  // In dry-run mode — just print to console, skip actual API call
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Message preview:');
    console.log('─'.repeat(50));
    console.log(text);
    console.log('─'.repeat(50));
    return;
  }

  const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const chunks = splitIntoChunks(text);
  const total  = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const prefix = total > 1 ? `[${i + 1}/${total}]\n\n` : '';

    try {
      await axios.post(apiUrl, {
        chat_id: CHAT_ID,
        text: prefix + chunks[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      console.log(`[TG] ✅ Sent chunk ${i + 1}/${total}`);
} catch (err: any) {
  // Handle rate limit — wait and retry once
  if (err.response?.status === 429) {
    const retryAfter = (err.response.data?.parameters?.retry_after ?? 30) * 1000;
    console.warn(`[TG] Rate limited — waiting ${retryAfter / 1000}s...`);
    await sleep(retryAfter);
    try {
      await axios.post(apiUrl, {
        chat_id: CHAT_ID,
        text: prefix + chunks[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      console.log(`[TG] ✅ Retry OK chunk ${i + 1}/${total}`);
    } catch (retryErr: any) {
      console.error(`[TG ERROR] Retry failed: ${retryErr.message}`);
    }
  } else {
    console.error(`[TG ERROR] Chunk ${i + 1}/${total}: ${err.message}`);
  }
}
    // Small delay between consecutive messages to avoid rate limits
    if (i < chunks.length - 1) await sleep(500);
  }
}

// ============================================================
// Scraper — fetch list of PDF links from the page
// ============================================================
async function getPdfLinks(): Promise<PdfLink[]> {
  const res = await axios.get<string>(PAGE_URL, {
    headers: HTTP_HEADERS,
    timeout: 15_000,
  });

  const $       = cheerio.load(res.data);
  const seenUrl = new Set<string>();
  const list: PdfLink[] = [];

  $('main#main_content a').each((_, el) => {
    const href = $(el).attr('href') ?? '';

    // Skip non-PDF links and duplicates
    if (!href.toLowerCase().endsWith('.pdf') || seenUrl.has(href)) return;
    seenUrl.add(href);

    const name      = $(el).text().trim();
    const dateMatch = name.match(/від\s+(\d{2}\.\d{2}\.\d{4})/);

    list.push({
      url: href,
      name,
      date: dateMatch?.[1] ?? '—',
    });
  });

  console.log(`[PAGE] Found ${list.length} PDF links`);
  return list;
}

// ============================================================
// PDF — download binary and extract plain text
// ============================================================
async function downloadAndParsePdf(url: string): Promise<string> {
  const res = await axios.get<ArrayBuffer>(url, {
    headers: HTTP_HEADERS,
    responseType: 'arraybuffer',
    timeout: 30_000,
  });

  const { text } = await pdfParse(Buffer.from(res.data));
  console.log(`[PDF] Extracted ${text.length} chars`);
  return text;
}

// ============================================================
// Parser — extract address bullet lines from a section block
// ============================================================
function extractAddresses(sectionText: string): string[] {
  // Normalize ALL whitespace variants (non-breaking, narrow, etc.) to regular space
  const normalized = sectionText.replace(/[^\S\n]/g, ' ');

  const results: string[] = [];
  const seen = new Set<string>();

  for (const raw of normalized.split('\n')) {
    const line = raw.trim();

    if (!line || line.length < 10) continue;

    // Remove any bullet characters if present (-, –, •)
    const cleaned = line.replace(/^[-–•]\s*/, '').trim();

    // Match lines containing address keywords
    const hasAddress = /місто|селище|село|смт|сел\.|м\.|вулиця|вул\.|провулок|мікрорайон|проспект|бульвар|площа|приватні/i.test(cleaned);
    if (!hasAddress) continue;
    // Skip section headers and description lines — not actual addresses
    if (/^\d+\)/.test(cleaned)) continue;                    // starts with "1)", "2)"...
    if (/по таким адресам/i.test(cleaned)) continue;         // "по таким адресам:"
    if (/житлових сертифікат/i.test(cleaned)) continue;     // section header
    if (/актам дистанційного/i.test(cleaned)) continue;     // section 2 header
    if (cleaned.endsWith(':')) continue;                     // any line ending with ":"
    const addr = cleaned
      .replace(/;$/, '')
      .replace(/\.$/, '')
      .replace(/\s+/g, ' ')  // collapse any remaining multiple spaces
      .trim();

    if (addr.length > 5 && !seen.has(addr)) {
      results.push(addr);
      seen.add(addr);
    }
  }

  return results;
}
// ============================================================
// Parser — split full PDF text into 4 structured sections
// ============================================================
function parseDecision(text: string, date: string): ParsedDecision {
  // Normalize horizontal whitespace but preserve newlines
  const t = text.replace(/[^\S\n]+/g, ' ');

  // Extract raw text for each numbered section
  const s1 = t.match(/1\)[\s\S]*?(?=2\))/)?.[0] ?? '';
  const s2 = t.match(/2\)[\s\S]*?(?=3\))/)?.[0] ?? '';
  const s3 = t.match(/3\)[\s\S]*?(?=4\))/)?.[0] ?? '';
  const s4 = t.match(/4\)[\s\S]*/)?.[0]          ?? '';

  return {
    date,
    section1: {
      count:     parseInt(s1.match(/Надано\s+(\d+)/i)?.[1] ?? '0'),
      addresses: extractAddresses(s1),
    },
    section2: {
      count:     parseInt(s2.match(/Надано\s+(\d+)/i)?.[1] ?? '0'),
      addresses: extractAddresses(s2),
    },
    section3: {
      count: parseInt(s3.match(/Відмовлено\s+по\s+(\d+)/i)?.[1] ?? '0'),
    },
    section4: {
      count: parseInt(s4.match(/Зупинен[оа]\s+(\d+)/i)?.[1] ?? '0'),    },
  };
}

// ============================================================
// Formatter — build final Telegram HTML message
// ============================================================
function buildMessage(decision: ParsedDecision, pdfUrl: string): string {
  const lines: string[] = [
    `📄 <b>Нове рішення комісії — Добропільська МВА</b>`,
    `🗓 ${decision.date}`,
    ``,
    `✅ Надано: <b>${decision.section1.count + decision.section2.count}</b>`,
    `❌ Відмовлено: <b>${decision.section3.count}</b>`,
    `⏸ Зупинено: <b>${decision.section4.count}</b>`,
    ``,
    `🔗 <a href="${pdfUrl}">Відкрити PDF</a>`,
  ];

  return lines.join('\n');
}
// ============================================================
// Utility
// ============================================================
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[${new Date().toISOString()}] Monitor started`);
  if (DRY_RUN)   console.log('[MODE] DRY RUN — Telegram messages will NOT be sent');
  if (MARK_SEEN) console.log('[MODE] MARK ALL SEEN — will populate seen_pdfs.json and exit');
  console.log('='.repeat(50));

  // Validate required env vars (skip in dry-run / mark-seen modes)
  if (!DRY_RUN && !MARK_SEEN && (!BOT_TOKEN || !CHAT_ID)) {
    console.error('[ERROR] BOT_TOKEN or CHAT_ID is missing in environment!');
    process.exit(1);
  }

  const seen = loadSeen();

  // Fetch PDF list from the page
  let pdfLinks: PdfLink[];
  try {
    pdfLinks = await getPdfLinks();
  } catch (err: any) {
    console.error(`[ERROR] Failed to fetch page: ${err.message}`);
    return;
  }

  // MARK_ALL_SEEN mode — just populate seen_pdfs.json without sending anything
  if (MARK_SEEN) {
    pdfLinks.forEach(l => seen.add(l.url));
    saveSeen(seen);
    console.log(`[DONE] Marked ${pdfLinks.length} PDFs as seen. No messages sent.`);
    return;
  }

  // Sort by date ascending (oldest first) so Telegram shows chronological order
  const newLinks = pdfLinks
    .filter(l => !seen.has(l.url))
    .sort((a, b) => {
      // Parse DD.MM.YYYY → Date
      const toDate = (d: string): number => {
        const [day, month, year] = d.split('.');
        return new Date(`${year}-${month}-${day}`).getTime();
      };
      return toDate(a.date) - toDate(b.date); // oldest → newest
    });
    console.log(`[INFO] New PDFs to process: ${newLinks.length}`);

  if (newLinks.length === 0) {
    console.log('[OK] Nothing new — exiting');
    return;
  }

  for (const link of newLinks) {
    console.log(`\n[PROCESSING] ${link.date} — ${link.url}`);

    try {
      const text     = await downloadAndParsePdf(link.url);
      // DEBUG — remove after testing
      const decision = parseDecision(text, link.date);
      const message  = buildMessage(decision, link.url);

      await sendTelegram(message);
      console.log('[SENT] ✅');
    } catch (err: any) {
      console.error(`[ERROR] Failed to process PDF: ${err.message}`);

      // Send fallback message with just the link so user knows about new decision
      await sendTelegram(
        `📄 <b>Нове рішення комісії — Добропілля</b>\n` +
        `🗓 ${link.date}\n\n` +
        `⚠️ Не вдалось прочитати PDF автоматично\n\n` +
        `🔗 <a href="${link.url}">Відкрити PDF вручну</a>\n` +
        `📃 <a href="${PAGE_URL}">Всі рішення</a>`
      );
    }

    // Mark as seen regardless of parse success
    seen.add(link.url);

    // Delay between PDFs to be polite to the server
    await sleep(4_000);
  }

  saveSeen(seen);
  console.log(`\n[DONE] Total seen PDFs in DB: ${seen.size}`);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});