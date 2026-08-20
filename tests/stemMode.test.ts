import assert from "node:assert/strict";
import test from "node:test";

import {
  allStemMask,
  stemModeLabel,
  stemModeLaneKind,
  stemModeUsesFourLanes,
  stemModeUsesTwoLanes,
  stemModelStatusLabel,
} from "../src/lib/stemMode";

test("lane helpers expose ByteDance MobileNet as the only two-stem mode", () => {
  assert.equal(stemModeUsesFourLanes("four"), true);
  assert.equal(stemModeUsesTwoLanes("mobile_net_two"), true);
  assert.equal(stemModeLaneKind("mobile_net_two"), "two");
  assert.equal(allStemMask("mobile_net_two"), 0b1100);
  assert.equal(allStemMask("four"), 0b1111);
});

test("chrome and status labels name the locked test models", () => {
  assert.equal(stemModeLabel("none"), "无");
  assert.equal(stemModeLabel("four"), "Spleeter-4-FP16");
  assert.equal(stemModeLabel("mobile_net_two"), "ByteDance-MobileNet-2-FP32");
  assert.equal(stemModelStatusLabel("spleeter4-fp16-onnx"), "Spleeter-4-FP16");
  assert.equal(
    stemModelStatusLabel("bytedance-mobilenet-subbandtime-2-fp32-onnx"),
    "ByteDance-MobileNet-2-FP32",
  );
});
