import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_PROMPTS, reportNote, reportTemplate } from "../src/lib/reportNote";

test("an untouched description sends nothing", () => {
  assert.equal(reportNote(reportTemplate()), "");
});

test("the problem from a notice is filled in and sent; empty prompts are left out", () => {
  const template = reportTemplate("整包下载失败：\n无法连接本地服务");
  assert.equal(template.split("\n")[1], `${REPORT_PROMPTS[1]}整包下载失败： 无法连接本地服务`);
  assert.equal(reportNote(template), `${REPORT_PROMPTS[1]}整包下载失败： 无法连接本地服务`);
});

test("what the user wrote stays as written, on its own lines too", () => {
  const written = `${REPORT_PROMPTS[0]}打开使用提示，点曲库\n${REPORT_PROMPTS[1]}\n窗口变成了出错页\n${REPORT_PROMPTS[2]}`;
  assert.equal(reportNote(written), `${REPORT_PROMPTS[0]}打开使用提示，点曲库\n窗口变成了出错页`);
  assert.equal(reportNote("随便写的一句话"), "随便写的一句话");
});
