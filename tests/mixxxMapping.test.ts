import assert from "node:assert/strict";
import test from "node:test";
import { mappingMatchesDevice, mixxxControlTarget, parseMixxxMapping } from "../src/lib/mixxxMapping";

const XML = `
<MixxxControllerPreset>
  <info>
    <name>Kontrol Test</name>
    <author>KDJ</author>
    <devices><product protocol="hid" vendor_id="0x17cc" product_id="0x1310" interface_number="0x4" /></devices>
  </info>
  <controller id="Test"><scriptfiles><file filename="">Kontrol Test.js</file></scriptfiles>
    <controls><control><group>[Channel1]</group><key>hotcue_8_activate</key><status>0x90</status><midino>0x2f</midino><options><normal/></options></control></controls>
  </controller>
</MixxxControllerPreset>`;

test("Mixxx XML exposes device IDs, scripts, and direct controls without executing JS", () => {
  const parsed = parseMixxxMapping(XML);
  assert.equal(parsed.name, "Kontrol Test");
  assert.deepEqual(parsed.devices[0], {
    protocol: "hid",
    vendorId: 0x17cc,
    productId: 0x1310,
    usagePage: null,
    usage: null,
    interfaceNumber: 4,
  });
  assert.deepEqual(parsed.scripts, ["Kontrol Test.js"]);
  assert.equal(parsed.controls[0].midino, 0x2f);
  assert.equal(mappingMatchesDevice(parsed, parsed.devices[0]), true);
});

test("supported Mixxx controls translate to stable KDJ performance targets", () => {
  assert.deepEqual(mixxxControlTarget("[Channel1]", "play"), { kind: "deck-play", deck: 0 });
  assert.deepEqual(mixxxControlTarget("[Channel2]", "filterMid"), { kind: "deck-mid", deck: 1 });
  assert.deepEqual(mixxxControlTarget("[Channel1]", "hotcue_8_activate"), { kind: "deck-hot-cue", deck: 0, slot: 8 });
  assert.deepEqual(mixxxControlTarget("[Master]", "crossfader"), { kind: "crossfader" });
  assert.deepEqual(mixxxControlTarget("[Master]", "crossfader_enable"), { kind: "crossfader-enable" });
  assert.equal(mixxxControlTarget("[Channel3]", "play"), null);
});
