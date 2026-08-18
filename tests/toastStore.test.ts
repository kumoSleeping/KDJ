import assert from "node:assert/strict";
import test from "node:test";
import { useToastStore } from "../src/stores/toastStore";

test("toast store replaces the current message and can retrigger the same text", () => {
  useToastStore.setState({ text: "", token: 0 });
  useToastStore.getState().show("STEM 仅支持本机曲库文件");
  assert.equal(useToastStore.getState().text, "STEM 仅支持本机曲库文件");
  const token = useToastStore.getState().token;
  useToastStore.getState().show("STEM 仅支持本机曲库文件");
  assert.ok(useToastStore.getState().token > token);
  useToastStore.getState().dismiss();
  assert.equal(useToastStore.getState().text, "");
});

test("blank toast text dismisses instead of flashing an empty card", () => {
  useToastStore.setState({ text: "上一句", token: 1 });
  useToastStore.getState().show("   ");
  assert.equal(useToastStore.getState().text, "");
});
