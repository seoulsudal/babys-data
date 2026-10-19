#!/usr/bin/env node
/**
 * 달빛병원 근처 약국 분류 탐색(보고서만 출력하고 파일은 만들지 않는다).
 * 국립중앙의료원 「전국 약국 정보 조회 서비스」(공공데이터포털 15000576)에서
 *  1) 약국 목록(전국, 요일별 영업시간)을 받아 기관ID → 시간표를 만들고,
 *  2) docs/moonlight.json 의 병원마다 "위치 기준 반경 조회"로 가까운 약국을 받아,
 *  3) 반경(500m·1km) 안에 평일 18시 이후·22시 이후·주말·공휴일에 시간이 있는 약국이 있는 병원이 몇 곳인지 센다.
 * 응답 필드 이름이 문서와 다를 수 있어, 각 기능의 첫 응답의 필드 이름과 값을 함께 출력한다(공개 약국 정보뿐이며 인증키는 출력하지 않는다).
 *
 * 환경변수: DATA_GO_KR_API_KEY(위 서비스 활용신청이 승인된 키). 호출 상한 MAX_CALLS(기본 900, 개발계정 하루 1,000건).
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiBody } from "./moonlight-lib.mjs";
import { distanceMeters, hoursOfRaw, classifyHours, pharmacyKey, summarize } from "./pharmacy-lib.mjs";

const ROOT = process.env.PHARMACY_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.PHARMACY_API_BASE || "https://apis.data.go.kr/B552657/ErmctInsttInfoInqireService";
const PAGE_SIZE = Number(process.env.PHARMACY_PAGE_SIZE || 100);
const MAX_PAGES = 400;
const NEAR_ROWS = Number(process.env.PHARMACY_NEAR_ROWS || 30);
const MAX_CALLS = Number(process.env.MAX_CALLS || 900);
const RADII = [500, 1000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
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

async function listPass(key) {
  const byKey = new Map();
  let total = 0, first = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, total: t } = await call(key, "getParmacyListInfoInqire", { pageNo: String(page), numOfRows: String(PAGE_SIZE) });
    total = t;
    first ??= items[0];
    for (const raw of items) {
      const k = pharmacyKey(raw);
      if (k) byKey.set(k, { hours: hoursOfRaw(raw), raw });
    }
    if (page * PAGE_SIZE >= t || items.length === 0) break;
    await sleep(100);
  }
  sample("목록", first);
  log(`목록 조회: 전체 ${total}건 중 시간표 ${byKey.size}곳, 호출 ${calls}회`);
  return byKey;
}

/** 병원 좌표 기준 가까운 약국(거리순). 거리는 응답 좌표가 있으면 직접 계산하고, 없으면 응답의 distance(km)를 쓴다. */
async function nearby(key, hospital) {
  const { items } = await call(key, "getParmacyLcinfoInqire", {
    WGS84_LON: String(hospital.lng), WGS84_LAT: String(hospital.lat), pageNo: "1", numOfRows: String(NEAR_ROWS),
  });
  return items.map((raw) => {
    const lat = Number(raw.latitude ?? raw.wgs84Lat), lng = Number(raw.longitude ?? raw.wgs84Lon);
    const meters = Number.isFinite(lat) && Number.isFinite(lng) && lat && lng
      ? distanceMeters(hospital.lat, hospital.lng, lat, lng)
      : Number(raw.distance) * 1000;
    return { raw, meters };
  });
}

async function main() {
  const key = (process.env.DATA_GO_KR_API_KEY || "").trim();
  if (!key) { console.error("DATA_GO_KR_API_KEY 가 필요합니다."); process.exit(1); }
  const apiKey = key.includes("%") ? decodeURIComponent(key) : key;

  const hospitals = JSON.parse(await readFile(resolve(ROOT, "docs/moonlight.json"), "utf8")).items.filter((h) => h.lat != null && h.lng != null);
  log(`달빛병원 ${hospitals.length}곳(좌표 있음) 기준`);

  const hoursByKey = await listPass(apiKey);
  const rows = [];
  let firstNear = null, noHours = 0, noKey = 0, failed = 0;
  for (const h of hospitals) {
    let near;
    try { near = await nearby(apiKey, h); } catch (e) {
      if (++failed === 1) console.error(`위치 조회 실패: ${e.message}`);
      if (e.message === "호출 상한 도달") break;
      continue;
    }
    firstNear ??= near[0]?.raw;
    const pharmacies = [];
    for (const { raw, meters } of near) {
      const k = pharmacyKey(raw);
      if (!k) { noKey++; continue; }
      const hours = hoursByKey.get(k)?.hours ?? hoursOfRaw(raw);
      if (!hours.some(Boolean)) noHours++;
      if (Number.isFinite(meters)) pharmacies.push({ meters, c: classifyHours(hours) });
    }
    rows.push({ name: h.name, pharmacies });
    await sleep(100);
  }
  sample("위치", firstNear);
  log(`위치 조회: 병원 ${rows.length}곳 완료(실패 ${failed}곳), 시간표를 못 찾은 약국 ${noHours}건, 식별자 없는 약국 ${noKey}건, 총 호출 ${calls}회`);
  if (rows.length === 0) { console.error("분류할 병원이 없습니다."); process.exit(1); }

  const s = summarize(rows, RADII);
  for (const r of RADII) {
    const b = s.byRadius[r];
    log(`반경 ${r}m: 약국이 있는 병원 ${b.anyPharmacy}곳 / 평일 18시 이후 ${b.weekdayAfter18}곳 / 22시 이후 ${b.weekdayAfter22}곳 / 주말 ${b.weekend}곳 / 공휴일 ${b.holiday}곳 (병원 ${s.hospitals}곳 중)`);
  }
  const dist = {};
  for (const n of Object.values(s.perHospitalAfter18Within1000)) dist[n >= 5 ? "5곳 이상" : `${n}곳`] = (dist[n >= 5 ? "5곳 이상" : `${n}곳`] ?? 0) + 1;
  log(`1km 안 평일 18시 이후 약국 수별 병원 분포: ${JSON.stringify(dist)}`);
  log(`1km 안에 평일 18시 이후 약국이 없는 병원 ${s.noWeekdayAfter18Within1000.length}곳: ${s.noWeekdayAfter18Within1000.slice(0, 20).join(", ")}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
