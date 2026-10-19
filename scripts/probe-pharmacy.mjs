#!/usr/bin/env node
/**
 * 달빛병원 근처 약국 분류 탐색(보고서만 만들고 앱 데이터는 만들지 않는다).
 * 국립중앙의료원 「전국 약국 정보 조회 서비스」(공공데이터포털 15000576)에서
 *  1) 약국 목록(전국, 좌표·요일별 영업시간)을 받아,
 *  2) docs/moonlight.json 의 병원마다 반경 500m·1km 안의 약국을 좌표로 직접 찾고,
 *  3) 평일 18시 이후·22시 이후·주말·공휴일 운영과 "가장 늦게 끝나는 약국의 종료 시각"으로 병원을 나눠 센다.
 * 위치(반경) 조회 기능은 지금 영업 중인 약국만 돌려주는 것으로 보여(2026-10-19 첫 실행) 쓰지 않고,
 * 앞쪽 몇 곳만 목록 기준 결과와 비교해 그 가설을 확인한다. 각 기능의 첫 응답의 필드 이름·값도 출력한다(공개 약국 정보뿐, 인증키는 출력하지 않는다).
 *
 * 환경변수: DATA_GO_KR_API_KEY(위 서비스 활용신청이 승인된 키), MAX_CALLS(기본 900, 개발계정 하루 1,000건), PHARMACY_REPORT(보고서를 저장할 파일 경로, 선택).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiBody } from "./moonlight-lib.mjs";
import { distanceMeters, hoursOfRaw, classifyHours, pharmacyKey, summarize } from "./pharmacy-lib.mjs";

const ROOT = process.env.PHARMACY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.PHARMACY_API_BASE || "https://apis.data.go.kr/B552657/ErmctInsttInfoInqireService";
const PAGE_SIZE = Number(process.env.PHARMACY_PAGE_SIZE || 100);
const MAX_PAGES = 400;
const NEAR_ROWS = 30;
const COMPARE = Number(process.env.PHARMACY_COMPARE || 5);       // 위치 조회와 비교할 병원 수
const MAX_CALLS = Number(process.env.MAX_CALLS || 900);
const RADII = [500, 1000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (...a) => { const s = a.join(" "); lines.push(s); console.log(s); };
let calls = 0;

async function call(key, op, params) {
  if (calls >= MAX_CALLS) throw new Error("호출 상한 도달");
  calls++;
  const url = new URL(`${BASE}/${op}`);
  url.search = new URLSearchParams({ serviceKey: key, _type: "json", ...params }).toString();
  const res = await fetch(url);
  const text = await res.text();
  try {
    return parseApiBody(text);
  } catch (e) {
    throw new Error(`${op}: ${e.message} (HTTP ${res.status})`);      // 요청 주소·본문(키가 들어갈 수 있음)은 출력하지 않는다
  }
}

const sample = (label, item) => item && log(`[${label}] 첫 응답 필드: ${Object.keys(item).join(", ")}\n[${label}] 첫 응답 값: ${JSON.stringify(item)}`);

/** 전국 약국 목록 → [{ key, lat, lng, c }] (좌표가 없거나 범위 밖이면 뺀다). */
async function listPass(key) {
  const out = [];
  let total = 0, first = null, noCoord = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, total: t } = await call(key, "getParmacyListInfoInqire", { pageNo: String(page), numOfRows: String(PAGE_SIZE) });
    total = t;
    first ??= items[0];
    for (const raw of items) {
      const k = pharmacyKey(raw), lat = Number(raw.wgs84Lat), lng = Number(raw.wgs84Lon);
      if (!k || !(lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132)) { noCoord++; continue; }
      out.push({ key: k, lat, lng, c: classifyHours(hoursOfRaw(raw)) });
    }
    if (page * PAGE_SIZE >= t || items.length === 0) break;
    await sleep(100);
  }
  sample("목록", first);
  log(`목록 조회: 전체 ${total}건 중 좌표·식별자가 있는 약국 ${out.length}곳(없는 약국 ${noCoord}곳), 호출 ${calls}회`);
  return out;
}

const within = (pharmacies, hospital, radius) => pharmacies
  .map((p) => ({ ...p, meters: distanceMeters(hospital.lat, hospital.lng, p.lat, p.lng) }))
  .filter((p) => p.meters <= radius);

/** 위치(반경) 조회: 병원 좌표 기준 가까운 약국의 기관ID와 거리(m). 비교용이다. */
async function nearbyByLocation(key, hospital) {
  const { items } = await call(key, "getParmacyLcinfoInqire", {
    WGS84_LON: String(hospital.lng), WGS84_LAT: String(hospital.lat), pageNo: "1", numOfRows: String(NEAR_ROWS),
  });
  return { items, first: items[0] };
}

async function main() {
  const key = (process.env.DATA_GO_KR_API_KEY || "").trim();
  if (!key) { console.error("DATA_GO_KR_API_KEY 가 필요합니다."); process.exit(1); }
  const apiKey = key.includes("%") ? decodeURIComponent(key) : key;

  const hospitals = JSON.parse(await readFile(resolve(ROOT, "docs/moonlight.json"), "utf8")).items.filter((h) => h.lat != null && h.lng != null);
  log(`달빛병원 ${hospitals.length}곳(좌표 있음) 기준`);

  const pharmacies = await listPass(apiKey);
  const rows = hospitals.map((h) => ({ name: h.name, pharmacies: within(pharmacies, h, Math.max(...RADII)).map((p) => ({ meters: p.meters, c: p.c, key: p.key })) }));
  const s = summarize(rows, RADII);
  for (const r of RADII) {
    const b = s.byRadius[r], k = s.closeBuckets[r];
    log(`반경 ${r}m: 약국이 있는 병원 ${b.anyPharmacy}곳 / 평일 18시 이후 ${b.weekdayAfter18}곳 / 22시 이후 ${b.weekdayAfter22}곳 / 주말 ${b.weekend}곳 / 공휴일 ${b.holiday}곳 (병원 ${s.hospitals}곳 중)`);
    log(`반경 ${r}m 평일 종료 시각별 병원: 약국 없음 ${k.none}곳 / 18시 이전 종료 ${k.noLate}곳 / 18~20시 ${k.b18to20}곳 / 20~22시 ${k.b20to22}곳 / 22시 이상 ${k.b22plus}곳`);
  }
  const dist = {};
  for (const n of Object.values(s.perHospitalAfter18Within1000)) { const label = n >= 5 ? "5곳 이상" : `${n}곳`; dist[label] = (dist[label] ?? 0) + 1; }
  log(`1km 안 평일 18시 이후 약국 수별 병원 분포: ${JSON.stringify(dist)}`);
  log(`1km 안에 평일 18시 이후 약국이 없는 병원 ${s.noWeekdayAfter18Within1000.length}곳: ${s.noWeekdayAfter18Within1000.join(", ")}`);

  // 위치 조회와 비교(앞쪽 몇 곳만): 위치 조회가 지금 영업 중인 약국만 주는지 본다
  let failed = 0, firstNear = null;
  for (let i = 0; i < Math.min(COMPARE, hospitals.length); i++) {
    const h = hospitals[i];
    try {
      const { items, first } = await nearbyByLocation(apiKey, h);
      firstNear ??= first;
      const opKeys = new Set(items.filter((raw) => Number(raw.distance) * 1000 <= 1000).map((raw) => pharmacyKey(raw)));
      const listWithin = rows[i].pharmacies.filter((p) => p.meters <= 1000);
      const missing = listWithin.filter((p) => !opKeys.has(p.key));
      log(`비교(${h.name}): 목록 기준 1km 안 ${listWithin.length}곳 / 위치 조회 1km 안 ${opKeys.size}곳 / 위치 조회에 없는 약국 ${missing.length}곳 중 평일 22시 이전에 끝나는 약국 ${missing.filter((p) => p.c.maxClose < 2200).length}곳`);
    } catch (e) {
      if (++failed === 1) console.error(`위치 조회 실패: ${e.message}`);
    }
    await sleep(100);
  }
  sample("위치", firstNear);
  log(`총 호출 ${calls}회`);

  if (process.env.PHARMACY_REPORT) {
    await mkdir(dirname(process.env.PHARMACY_REPORT), { recursive: true });
    await writeFile(process.env.PHARMACY_REPORT, `${lines.join("\n")}\n`);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
