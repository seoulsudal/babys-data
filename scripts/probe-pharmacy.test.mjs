// 약국 탐색 스크립트의 흐름을 가짜 API 서버(127.0.0.1)로 검증한다 — 인증키·네트워크 없이, 임시 폴더에서.
// 아래 병원·약국·좌표는 모두 검증용 가상 값이다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "probe-pharmacy.mjs");

const pharmacy = (id, name, hours) => {
  const times = hours.map((h, i) => (h ? `<dutyTime${i + 1}s>${h.slice(0, 4)}</dutyTime${i + 1}s><dutyTime${i + 1}c>${h.slice(5)}</dutyTime${i + 1}c>` : "")).join("");
  return `<item><hpid>${id}</hpid><dutyName>${name}</dutyName><dutyAddr>서울 가나구 ${name}</dutyAddr>${times}</item>`;
};
const night = ["0900-2300", "0900-2300", "0900-2300", "0900-2300", "0900-2300", "0900-1800", null, null];
const day = ["0900-1800", "0900-1800", "0900-1800", "0900-1800", "0900-1800", null, null, null];
const LIST = [pharmacy("P1", "밤 약국", night), pharmacy("P2", "낮 약국", day)];

// 병원 좌표 (37.5, 127.0): P1 은 약 100m, P2 는 약 700m. 병원 (37.6, 127.0): 약국이 없다.
const near = (lat) => (Math.abs(lat - 37.5) < 0.01
  ? `<item><hpid>P1</hpid><dutyName>밤 약국</dutyName><dutyAddr>서울 가나구 밤 약국</dutyAddr><latitude>37.5009</latitude><longitude>127.0</longitude><distance>0.1</distance></item>` +
    `<item><hpid>P2</hpid><dutyName>낮 약국</dutyName><dutyAddr>서울 가나구 낮 약국</dutyAddr><latitude>37.5063</latitude><longitude>127.0</longitude><distance>0.7</distance></item>`
  : "");

function fakeServer(mode = "ok") {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const op = url.pathname.split("/").pop();
    calls.push(op);
    res.setHeader("content-type", "application/xml");
    if (mode === "error") return res.end("<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>");
    const wrap = (items, total) => res.end(`<response><header><resultCode>00</resultCode></header><body><items>${items}</items><totalCount>${total}</totalCount></body></response>`);
    if (op === "getParmacyListInfoInqire") {
      const rows = Number(url.searchParams.get("numOfRows")), page = Number(url.searchParams.get("pageNo"));
      return wrap(LIST.slice((page - 1) * rows, page * rows).join(""), LIST.length);
    }
    if (op === "getParmacyLcinfoInqire") return wrap(near(Number(url.searchParams.get("WGS84_LAT"))), 2);
    res.statusCode = 404; res.end("not found");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, calls, port: server.address().port })));
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pharmacy-"));
  await mkdir(join(root, "docs"), { recursive: true });
  const hospitals = [
    { id: "H1", name: "병원A", lat: 37.5, lng: 127.0 },
    { id: "H2", name: "병원B", lat: 37.6, lng: 127.0 },
    { id: "H3", name: "좌표없음", lat: null, lng: null },
  ];
  await writeFile(join(root, "docs/moonlight.json"), JSON.stringify({ updatedAt: "2026-10-19T00:00:00Z", items: hospitals }));
  return root;
}

function run(root, port, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, PHARMACY_ROOT: root, DATA_GO_KR_API_KEY: "test-key-123", PHARMACY_API_BASE: `http://127.0.0.1:${port}`, PHARMACY_PAGE_SIZE: "1", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => ok({ code, out }));
  });
}

test("목록(쪽 넘김)과 위치 조회를 이어 반경별로 분류해 보고한다", async () => {
  const { server, calls, port } = await fakeServer();
  const root = await setup();
  try {
    const r = await run(root, port);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /달빛병원 2곳\(좌표 있음\)/);                                     // 좌표 없는 병원은 뺀다
    assert.match(r.out, /목록 조회: 전체 2건 중 시간표 2곳/);
    assert.equal(calls.filter((c) => c === "getParmacyListInfoInqire").length, 2);       // 2건을 1건씩 → 2쪽
    assert.equal(calls.filter((c) => c === "getParmacyLcinfoInqire").length, 2);         // 병원마다 한 번
    assert.match(r.out, /반경 500m: 약국이 있는 병원 1곳 \/ 평일 18시 이후 1곳 \/ 22시 이후 1곳 \/ 주말 1곳 \/ 공휴일 0곳 \(병원 2곳 중\)/);
    assert.match(r.out, /반경 1000m: 약국이 있는 병원 1곳 \/ 평일 18시 이후 1곳/);
    assert.match(r.out, /1km 안에 평일 18시 이후 약국이 없는 병원 1곳: 병원B/);
    assert.match(r.out, /첫 응답 필드: hpid, dutyName/);                                  // 실제 응답 모양을 확인할 수 있게 필드 이름을 출력한다
    assert.equal(r.out.includes("test-key-123"), false);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("인증키가 없으면 호출 없이 실패하고, 서비스 오류는 코드만 알리며 키를 출력하지 않는다", async () => {
  const { server, calls, port } = await fakeServer("error");
  const root = await setup();
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
