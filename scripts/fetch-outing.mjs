#!/usr/bin/env node
/**
 * 수도권(서울·경기·인천) 아이 동반 장소·행사를 공공 API에서 모아 docs/outing.json 으로 만든다(BABYS 앱의 "나들이" 탭 자료).
 * 사용자의 sub_project 수집 스크립트에서 옮겨 왔고, 앱이 쓰는 필드만 만든다(순수 함수는 outing-lib.mjs).
 *
 * 사용법
 *   node scripts/fetch-outing.mjs --dry   # 수집 결과를 쓰지 않고 요약만 출력 (TourAPI 호출은 실제로 일어난다)
 *   node scripts/fetch-outing.mjs         # 수집 후 docs/outing.json 갱신 (내용이 바뀌었을 때만)
 *
 * 환경변수(GitHub Secrets 또는 셸): DATA_GO_KR_API_KEY(공공데이터포털 일반 인증키 — 한국관광공사 국문 관광정보 서비스 활용신청이 승인된 계정, 예방접종 점검과 같은 이름), SEOUL_API_KEY(서울 열린데이터광장).
 * 둘 중 하나만 있어도 그 소스만 수집한다. 키는 로그에 출력하지 않는다.
 *
 * 안전장치
 *  - 0건이거나 지금 게시된 파일의 절반 미만이면 파일을 덮어쓰지 않고 실패한다(앱은 기존 데이터를 계속 쓴다).
 *  - 내용(items)이 그대로면 파일을 건드리지 않는다. 바뀌었을 때만 updatedAt 을 새로 적는다.
 *  - TourAPI 개발계정은 하루 1,000회라 호출 상한(MAX_TOUR_CALLS, 기본 850)을 두고, 상세 조회는 캐시에 저장해 다음 실행에서 이어 채운다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOUR_PLACE_KEYWORDS, STRONG_KID_RE, stripHtml, extractUrl, fillDistrict, dedupe, applyOverrides,
  tourEventCandidate, tourPlaceCandidate, tourEventReady, tourItem, seoulEventItem, slimItem, sameItems, guardCount,
} from "./outing-lib.mjs";

// 시험에서는 OUTING_ROOT 로 임시 폴더를 가리킨다(실제 docs/outing.json 을 건드리지 않게)
const ROOT = process.env.OUTING_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = resolve(ROOT, "docs/outing.json");
const CACHE_FILE = resolve(ROOT, "data/outing-cache.json");
const OVERRIDES_FILE = resolve(ROOT, "data/outing-overrides.json");

const DRY = process.argv.slice(2).includes("--dry");

/* ---------------- 설정 (API 명세가 다르면 여기만 고친다) ---------------- */

const TOUR_BASE = process.env.TOUR_API_BASE || "https://apis.data.go.kr/B551011/KorService2";
// 서울 API의 8088 포트는 http 전용이라 서버(이 스크립트)에서만 부른다. 앱은 이 API를 직접 부르지 않는다.
const SEOUL_BASE = process.env.SEOUL_API_BASE || "http://openapi.seoul.go.kr:8088";
// 법정동 시도코드 (lDongRegnCd)
const TOUR_REGIONS = [
  { name: "서울", code: "11" },
  { name: "인천", code: "28" },
  { name: "경기", code: "41" },
];
const MAX_TOUR_CALLS = Number(process.env.MAX_TOUR_CALLS || 850);
const EVENT_WINDOW_DAYS = 90;      // 오늘부터 이 기간 안에 시작하는 행사만 수집

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = ymd(now);
const UNTIL = ymd(new Date(now.getTime() + EVENT_WINDOW_DAYS * 86400000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

/* ---------------- 한국관광공사 TourAPI ---------------- */

let tourCalls = 0;

function toArray(items) {
  if (!items || items === "") return [];
  const item = items.item ?? items;
  return Array.isArray(item) ? item : [item];
}

async function tour(op, params = {}) {
  if (tourCalls >= MAX_TOUR_CALLS) throw new Error("TOUR_BUDGET");
  tourCalls++;
  // 이미 URL 인코딩된 키(Encoding 키)를 넣어도 이중 인코딩되지 않게 디코딩한다
  const rawKey = process.env.DATA_GO_KR_API_KEY;
  const key = rawKey.includes("%") ? decodeURIComponent(rawKey) : rawKey;
  const url = new URL(`${TOUR_BASE}/${op}`);
  url.search = new URLSearchParams({ serviceKey: key, MobileOS: "ETC", MobileApp: "babys", _type: "json", ...params }).toString();

  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    if (/LIMITED_NUMBER|EXCEEDS/i.test(text)) throw new Error("TOUR_BUDGET");
    throw new Error(`TourAPI ${op}: JSON 아님 (${res.status})`);       // 응답 본문(키가 들어갈 수 있음)은 출력하지 않는다
  }
  const header = json?.response?.header;
  if (header && header.resultCode !== "0000") {
    if (header.resultCode === "22") throw new Error("TOUR_BUDGET");     // 22: 일일 호출 한도 초과
    throw new Error(`TourAPI ${op}: ${header.resultCode} ${header.resultMsg}`);
  }
  const body = json?.response?.body ?? {};
  return { items: toArray(body.items), total: Number(body.totalCount || 0) };
}

// 페이지를 끝까지 넘기며 모두 가져온다
async function tourAll(op, params, { maxPages = 10, rows = 500 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await tour(op, { ...params, numOfRows: rows, pageNo: page });
    all.push(...items);
    if (all.length >= total || items.length === 0) break;
    await sleep(120);   // 초당 호출 제한 회피
  }
  return all;
}

async function collectTour(cache) {
  const out = [];
  const targets = [];

  // 1) 행사
  for (const region of TOUR_REGIONS) {
    const rows = await tourAll("searchFestival2", { eventStartDate: TODAY.replaceAll("-", ""), lDongRegnCd: region.code, arrange: "A" });
    for (const r of rows) {
      const period = tourEventCandidate(r, TODAY, UNTIL);
      if (!period) continue;
      targets.push({ cid: r.contentid, typeId: r.contenttypeid || "15", event: true });
      out.push({ raw: r, kind: "event", region: region.name, ...period });
    }
  }
  // 2) 장소: 키워드 검색 결과만 후보로 삼는다
  const seen = new Set();
  for (const region of TOUR_REGIONS) {
    for (const keyword of TOUR_PLACE_KEYWORDS) {
      const rows = await tourAll("searchKeyword2", { keyword, lDongRegnCd: region.code, arrange: "A" }, { rows: 100, maxPages: 3 });
      for (const r of rows) {
        if (!tourPlaceCandidate(r) || seen.has(r.contentid)) continue;
        seen.add(r.contentid);
        targets.push({ cid: r.contentid, typeId: r.contenttypeid, strong: STRONG_KID_RE.test(r.title) });
        out.push({ raw: r, kind: "place", region: region.name });
      }
    }
  }
  log(`[tour] 후보 ${out.length}건 (목록 조회 호출 ${tourCalls}회)`);

  // 3) 상세(개요·홈페이지): 캐시에 없는 것만 조회해 호출 수를 아낀다. 행사를 먼저, 아이 관련 단어가 제목에 있는 장소를 그다음에
  const ordered = [...targets].sort((a, b) => Number(!!b.event) - Number(!!a.event) || Number(!!b.strong) - Number(!!a.strong));
  for (const t of ordered) {
    if (cache.tour[t.cid]) continue;
    try {
      const common = await tour("detailCommon2", { contentId: t.cid });
      const c = common.items[0] || {};
      let intro = {};
      if (t.event) intro = (await tour("detailIntro2", { contentId: t.cid, contentTypeId: t.typeId })).items[0] || {};   // 행사 홈페이지는 소개 정보에 있다
      cache.tour[t.cid] = {
        overview: stripHtml(c.overview).slice(0, 400),
        homepage: extractUrl(c.homepage) || extractUrl(intro.eventhomepage),
        cachedAt: TODAY,
      };
      await sleep(120);
    } catch (e) {
      if (e.message === "TOUR_BUDGET") { log("[tour] 일일 호출 상한 도달 → 남은 상세는 다음 실행에서 채움"); break; }
      log(`[tour] 상세 실패 ${t.cid}: ${e.message}`);
    }
  }
  await saveCache(cache);

  // 4) 정규화: 상세를 얻은 것만(행사는 상세 개요까지 보고 한 번 더 거른다)
  const ready = out.filter((o) => {
    const d = cache.tour[o.raw.contentid];
    return d && (o.kind !== "event" || tourEventReady(o.raw, d));
  });
  log(`[tour] 상세 확보 ${ready.length}건 / 후보 ${out.length}건 (나머지는 다음 실행에서 채움)`);
  return ready.map((o) => tourItem(o, cache.tour[o.raw.contentid]));
}

/* ---------------- 서울 열린데이터광장 ---------------- */

async function collectSeoul() {
  const key = process.env.SEOUL_API_KEY;
  const rows = [];
  const step = 1000;
  for (let start = 1; start <= 50000; start += step) {
    const res = await fetch(`${SEOUL_BASE}/${key}/json/culturalEventInfo/${start}/${start + step - 1}/`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`서울 API: JSON 아님 (${res.status})`); }
    const data = json.culturalEventInfo;
    if (!data) throw new Error("서울 API 오류: 응답 구조가 다르다");
    const code = data.RESULT?.CODE;
    if (code && code !== "INFO-000") { if (code === "INFO-200") break; throw new Error(`서울 API ${code}: ${data.RESULT?.MESSAGE}`); }
    rows.push(...(data.row || []));
    if (rows.length >= Number(data.list_total_count || 0)) break;
    await sleep(120);
  }
  const items = rows.map((r) => seoulEventItem(r, TODAY, UNTIL)).filter(Boolean);
  log(`[seoul] 전체 ${rows.length}건 중 ${items.length}건 채택`);
  return items;
}

/* ---------------- 저장 ---------------- */

// 상세 조회 결과는 비싸게 얻은 것이므로 조회 직후 바로 저장해 재사용한다
async function saveCache(cache) {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache) + "\n");
}

async function main() {
  const hasTour = Boolean(process.env.DATA_GO_KR_API_KEY), hasSeoul = Boolean(process.env.SEOUL_API_KEY);
  if (!hasTour && !hasSeoul) {
    console.error("DATA_GO_KR_API_KEY 또는 SEOUL_API_KEY 가 필요합니다.");
    process.exit(1);
  }
  const cache = await readJson(CACHE_FILE, { tour: {} });
  cache.tour ||= {};
  const all = [];
  // 한 소스가 실패해도 다른 소스 결과는 살린다. 단 아래 안전장치가 일부만 수집된 결과를 막는다
  if (hasTour) {
    try { all.push(...(await collectTour(cache))); } catch (e) { console.error("[tour] 실패:", e.message); }
  }
  if (hasSeoul) {
    try { all.push(...(await collectSeoul())); } catch (e) { console.error("[seoul] 실패:", e.message); }
  }

  const overrides = await readJson(OVERRIDES_FILE, {});
  const items = applyOverrides(dedupe(all).map(fillDistrict), overrides)
    .filter((i) => i.title && i.region)
    .map(slimItem)
    .sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title, "ko") : a.type === "event" ? -1 : 1));
  const stat = (f) => items.filter(f).length;
  log(`\n총 ${items.length}건 (장소 ${stat((i) => i.type === "place")}, 행사 ${stat((i) => i.type === "event")}), TourAPI 호출 ${tourCalls}회`);

  const existing = await readJson(OUT_FILE, null);
  const existingItems = existing?.items ?? [];
  if (!guardCount(existingItems.length, items.length)) {
    console.error(`수집 결과(${items.length}건)가 0건이거나 지금 게시된 ${existingItems.length}건의 절반 미만이라 파일을 갱신하지 않습니다.`);
    process.exit(1);
  }
  if (existing && sameItems(items, existingItems)) { log("내용 변경 없음 — 파일을 건드리지 않습니다."); return; }
  if (DRY) { log("--dry: 저장하지 않았다"); return; }
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items }) + "\n");
  log("docs/outing.json 저장 완료");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
