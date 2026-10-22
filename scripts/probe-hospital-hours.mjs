#!/usr/bin/env node
/**
 * 달빛병원의 "일반 진료시간"이 공공 API 에 있는지 확인한다(보고서만 만들고 앱 데이터는 만들지 않는다).
 * docs/moonlight.json 의 병원마다 국립중앙의료원 「전국 병·의원 찾기 서비스」(공공데이터포털 15000736)의
 * 병원 기본정보 조회(getHsptlBassInfoInqire, HPID)를 불러 요일별 진료시간(dutyTime1s~8c)이 있는지 센다.
 * 첫 응답의 필드 이름·값(공개 병원 정보뿐)과, 달빛 운영시간과 다른 병원 수도 함께 출력한다. 인증키는 출력하지 않는다.
 *
 * 환경변수: DATA_GO_KR_API_KEY, MAX_CALLS(기본 300), HOURS_REPORT(보고서를 저장할 파일 경로, 선택).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hoursOf } from "./moonlight-lib.mjs";
import { createApi } from "./pharmacy-api.mjs";

const ROOT = process.env.MOONLIGHT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.MOONLIGHT_API_BASE || "https://apis.data.go.kr/B552657/HsptlAsembySearchService";
const MAX_CALLS = Number(process.env.MAX_CALLS || 300);
const lines = [];
const log = (...a) => { const s = a.join(" "); lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.DATA_GO_KR_API_KEY;
  if (!key) { console.error("DATA_GO_KR_API_KEY 가 필요합니다."); process.exit(1); }
  const items = JSON.parse(await readFile(resolve(ROOT, "docs/moonlight.json"), "utf8")).items ?? [];
  const api = createApi({ base: BASE, key, maxCalls: MAX_CALLS });
  let got = 0, withHours = 0, differs = 0, failed = 0, first = null;
  for (const h of items) {
    let raw;
    try { raw = (await api.call("getHsptlBassInfoInqire", { HPID: h.id, pageNo: "1", numOfRows: "1" })).items[0]; }
    catch (e) { failed++; if (failed <= 3) log(`조회 실패(${h.id}): ${e.message}`); continue; }
    if (!raw) continue;
    got++; first ??= raw;
    const general = hoursOf(raw);
    if (general.some(Boolean)) { withHours++; if (JSON.stringify(general) !== JSON.stringify(h.hours)) differs++; }
    await sleep(80);
  }
  log(`달빛병원 ${items.length}곳 중 기본정보 응답 ${got}곳, 요일별 진료시간 있음 ${withHours}곳, 달빛 운영시간과 다름 ${differs}곳, 조회 실패 ${failed}곳 (API 호출 ${api.calls}회)`);
  if (first) log(`첫 응답 필드: ${Object.keys(first).join(", ")}\n첫 응답 값: ${JSON.stringify(first)}`);
  if (process.env.HOURS_REPORT) {
    const out = resolve(ROOT, process.env.HOURS_REPORT);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, lines.join("\n") + "\n");
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
