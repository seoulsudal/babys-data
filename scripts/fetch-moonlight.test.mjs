// 달빛어린이병원 수집 스크립트의 실제 흐름을 가짜 API 서버(127.0.0.1)로 검증한다 — 인증키·네트워크 없이, 임시 폴더에서.
// 아래 병원은 모두 검증용 가상 값이며 실제 병원이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "fetch-moonlight.mjs");

const hospital = (n, addr = "서울특별시 가나구 시험로 1", name = `가나 아동병원 ${n}`) =>
  `<item><hpid>A${n}</hpid><dutyName>${name}</dutyName><dutyDivNam>병원</dutyDivNam><dutyAddr>${addr}</dutyAddr><dutyTel1>02-000-000${n}</dutyTel1><wgs84Lat>37.5</wgs84Lat><wgs84Lon>127.0</wgs84Lon><dutyTime1s>0900</dutyTime1s><dutyTime1c>2300</dutyTime1c></item>`;

/** 가짜 API: pages 를 numOfRows 크기로 잘라 돌려준다. mode 로 오류·빈 응답을 흉내 낸다. */
function fakeServer(all, mode = "ok") {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    calls.push(url.pathname);
    res.setHeader("content-type", "application/xml");
    if (mode === "error") return res.end("<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnReasonCode>30</returnReasonCode><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>");
    if (!url.pathname.endsWith("/getBabyListInfoInqire")) { res.statusCode = 404; return res.end("not found"); }
    const rows = Number(url.searchParams.get("numOfRows")), page = Number(url.searchParams.get("pageNo"));
    const slice = mode === "empty" ? [] : all.slice((page - 1) * rows, page * rows);
    res.end(`<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header><body><items>${slice.join("")}</items><numOfRows>${rows}</numOfRows><pageNo>${page}</pageNo><totalCount>${mode === "empty" ? 0 : all.length}</totalCount></body></response>`);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, calls, port: server.address().port })));
}

async function setup(baselineCount) {
  const root = await mkdtemp(join(tmpdir(), "moonlight-"));
  await mkdir(join(root, "docs"), { recursive: true });
  if (baselineCount != null) {
    const items = Array.from({ length: baselineCount }, (_, i) => ({ id: `old-${i}`, name: `옛 ${i}` }));
    await writeFile(join(root, "docs/moonlight.json"), JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", items }));
  }
  return root;
}

function run(root, port, env = {}) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, MOONLIGHT_ROOT: root, DATA_GO_KR_API_KEY: "test-key-123", MOONLIGHT_API_BASE: `http://127.0.0.1:${port}`, MOONLIGHT_PAGE_SIZE: "2", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => ok({ code, out }));
  });
}

const readOut = async (root) => JSON.parse(await readFile(join(root, "docs/moonlight.json"), "utf8"));

test("정상 수집: 여러 쪽을 이어 받아 앱이 쓰는 모양으로 저장하고 시도·이름 순으로 정렬한다", async () => {
  const { server, calls, port } = await fakeServer([hospital(1, "경기도 다라시 시험로 2", "다 병원"), hospital(2), hospital(3, "서울특별시 가나구 시험로 1", "가 병원")]);
  const root = await setup(2);
  try {
    const r = await run(root, port);
    assert.equal(r.code, 0, r.out);
    const out = await readOut(root);
    assert.match(out.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(out.items.map((i) => i.sido), ["경기", "서울", "서울"]);          // 시도 이름순(가나다: 경기 < 서울)
    assert.deepEqual(out.items.filter((i) => i.sido === "서울").map((i) => i.name), ["가 병원", "가나 아동병원 2"]);   // 같은 시도에서는 이름순
    assert.equal(calls.length, 2);                                                       // 3건을 2건씩 → 2쪽
    assert.equal(out.items[0].hours[0], "0900-2300");
    assert.equal(JSON.stringify(out).includes("test-key-123"), false);                   // 인증키는 어디에도 남지 않는다
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("같은 결과가 다시 오면 파일을 건드리지 않는다(updatedAt 유지)", async () => {
  const { server, port } = await fakeServer([hospital(1), hospital(2)]);
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

test("0건이면 실패하고 기존 파일을 덮어쓰지 않는다", async () => {
  const { server, port } = await fakeServer([], "empty");
  const root = await setup(5);
  try {
    const r = await run(root, port);
    assert.notEqual(r.code, 0);
    assert.equal((await readOut(root)).items.length, 5);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("지금 게시된 건수의 절반 미만이면 실패한다", async () => {
  const { server, port } = await fakeServer([hospital(1), hospital(2)]);
  const root = await setup(10);
  try {
    const r = await run(root, port);
    assert.notEqual(r.code, 0);
    assert.equal((await readOut(root)).items.length, 10);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("인증키가 없으면 호출 없이 실패하고, 서비스 오류 응답은 코드만 알리며 키를 출력하지 않는다", async () => {
  const { server, calls, port } = await fakeServer([hospital(1)], "error");
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
