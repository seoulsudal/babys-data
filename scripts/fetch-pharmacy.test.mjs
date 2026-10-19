// 약국 수집 스크립트의 실제 흐름을 가짜 API 서버(127.0.0.1)로 검증한다 — 인증키·네트워크 없이, 임시 폴더에서.
// 아래 병원·약국·좌표는 모두 검증용 가상 값이다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "fetch-pharmacy.mjs");

const pharmacy = (id, name, lat, close) => {
  const times = [1, 2, 3, 4, 5].map((d) => `<dutyTime${d}s>0900</dutyTime${d}s><dutyTime${d}c>${close}</dutyTime${d}c>`).join("");
  return `<item><hpid>${id}</hpid><dutyName>${name}</dutyName><dutyAddr>서울특별시 가나구 ${name}</dutyAddr><dutyTel1>02-000-000${id.slice(1)}</dutyTel1>${times}<wgs84Lat>${lat}</wgs84Lat><wgs84Lon>127.0</wgs84Lon></item>`;
};
// 병원A(37.5, 127.0). P1: 100m·22시까지(포함) / P2: 700m·18시까지(20시 이전이라 제외) / P3: 멀리(제외) / P4: 150m·정확히 20시까지(포함) / P5: 5.5km(밤까지지만 병원 1km 밖이라 제외)
const LIST = [
  pharmacy("P1", "밤 약국", 37.5009, "2200"), pharmacy("P2", "낮 약국", 37.5063, "1800"), pharmacy("P3", "먼 약국", 35.1, "2300"),
  pharmacy("P4", "여덟시 약국", 37.5014, "2000"), pharmacy("P5", "다른 약국", 37.55, "2300"),
];

function fakeServer(mode = "ok") {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const op = url.pathname.split("/").pop();
    calls.push(op);
    res.setHeader("content-type", "application/xml");
    if (mode === "error") return res.end("<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>");
    if (op !== "getParmacyListInfoInqire") { res.statusCode = 404; return res.end("not found"); }
    const rows = Number(url.searchParams.get("numOfRows")), page = Number(url.searchParams.get("pageNo"));
    const list = mode === "empty" ? [] : LIST;
    res.end(`<response><header><resultCode>00</resultCode></header><body><items>${list.slice((page - 1) * rows, page * rows).join("")}</items><totalCount>${list.length}</totalCount></body></response>`);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, calls, port: server.address().port })));
}

async function setup(baselineCount) {
  const root = await mkdtemp(join(tmpdir(), "pharmacy-fetch-"));
  await mkdir(join(root, "docs"), { recursive: true });
  const hospitals = [{ id: "H1", name: "병원A", lat: 37.5, lng: 127.0 }, { id: "H3", name: "좌표없음", lat: null, lng: null }];
  await writeFile(join(root, "docs/moonlight.json"), JSON.stringify({ updatedAt: "2026-10-19T00:00:00Z", items: hospitals }));
  if (baselineCount != null) {
    const items = Array.from({ length: baselineCount }, (_, i) => ({ id: `old-${i}`, name: `옛 ${i}` }));
    await writeFile(join(root, "docs/pharmacy.json"), JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", items }));
  }
  return root;
}

function run(root, port, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, PHARMACY_ROOT: root, DATA_GO_KR_API_KEY: "test-key-123", PHARMACY_API_BASE: `http://127.0.0.1:${port}`, PHARMACY_PAGE_SIZE: "2", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => ok({ code, out }));
  });
}

const readOut = async (root) => JSON.parse(await readFile(join(root, "docs/pharmacy.json"), "utf8"));

test("정상 수집: 병원 1km 안이고 평일 20시 이후까지 하는 약국만, 가까운 병원과 함께 저장한다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await setup(1);
  try {
    const r = await run(root, port);
    assert.equal(r.code, 0, r.out);
    const out = await readOut(root);
    assert.match(out.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(out.items.map((i) => i.id).sort(), ["P1", "P4"]);                    // P2(18시 종료)·P3·P5(병원 1km 밖)는 빠진다
    const p1 = out.items.find((i) => i.id === "P1");
    assert.equal(p1.near.id, "H1");
    assert.equal(p1.near.name, "병원A");
    assert.equal(p1.hours[0], "0900-2200");
    assert.equal(p1.sido, "서울");
    assert.equal(calls.length, 3);                                                          // 5건을 2건씩 → 3쪽
    assert.equal(JSON.stringify(out).includes("test-key-123"), false);
    assert.match(r.out, /약국 2곳 저장/);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("같은 결과가 다시 오면 파일을 건드리지 않는다(updatedAt 유지)", async () => {
  const { server, port } = await fakeServer();
  const root = await setup(null);
  try {
    assert.equal((await run(root, port)).code, 0);
    const first = await readOut(root);
    await new Promise((r) => setTimeout(r, 30));
    const again = await run(root, port);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /변경 없음/);
    assert.equal((await readOut(root)).updatedAt, first.updatedAt);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("0건이거나 지금 게시된 건수의 절반 미만이면 실패하고 기존 파일을 덮어쓰지 않는다", async () => {
  const empty = await fakeServer("empty");
  const root = await setup(5);
  try {
    const r = await run(root, empty.port);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /약국 목록이 비어 있습니다/);                                          // 호출 한도 초과·점검 같은 원인을 짐작하게 알린다
    assert.equal((await readOut(root)).items.length, 5);
  } finally { empty.server.close(); await rm(root, { recursive: true, force: true }); }
  const ok = await fakeServer();
  const root2 = await setup(10);
  try {
    const r = await run(root2, ok.port);                                                   // 수집 2건 < 게시 10건의 절반
    assert.notEqual(r.code, 0);
    assert.equal((await readOut(root2)).items.length, 10);
  } finally { ok.server.close(); await rm(root2, { recursive: true, force: true }); }
});

test("인증키가 없으면 호출 없이 실패하고, 서비스 오류는 코드만 알리며 키를 출력하지 않는다", async () => {
  const { server, calls, port } = await fakeServer("error");
  const root = await setup(null);
  try {
    const none = await run(root, port, { DATA_GO_KR_API_KEY: "" });
    assert.notEqual(none.code, 0);
    assert.equal(calls.length, 0);
    const bad = await run(root, port);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /30/);
    assert.equal(bad.out.includes("test-key-123"), false);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
