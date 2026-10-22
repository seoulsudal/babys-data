#!/usr/bin/env node
/**
 * 전국 달빛어린이병원·소아전문센터를 공공 API에서 모아 docs/moonlight.json 으로 만든다(BABYS 앱의 "달빛병원" 탭 자료).
 * 출처: 국립중앙의료원 「전국 병·의원 찾기 서비스」(공공데이터포털 15000736) 달빛어린이병원 및 소아전문센터 목록정보 조회.
 *
 * 사용법
 *   node scripts/fetch-moonlight.mjs --dry   # 수집 결과를 쓰지 않고 요약만 출력 (API 호출은 실제로 일어난다)
 *   node scripts/fetch-moonlight.mjs         # 수집 후 docs/moonlight.json 갱신 (내용이 바뀌었을 때만)
 *
 * 환경변수: DATA_GO_KR_API_KEY(공공데이터포털 일반 인증키, 위 서비스 활용신청이 승인된 계정). 키는 로그에 출력하지 않는다.
 *
 * 안전장치(나들이 수집과 같다)
 *  - 0건이거나 지금 게시된 파일의 절반 미만이면 파일을 덮어쓰지 않고 실패한다(앱은 기존 데이터를 계속 쓴다).
 *  - 내용(items)이 그대로면 파일을 건드리지 않는다. 바뀌었을 때만 updatedAt 을 새로 적는다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hospitalItem, hoursOf } from "./moonlight-lib.mjs";
import { createApi } from "./pharmacy-api.mjs";
import { sameItems, guardCount } from "./outing-lib.mjs";

// 시험에서는 MOONLIGHT_ROOT 로 임시 폴더를 가리킨다(실제 docs/moonlight.json 을 건드리지 않게)
const ROOT = process.env.MOONLIGHT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = resolve(ROOT, "docs/moonlight.json");

const DRY = process.argv.slice(2).includes("--dry");

/* ---------------- 설정 (API 명세가 다르면 여기만 고친다) ---------------- */

const BASE = process.env.MOONLIGHT_API_BASE || "https://apis.data.go.kr/B552657/HsptlAsembySearchService";
const OPERATION = "getBabyListInfoInqire";
const PAGE_SIZE = Number(process.env.MOONLIGHT_PAGE_SIZE || 100);
const MAX_PAGES = 30;       // 안전 상한(전국 수백 건이면 몇 쪽이면 끝난다)
const MAX_CALLS = 3000;     // 목록 쪽 + 병원마다 기본정보 1회(재시도 포함)의 상한

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function collect(api) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, total } = await api.call(OPERATION, { pageNo: String(page), numOfRows: String(PAGE_SIZE) });
    rows.push(...items);
    if (rows.length >= total || items.length === 0) break;
    await sleep(120);
  }
  return rows;
}

/**
 * 병원마다 기본정보(getHsptlBassInfoInqire)에서 일반 진료시간 8칸을 읽는다. 한 곳이 실패해도 전체를 멈추지 않고,
 * 그 병원은 지금 게시된 값(없으면 모두 비움)을 그대로 쓴다.
 */
async function collectGeneralHours(api, ids, previous) {
  const out = new Map();
  let failed = 0;
  for (const id of ids) {
    try {
      const raw = (await api.call("getHsptlBassInfoInqire", { HPID: id, pageNo: "1", numOfRows: "1" })).items[0];
      if (raw) { out.set(id, hoursOf(raw)); continue; }
    } catch (e) {
      failed++;
      if (failed <= 3) log(`일반 진료시간 조회 실패(${id}): ${e.message}`);      // 요청 주소·본문(키가 들어갈 수 있음)은 담지 않는다
    }
    if (previous.get(id)) out.set(id, previous.get(id));
    await sleep(80);
  }
  log(`일반 진료시간: ${ids.length}곳 중 ${[...out.values()].filter((h) => h.some(Boolean)).length}곳 있음, 조회 실패 ${failed}곳`);
  return out;
}

async function main() {
  const key = process.env.DATA_GO_KR_API_KEY;
  if (!key) {
    console.error("DATA_GO_KR_API_KEY 가 필요합니다.");
    process.exit(1);
  }
  // 연결이 끊기거나 서버가 바쁠 때는 호출마다 다시 시도한다(약국 수집과 같은 클라이언트)
  const api = createApi({ base: BASE, key, maxCalls: MAX_CALLS });
  const existing = await readJson(OUT_FILE, null);
  const rows = await collect(api);
  const seen = new Set();
  const items = rows.map((raw) => hospitalItem(raw)).filter((h) => h && !seen.has(h.id) && seen.add(h.id))
    .sort((a, b) => (a.sido ?? "힣").localeCompare(b.sido ?? "힣", "ko") || a.name.localeCompare(b.name, "ko"));
  const general = await collectGeneralHours(api, items.map((h) => h.id), new Map((existing?.items ?? []).filter((h) => h.generalHours).map((h) => [h.id, h.generalHours])));
  for (const h of items) h.generalHours = general.get(h.id) ?? h.generalHours;
  const count = (f) => items.filter(f).length;
  log(`응답 ${rows.length}건 중 ${items.length}건 채택(건너뜀 ${rows.length - items.length})`);
  const bySido = {};
  for (const i of items) bySido[i.sido ?? "미상"] = (bySido[i.sido ?? "미상"] ?? 0) + 1;
  log(`시도별: ${JSON.stringify(bySido)}`);
  log(`좌표 있음 ${count((i) => i.lat != null)}건, 전화 있음 ${count((i) => i.tel)}건, 진료시간이 하나라도 있음 ${count((i) => i.hours.some(Boolean))}건`);

  const existingItems = existing?.items ?? [];
  if (!guardCount(existingItems.length, items.length)) {
    console.error(`수집 결과(${items.length}건)가 0건이거나 지금 게시된 ${existingItems.length}건의 절반 미만이라 파일을 갱신하지 않습니다.`);
    process.exit(1);
  }
  if (existing && sameItems(items, existingItems)) { log("내용 변경 없음 — 파일을 건드리지 않습니다."); return; }
  if (DRY) { log("--dry: 저장하지 않았다"); return; }
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), items }) + "\n");
  log("docs/moonlight.json 저장 완료");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
