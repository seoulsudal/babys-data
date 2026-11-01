// 수집 점검 실행 파일. 종료 코드: 0 정상 / 10 확인이 필요한 수집이 있음(보고서를 report 파일에 씀) / 1 점검 자체가 실패(API 오류 등).
// 환경 변수: GITHUB_REPOSITORY(기본 seoulsudal/babys-data), GITHUB_TOKEN(없으면 공개 API 를 인증 없이 읽는다), WATCH_NOW(시험용 기준 시각).
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collect, buildReport, hasProblem } from "./watch-collectors-lib.mjs";

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || "seoulsudal/babys-data";
  const now = process.env.WATCH_NOW ? new Date(process.env.WATCH_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("WATCH_NOW 가 올바른 날짜가 아니에요");
  const out = process.argv[2] ?? "report.md";
  const results = await collect({ repo, token: process.env.GITHUB_TOKEN, now });
  writeFileSync(out, buildReport(results, now), "utf-8");
  for (const r of results) {
    const last = r.ageDays === null ? "없음" : `${r.ageDays}일 전`;
    console.log(`${r.ok ? "정상" : "문제"} ${r.rule.file} · 마지막 성공 ${last} · 연속 실패 ${r.consecutiveFailures}${r.problems.length ? " — " + r.problems.join(" ") : ""}`);
  }
  return hasProblem(results) ? 10 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => { console.error("점검 실패:", e.message); process.exit(1); },
  );
}
