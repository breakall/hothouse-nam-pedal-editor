import assert from "node:assert/strict";
import test from "node:test";
import {
  backendFromInfo, crc32, parseDeviceSlot, prepareCapture,
  selectA2Lite, uploadCapture,
} from "../app/capture-tools.ts";

const kernelSizes = [...Array(14).fill(6), 15, 15, ...Array(7).fill(6)];
const dilations = [1, 3, 7, 17, 41, 101, 239, 1, 3, 7, 17, 41, 101, 239, 1, 13, 1, 3, 7, 17, 41, 101, 239];

function validA2() {
  const inactive = { active: false };
  return {
    architecture: "WaveNet", sample_rate: 48000,
    config: { layers: [{
      input_size: 1, condition_size: 1, channels: 3, bottleneck: 3,
      kernel_sizes: kernelSizes, dilations,
      head: { out_channels: 1, kernel_size: 16, bias: true },
      layer1x1: { active: true, groups: 1 }, head1x1: { active: false },
      groups_input: 1, groups_input_mixin: 1,
      activation: Array(23).fill(null).map(() => ({ type: "LeakyReLU", negative_slope: 0.01 })),
      gating_mode: Array(23).fill("none"), secondary_activation: Array(23).fill(null),
      conv_pre_film: inactive, conv_post_film: inactive,
      input_mixin_pre_film: inactive, input_mixin_post_film: inactive,
      activation_pre_film: inactive, activation_post_film: inactive,
      layer1x1_post_film: inactive, head1x1_post_film: inactive,
    }] },
    weights: Array(1871).fill(0).map((_, index) => index / 1000),
  };
}

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));

test("searches every Tone3000 submodel and packs compatible weights", () => {
  const incompatible = structuredClone(validA2());
  incompatible.config.layers[0].channels = 8;
  const document = {
    architecture: "SlimmableContainer",
    metadata: { name: "Tone3000 multi-model" },
    config: { submodels: [{ model: incompatible }, { model: validA2() }] },
  };
  assert.equal(selectA2Lite(document).index, 1);
  const prepared = prepareCapture("a2_lite", "tone3000.nam", bytes(document));
  assert.equal(prepared.format, "a2_weights_f32");
  assert.equal(prepared.name, "Tone3000 multi-model");
  assert.equal(prepared.payload.length, 1871 * 4);
  assert.equal(new DataView(prepared.payload.buffer).getFloat32(4, true), 0.0010000000474974513);
});

test("gives friendly file and compatibility errors", () => {
  assert.throws(
    () => prepareCapture("a2_lite", "capture.bin", new Uint8Array([1, 2, 3, 4])),
    /Choose a Tone3000 \.nam download containing an A2-Lite model/,
  );
  assert.throws(
    () => prepareCapture("a2_lite", "broken.nam", new TextEncoder().encode("not json")),
    /Invalid NAM file/,
  );
  const incompatible = validA2();
  incompatible.config.layers[0].channels = 8;
  assert.throws(() => prepareCapture("a2_lite", "too-large.nam", bytes({
    architecture: "SlimmableContainer", config: { submodels: [{ model: incompatible }] },
  })), /This capture cannot run on the pedal.*No device-compatible A2-Lite model found.*submodel 0: expected 3-channel/s);
});

test("accepts only current firmware and validates slot metadata", () => {
  assert.equal(backendFromInfo(["INFO", "a2_lite", "empty", "0", "00000000"]), "a2_lite");
  assert.throws(() => backendFromInfo(["INFO", "outdated_backend"]), /incompatible firmware.*latest Hothouse firmware/);
  assert.deepEqual(parseDeviceSlot("A", ["SLOT", "A", "empty", "unknown", "0", "00000000", "-"]), { status: "empty" });
  assert.deepEqual(parseDeviceSlot("B", ["SLOT", "B", "invalid", "unknown", "0", "00000000", "-"]), { status: "invalid" });
  assert.deepEqual(parseDeviceSlot("C", ["SLOT", "C", "installed", "a2_weights_f32", "7484", "abcdef01", "416d70"]),
    { status: "installed", format: "a2_weights_f32", size: 7484, crc: "abcdef01", name: "Amp" });
  assert.throws(
    () => parseDeviceSlot("C", ["SLOT", "C", "installed", "unknown", "7484", "abcdef01", "416d70"]),
    /invalid metadata/,
  );
});

test("uploads in 128-byte chunks, verifies offsets, and commits", async () => {
  const commands = [];
  const payload = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);
  const request = async (command) => {
    commands.push(command);
    if (command.startsWith("HNAM BEGIN")) return ["BEGIN", "0"];
    if (command.startsWith("HNAM DATA")) {
      const [, , offset, encoded] = command.split(" ");
      return ["DATA", String(Number(offset) + encoded.length / 2)];
    }
    if (command === "HNAM COMMIT") return ["COMMIT", crc32(payload).toString(16).padStart(8, "0")];
    throw new Error(command);
  };
  const progress = [];
  const checksum = await uploadCapture(request, "B", { format: "a2_weights_f32", name: "Amp", payload }, (value) => progress.push(value));
  assert.equal(checksum, crc32(payload).toString(16).padStart(8, "0"));
  assert.equal(commands.filter((command) => command.startsWith("HNAM DATA")).length, 3);
  assert.deepEqual(progress, [43, 85, 100]);
  assert.equal(commands.at(-1), "HNAM COMMIT");
});

test("cancels a transfer when the pedal acknowledges the wrong offset", async () => {
  const commands = [];
  const request = async (command) => {
    commands.push(command);
    if (command.startsWith("HNAM BEGIN")) return ["BEGIN", "0"];
    if (command.startsWith("HNAM DATA")) return ["DATA", "1"];
    if (command === "HNAM CANCEL") return ["CANCEL"];
    throw new Error(command);
  };
  await assert.rejects(uploadCapture(request, "A", {
    format: "a2_weights_f32", name: "Amp", payload: new Uint8Array(4),
  }), /unexpected transfer offset/);
  assert.equal(commands.at(-1), "HNAM CANCEL");
});

test("cancels a transfer when the committed checksum does not match", async () => {
  const commands = [];
  const request = async (command) => {
    commands.push(command);
    if (command.startsWith("HNAM BEGIN")) return ["BEGIN", "0"];
    if (command.startsWith("HNAM DATA")) return ["DATA", "4"];
    if (command === "HNAM COMMIT") return ["COMMIT", "00000000"];
    if (command === "HNAM CANCEL") return ["CANCEL"];
    throw new Error(command);
  };
  await assert.rejects(uploadCapture(request, "C", {
    format: "a2_weights_f32", name: "Amp", payload: new Uint8Array([1, 2, 3, 4]),
  }), /capture checksum/);
  assert.equal(commands.at(-1), "HNAM CANCEL");
});
