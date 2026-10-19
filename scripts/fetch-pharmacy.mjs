#!/usr/bin/env node
/**
 * 달빛병원 근처에서 평일 20시 이후까지 영업하는 약국을 모아 docs/pharmacy.json 으로 만든다(BABYS 앱의 달빛병원 탭 "약국" 자료).
 * 출처: 국립중앙의료원 「전국 약국 정보 조회 서비스」(공공데이터포털 15000576) 약국 목록(전국, 좌표·요일별 영업시간).
 * 위치(반경) 조회는 지금 영업 중인 약국만 돌려줘서 쓰지 않고, 목록의 좌표로 직접 거리를 계산한다.
 * 조건: ① docs/moonlight.json 의 달빛병원 중 가장 가까운 곳까지 직선 1km 이하, ② 평일(월~금) 종료 시각이 20시 이후.
 *
 * 사용법
 *   node scripts/fetch-pharmacy.mjs --dry   # 수집 결과를 쓰지 않고 요약만 출력 (API 호출은 실제로 일어난다)
 *   node scripts/fetch-pharmacy.mjs         # 수집 후 docs/pharmacy.json 갱신 (내용이 바뀌었을 때만)
 *
 * 환경변수: DATA_GO_KR_API_KEY(위 서비스 활용신청이 승인된 키), MAX_CALLS(기본 900, 개발계정 하루 1,000건). 키는 로그에 출력하지 않는다.
 *
 * 안전장치(달빛병원·나들이 수집과 같다)
 *  - 0건이거나 지금 게시된 파일의 절반 미만이면 파일을 덮어쓰지 않고 실패한다(앱은 기존 데이터를 계속 쓴다).
 *  - 내용(items)이 그대로면 파일을 건드리지 않는다. 바뀌었을 때만 updatedAt 을 새로 적는다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sameItems, guardCount } from "./outing-lib.mjs";
import { createApi, listAllPharmacies } from "./pharmacy-api.mjs";
import { classifyHours, hoursOfRaw, nearestHospital, pharmacyItem } from "./pharmacy-lib.mjs";

// 시험에서는 PHARMACY_ROOT 로 임시 폴더를 가리킨다(실제 docs/pharmacy.json 을 건드리지 않게)
const ROOT = process.env.PHARMACY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = resolve(ROOT, "docs/pharmacy.json");
const HOSPITAL_FILE = resolve(ROOT, "docs/moonlight.json");

const BASE = process.env.PHARMACY_API_BASE || "https://apis.data.go.kr/B552657/ErmctInsttInfoInqireService";
const PAGE_SIZE = Number(process.env.PHARMACY_PAGE_SIZE || 100);
const MAX_CALLS = Number(process.env.MAX_CALLS || 900);
const RADIUS_METERS = 1000;       // 달빛병원에서 이 거리 안
const MIN_WEEKDAY_CLOSE = 2000;   // 평일 종료 시각이 20시 이후

const DRY = process.argv.slice(2).includes("--dry");
const log = (...a) => console.log(...a);

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function main() {
  const key = (process.env.DATA_GO_KR_API_KEY || "").trim();
  if (!key) { console.error("DATA_GO_KR_API_KEY 가 필요합니다."); process.exit(1); }

  const hospitals = (await readJson(HOSPITAL_FILE, { items: [] })).items.filter((h) => h.lat != null && h.lng != null);
  if (hospitals.length === 0) { console.error("docs/moonlight.json 에 좌표가 있는 달빛병원이 없습니다."); process.exit(1); }

  const api = createApi({ base: BASE, key, maxCalls: MAX_CALLS });
  const { items: rows, total } = await listAllPharmacies(api, PAGE_SIZE);

  const seen = new Set();
  const items = [];
  for (const raw of rows) {
    const lat = Number(raw.wgs84Lat), lng = Number(raw.wgs84Lon);
    if (!(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) continue;
    if (classifyHours(hoursOfRaw(raw)).maxClose < MIN_WEEKDAY_CLOSE) continue;
    const near = nearestHospital(lat, lng, hospitals, RADIUS_METERS);
    if (!near) continue;
    const item = pharmacyItem(raw, near);
    if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  log(`약국 전체 ${total}건 중 달빛병원 ${RADIUS_METERS}m 안·평일 ${MIN_WEEKDAY_CLOSE / 100}시 이후 ${items.length}곳 채택, 호출 ${api.calls}회`);

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
  log(`docs/pharmacy.json 에 약국 ${items.length}곳 저장 완료`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
