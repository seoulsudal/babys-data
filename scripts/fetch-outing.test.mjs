// 수집 스크립트의 실제 흐름을 가짜 API 서버(127.0.0.1)로 검증한다 — 인증키·네트워크 없이, 임시 폴더에서.
// 아래 항목·이름은 모두 검증용 가상 값이며 실제 장소·행사가 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "fetch-outing.mjs");
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const compact = (s) => s.replaceAll("-", "");
const day = (offset) => ymd(new Date(Date.now() + offset * 86400000));

/** 가짜 TourAPI·서울 API. calls 에 호출한 연산 이름을 쌓는다. */
function fakeServer({ tourPlaces = 1, seoulRows = 1 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (obj) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    if (url.pathname.startsWith("/tour/")) {
      const op = url.pathname.split("/").pop();
      calls.push(op);
      const ok = (items, total = items.length) => send({ response: { header: { resultCode: "0000" }, body: { items: items.length ? { item: items } : "", totalCount: total } } });
      const region = url.searchParams.get("lDongRegnCd");
      if (op === "searchFestival2") {
        return ok(region === "11" ? [{ contentid: "E1", contenttypeid: "15", title: "어린이 가족 축제", eventstartdate: compact(day(-1)), eventenddate: compact(day(3)), addr1: "서울 가나구 시험로 1", mapy: "37.5", mapx: "127.0", tel: "02-111-2222" }] : []);
      }
      if (op === "searchKeyword2") {
        if (region !== "11" || url.searchParams.get("keyword") !== "어린이") return ok([]);
        return ok(Array.from({ length: tourPlaces }, (_, i) => ({ contentid: `P${i + 1}`, contenttypeid: "12", title: `어린이 놀이터 ${i + 1}`, addr1: "서울 다라구 시험로 2", mapy: "37.4", mapx: "127.1", tel: "010-1234-5678" })));
      }
      if (op === "detailCommon2") return ok([{ overview: `개요 <b>${url.searchParams.get("contentId")}</b> 어린이 가족`, homepage: '<a href="https://example.com/h">홈</a>' }]);
      if (op === "detailIntro2") return ok([{ eventhomepage: "https://example.com/event" }]);
      return ok([]);
    }
    if (url.pathname.includes("/json/culturalEventInfo/")) {
      calls.push("seoul");
      const rows = Array.from({ length: seoulRows }, (_, i) => ({
        TITLE: `어린이 인형극 ${i + 1}`, STRTDATE: `${day(1)} 00:00:00.0`, END_DATE: `${day(2)} 00:00:00.0`, PLACE: "시험문화회관", GUNAME: "가나구",
        USE_TRGT: "누구나", CODENAME: "연극", LAT: "127.0", LOT: "37.5", ORG_LINK: "https://example.com/s", PROGRAM: "프로그램",
      }));
      return send({ culturalEventInfo: { list_total_count: rows.length, RESULT: { CODE: "INFO-000" }, row: rows } });
    }
    res.statusCode = 404; res.end("not found");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, calls, port: server.address().port })));
}

async function setup(baselineItems) {
  const root = await mkdtemp(join(tmpdir(), "outing-"));
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data/outing-overrides.json"), "{}");
  if (baselineItems) await writeFile(join(root, "docs/outing.json"), JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", items: baselineItems }));
  return root;
}

function run(root, port, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, OUTING_ROOT: root, DATA_GO_KR_API_KEY: "test-tour", SEOUL_API_KEY: "test-seoul", TOUR_API_BASE: `http://127.0.0.1:${port}/tour`, SEOUL_API_BASE: `http://127.0.0.1:${port}/seoul`, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => ok({ code, out }));
  });
}

const readOut = async (root) => JSON.parse(await readFile(join(root, "docs/outing.json"), "utf8"));
const dummy = (n) => Array.from({ length: n }, (_, i) => ({ id: `old-${i}`, type: "place", title: `옛 ${i}`, region: "서울", source: "tour" }));

test("정상 수집: 앱이 쓰는 필드만 담고, 호출은 행사 2회·장소 1회로 아낀다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await setup(dummy(2));
  try {
    const r = await run(root, port);
    assert.equal(r.code, 0, r.out);
    const out = await readOut(root);
    assert.match(out.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(out.items.map((i) => i.type).sort(), ["event", "event", "place"]);      // 관광공사 행사 + 서울 행사 + 장소
    for (const i of out.items) for (const k of ["image", "ages", "isFree", "indoor"]) assert.equal(k in i, false, `${i.id} ${k}`);
    const place = out.items.find((i) => i.type === "place");
    assert.equal(place.tel, null);                                                          // 휴대전화 번호는 뺀다
    assert.equal(place.officialUrl, "https://example.com/h");
    assert.equal(place.district, "다라구");                                                 // 주소에서 시군구를 채운다
    const tourEvent = out.items.find((i) => i.id === "tour-E1");
    assert.equal(tourEvent.officialUrl, "https://example.com/h");
    assert.equal(calls.filter((c) => c === "detailCommon2").length, 2);                    // 행사 1 + 장소 1
    assert.equal(calls.filter((c) => c === "detailIntro2").length, 1);                     // 소개 정보는 행사만
    const cache = JSON.parse(await readFile(join(root, "data/outing-cache.json"), "utf8"));
    assert.deepEqual(Object.keys(cache.tour).sort(), ["E1", "P1"]);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("같은 결과가 다시 오면 파일을 건드리지 않고, 상세는 캐시로 다시 조회하지 않는다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await setup(dummy(2));
  try {
    assert.equal((await run(root, port)).code, 0);
    const first = await readFile(join(root, "docs/outing.json"), "utf8");
    calls.length = 0;
    const r = await run(root, port);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /내용 변경 없음/);
    assert.equal(await readFile(join(root, "docs/outing.json"), "utf8"), first);          // updatedAt 도 그대로
    assert.equal(calls.filter((c) => c.startsWith("detail")).length, 0);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("지금 게시된 건수의 절반 미만이면 덮어쓰지 않고 실패한다", async () => {
  const { server, port } = await fakeServer();
  const root = await setup(dummy(10));
  try {
    const before = await readFile(join(root, "docs/outing.json"), "utf8");
    const r = await run(root, port);
    assert.equal(r.code, 1);
    assert.match(r.out, /절반 미만/);
    assert.equal(await readFile(join(root, "docs/outing.json"), "utf8"), before);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("TourAPI 호출 상한에 닿으면 남은 상세는 다음 실행으로 미루고 가진 것만 낸다", async () => {
  const { server, calls, port } = await fakeServer({ tourPlaces: 10 });
  const root = await setup(dummy(2));
  try {
    const r = await run(root, port, { MAX_TOUR_CALLS: "58" })   // 목록 조회가 51회라 상세에는 7회가 남는다;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /상한 도달/);
    assert.ok(calls.filter((c) => c.startsWith("detail") || c.startsWith("search")).length <= 58);
    const cache = JSON.parse(await readFile(join(root, "data/outing-cache.json"), "utf8"));
    assert.ok(Object.keys(cache.tour).length < 11);                                         // 행사 1 + 장소 10 모두는 못 채웠다
    assert.ok(Object.keys(cache.tour).includes("E1"));                                      // 행사를 먼저 채운다
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("인증키가 하나도 없으면 실패한다", async () => {
  const { server, port } = await fakeServer();
  const root = await setup(dummy(2));
  try {
    const r = await run(root, port, { DATA_GO_KR_API_KEY: "", SEOUL_API_KEY: "" });
    assert.equal(r.code, 1);
    assert.match(r.out, /DATA_GO_KR_API_KEY/);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("키가 한쪽만 있으면 그 소스만 수집한다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await setup(dummy(1));
  try {
    const r = await run(root, port, { DATA_GO_KR_API_KEY: "" });
    assert.equal(r.code, 0, r.out);
    assert.equal(calls.some((c) => c.startsWith("search")), false);
    assert.deepEqual((await readOut(root)).items.map((i) => i.source), ["seoul"]);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
