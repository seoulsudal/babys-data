// 워크플로 파일의 정적 검사: 수집 작업들이 같은 시각(UTC 15시대)에 거의 동시에 돌아 같은 브랜치에 올리므로,
// 먼저 올린 쪽이 있으면 나중 쪽의 `git push`가 거절된다(2026-11-12 나들이 수집이 이렇게 실패했다).
// 올리기 전에 `git pull --rebase` 로 이어 붙이는 줄이 있어야 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/workflows");

test("git push 를 하는 워크플로는 올리기 전에 git pull --rebase 로 이어 붙인다", async () => {
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".yml"));
  const pushing = [];
  for (const f of files) {
    const lines = (await readFile(join(DIR, f), "utf8")).split(/\r?\n/);
    const push = lines.findIndex((l) => /^\s*git push\b/.test(l));
    if (push < 0) continue;
    pushing.push(f);
    const rebase = lines.findIndex((l) => /^\s*git pull --rebase origin main\b/.test(l));
    assert.ok(rebase >= 0 && rebase < push, `${f}: git push 앞에 git pull --rebase origin main 이 없다`);
  }
  assert.ok(pushing.length >= 4, `push 하는 워크플로를 ${pushing.length}개만 찾았다(검사가 헛돌고 있다)`);
});
