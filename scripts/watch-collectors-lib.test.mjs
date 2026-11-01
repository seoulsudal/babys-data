// 수집 점검 순수 함수 시험. 아래 실행 기록은 모두 검증용 가상 값이다.
import test from "node:test";
import assert from "node:assert/strict";
import { RULES, assess, hasProblem, buildReport, collect } from "./watch-collectors-lib.mjs";

const NOW = new Date("2026-11-01T01:30:00Z");
const daysAgo = (d, hours = 0) => new Date(NOW.getTime() - d * 86_400_000 - hours * 3_600_000).toISOString();
const run = (conclusion, d, hours = 0) => ({ conclusion, created_at: daysAgo(d, hours) });
const daily = { file: "update-outing.yml", label: "나들이 수집", maxAgeDays: 3, maxConsecutiveFailures: 2 };
const monthly = { file: "update-places.yml", label: "키즈카페 수집", maxAgeDays: 40, maxConsecutiveFailures: 1 };
const active = { state: "active" };

test("매일 성공하면 정상이다", () => {
  const r = assess(daily, active, [run("success", 0, 10), run("success", 1, 10), run("success", 2, 10)], NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.consecutiveFailures, 0);
});

test("마지막 성공이 기준일보다 오래되면 문제이고, 기준일 안이면 정상이다", () => {
  const old = assess(daily, active, [run("success", 4)], NOW);
  assert.equal(old.ok, false);
  assert.match(old.problems.join(" "), /4일 전/);
  assert.equal(assess(daily, active, [run("success", 3)], NOW).ok, true);     // 경계: 정확히 3일은 정상
});

test("연속으로 실패한 횟수가 기준에 닿으면 문제이고, 한 번 실패는 정상이다", () => {
  const two = assess(daily, active, [run("failure", 0, 10), run("failure", 1, 10), run("success", 2, 10)], NOW);
  assert.equal(two.ok, false);
  assert.equal(two.consecutiveFailures, 2);
  assert.match(two.problems.join(" "), /연속 2번 실패/);
  const one = assess(daily, active, [run("failure", 0, 10), run("success", 1, 10)], NOW);
  assert.equal(one.ok, true);
  assert.equal(one.consecutiveFailures, 1);
});

test("실패 뒤 성공하면 연속 실패는 다시 센다", () => {
  const r = assess(daily, active, [run("success", 0, 10), run("failure", 1, 10), run("failure", 2, 10)], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.consecutiveFailures, 0);
});

test("취소·건너뜀·진행 중인 실행은 성공도 실패도 아니라 무시한다", () => {
  const runs = [{ conclusion: null, created_at: daysAgo(0) }, run("cancelled", 0, 5), run("failure", 1, 10), run("skipped", 1, 12), run("failure", 2, 10)];
  const r = assess(daily, active, runs, NOW);
  assert.equal(r.consecutiveFailures, 2);       // 실패 2번(그 사이의 취소·건너뜀은 끊지 않는다)
  assert.equal(r.ok, false);
});

test("시간 초과·시작 실패도 실패로 센다", () => {
  const r = assess(daily, active, [run("timed_out", 0, 10), run("startup_failure", 1, 10), run("success", 2, 10)], NOW);
  assert.equal(r.consecutiveFailures, 2);
});

test("성공한 실행이 하나도 없으면 문제다", () => {
  assert.equal(assess(daily, active, [], NOW).ok, false);
  assert.match(assess(daily, active, [], NOW).problems.join(" "), /성공한 실행 기록이 없어요/);
  assert.equal(assess(daily, active, [run("failure", 0, 10)], NOW).ok, false);
});

test("워크플로가 꺼져 있으면 실행 기록이 좋아 보여도 문제다", () => {
  const r = assess(daily, { state: "disabled_inactivity" }, [run("success", 0, 10)], NOW);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /꺼져 있어요/);
  assert.equal(assess(daily, null, [run("success", 0, 10)], NOW).ok, false);      // 워크플로를 못 찾음
});

test("순서가 섞여 들어와도 시각으로 정렬해 판단한다", () => {
  const r = assess(daily, active, [run("failure", 2, 10), run("success", 0, 10), run("failure", 1, 10)], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.consecutiveFailures, 0);
});

test("월 1회 수집은 한 번만 실패해도 문제이고 40일을 넘기면 문제다", () => {
  assert.equal(assess(monthly, active, [run("failure", 1), run("success", 30)], NOW).ok, false);
  assert.equal(assess(monthly, active, [run("success", 41)], NOW).ok, false);
  assert.equal(assess(monthly, active, [run("success", 30)], NOW).ok, true);
});

test("점검 대상은 매일 수집 3개와 월 1회 수집·주 1회 점검이다", () => {
  const files = RULES.map((r) => r.file);
  for (const f of ["update-outing.yml", "update-moonlight.yml", "update-pharmacy.yml", "update-places.yml", "check-vcninfo.yml"]) assert.ok(files.includes(f), f);
  assert.ok(RULES.every((r) => r.maxAgeDays > 0 && r.maxConsecutiveFailures >= 1 && r.label));
});

test("보고서: 문제가 있으면 이름·마지막 성공·할 일이 들어가고, 없으면 정상이라고 적는다", () => {
  const bad = [{ ...assess(daily, active, [run("success", 5)], NOW), rule: daily }];
  const good = [{ ...assess(daily, active, [run("success", 0, 10)], NOW), rule: daily }];
  assert.equal(hasProblem(bad), true);
  assert.equal(hasProblem(good), false);
  const text = buildReport(bad, NOW);
  assert.match(text, /나들이 수집/);
  assert.match(text, /5일 전/);
  assert.match(text, /Actions 탭/);
  assert.match(text, /2026-11-01/);
  assert.doesNotMatch(text, /Bearer|ghp_|github_pat_/);      // 인증값은 보고서에 들어가지 않는다(안내에는 키 이름만 나온다)
  assert.match(buildReport(good, NOW), /모두 정상/);
});

test("collect: 규칙마다 워크플로와 실행 기록을 읽어 판단한다", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const body = String(url).includes("/runs")
      ? { workflow_runs: [{ conclusion: "success", created_at: daysAgo(0, 10) }] }
      : { state: "active" };
    return { ok: true, status: 200, json: async () => body };
  };
  const results = await collect({ fetchImpl, repo: "owner/repo", token: "t", rules: [daily, monthly], now: NOW });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.ok(urls.some((u) => u.includes("/repos/owner/repo/actions/workflows/update-outing.yml/runs")));
  assert.ok(urls.every((u) => u.startsWith("https://api.github.com/")));
});

test("collect: 워크플로 파일을 찾지 못하면(404) 예외가 아니라 문제로 알린다", async () => {
  const fetchImpl = async (url) => ({ ok: !String(url).endsWith("update-outing.yml"), status: String(url).endsWith("update-outing.yml") ? 404 : 200, json: async () => ({ workflow_runs: [], state: "active" }) });
  const [r] = await collect({ fetchImpl, repo: "o/r", token: "", rules: [daily], now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /찾을 수 없어요/);
});

test("collect: API가 실패하면 어느 워크플로인지 알리며 예외를 던진다", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => collect({ fetchImpl, repo: "owner/repo", token: "", rules: [daily], now: NOW }), /update-outing\.yml.*403/);
});

test("collect: 토큰이 있을 때만 인증 머리글을 보낸다", async () => {
  const headers = [];
  const fetchImpl = async (url, init) => { headers.push(init?.headers ?? {}); return { ok: true, status: 200, json: async () => (String(url).includes("/runs") ? { workflow_runs: [] } : { state: "active" }) }; };
  await collect({ fetchImpl, repo: "o/r", token: "abc", rules: [daily], now: NOW });
  await collect({ fetchImpl, repo: "o/r", token: "", rules: [daily], now: NOW });
  assert.ok(headers.slice(0, 2).every((h) => h.Authorization === "Bearer abc"));
  assert.ok(headers.slice(2).every((h) => !("Authorization" in h)));
});
