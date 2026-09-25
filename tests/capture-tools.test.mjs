import assert from "node:assert/strict";
import test from "node:test";
import {
  backendFromInfo, crc32, encodeA1Namb, parseDeviceSlot, prepareCapture,
  selectA2Lite, uploadCapture, validateA1Namb, validateA1NanoRelu,
} from "../app/capture-tools.ts";

function validA1() {
  return {
    version: "0.5.2",
    metadata: { name: "Browser A1", loudness: -18.2 },
    architecture: "WaveNet",
    sample_rate: 48000,
    config: { head: null, head_scale: 0.02, layers: [
      { input_size: 1, condition_size: 1, head_size: 2, channels: 4, kernel_size: 3,
        dilations: [1, 2, 4, 8, 16, 32, 64], gated: false, head_bias: false, activation: "ReLU" },
      { input_size: 4, condition_size: 1, head_size: 1, channels: 2, kernel_size: 3,
        dilations: [128, 256, 512, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
        gated: false, head_bias: true, activation: { type: "ReLU" } },
    ] },
    weights: Array(842).fill(0).map((_, index) => index / 10000),
  };
}

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

function refreshNambCrc(payload) {
  const checksumInput = Uint8Array.from(payload.filter((_, index) => index < 24 || index >= 28));
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(24, crc32(checksumInput), true);
}

test("validates and encodes an A1 Nano-ReLU NAM in the browser", () => {
  const document = validA1();
  validateA1NanoRelu(document);
  const payload = encodeA1Namb(document);
  assert.equal(new TextDecoder().decode(payload.slice(0, 4)), "BMAN");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(view.getUint32(8, true), payload.length);
  assert.equal(view.getUint32(16, true), 842);
  assert.ok(payload.length < 64 * 1024);
  validateA1Namb(payload);
  const prepared = prepareCapture("a1_nano_relu", "download.nam", bytes(document));
  assert.equal(prepared.format, "a1_namb");
  assert.equal(prepared.name, "Browser A1");
  assert.deepEqual(prepared.payload, payload);
});

test("gives targeted A1 compatibility errors", () => {
  const tanh = validA1();
  tanh.config.layers[0].activation = "Tanh";
  assert.throws(() => validateA1NanoRelu(tanh), /uses Tanh.*Nano-ReLU/);
  const wrongRate = validA1();
  wrongRate.sample_rate = 44100;
  assert.throws(() => validateA1NanoRelu(wrongRate), /48 kHz/);
  assert.throws(() => prepareCapture("a1_nano_relu", "bad.namb", new Uint8Array([1, 2, 3, 4])), /not valid NAMB/);
  const corrupted = encodeA1Namb(validA1());
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => validateA1Namb(corrupted), /failed its checksum/);
  const wrongVersion = encodeA1Namb(validA1());
  wrongVersion[33] = 7;
  refreshNambCrc(wrongVersion);
  assert.throws(() => validateA1Namb(wrongVersion), /version .* not supported/);
});

test("searches all Tone3000 submodels and packs the compatible A2 weights", () => {
  const incompatible = structuredClone(validA2());
  incompatible.config.layers[0].channels = 8;
  const document = { architecture: "SlimmableContainer", metadata: { name: "Tone3000 multi-model" },
    config: { submodels: [{ model: incompatible }, { model: validA2() }] } };
  assert.equal(selectA2Lite(document).index, 1);
  const prepared = prepareCapture("a2_lite", "tone3000.nam", bytes(document));
  assert.equal(prepared.format, "a2_weights_f32");
  assert.equal(prepared.name, "Tone3000 multi-model");
  assert.equal(prepared.payload.length, 1871 * 4);
  assert.equal(new DataView(prepared.payload.buffer).getFloat32(4, true), 0.0010000000474974513);
});

test("explains why no A2 submodel can run", () => {
  const incompatible = validA2();
  incompatible.config.layers[0].channels = 8;
  assert.throws(() => prepareCapture("a2_lite", "too-large.nam", bytes({
    architecture: "SlimmableContainer", config: { submodels: [{ model: incompatible }] },
  })), /No device-compatible A2-Lite model found \(submodel 0: Expected 3-channel/);
});

test("discovers supported firmware and parses all slot states", () => {
  assert.equal(backendFromInfo(["INFO", "a1_nano_relu", "installed", "100", "12345678"]), "a1_nano_relu");
  assert.throws(() => backendFromInfo(["INFO", "future_backend"]), /unsupported firmware backend/);
  assert.deepEqual(parseDeviceSlot("A", ["SLOT", "A", "empty", "unknown", "0", "00000000", "-"]), { status: "empty" });
  assert.deepEqual(parseDeviceSlot("B", ["SLOT", "B", "invalid", "unknown", "0", "00000000", "-"]), { status: "invalid" });
  assert.deepEqual(parseDeviceSlot("C", ["SLOT", "C", "installed", "a2_weights_f32", "7484", "abcdef01", "416d70"]),
    { status: "installed", format: "a2_weights_f32", size: 7484, crc: "abcdef01", name: "Amp" });
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
  await assert.rejects(uploadCapture(request, "A", { format: "a1_namb", name: "Amp", payload: new Uint8Array(4) }),
    /unexpected transfer offset/);
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
    format: "a1_namb", name: "Amp", payload: new Uint8Array([1, 2, 3, 4]),
  }), /capture checksum/);
  assert.equal(commands.at(-1), "HNAM CANCEL");
});
