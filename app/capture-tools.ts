export const A1_LIMIT = 64 * 1024;
export const A1_WEIGHT_COUNT = 842;
export const A2_WEIGHT_COUNT = 1871;
export const CHUNK_SIZE = 128;

export type Backend = "a1_nano_relu" | "a2_lite";

export type PreparedCapture = {
  format: "a1_namb" | "a2_weights_f32";
  name: string;
  payload: Uint8Array;
};

type JsonObject = Record<string, unknown>;

const A1_LAYERS = [
  {
    input_size: 1, condition_size: 1, head_size: 2, channels: 4,
    kernel_size: 3, dilations: [1, 2, 4, 8, 16, 32, 64],
    gated: false, head_bias: false,
  },
  {
    input_size: 4, condition_size: 1, head_size: 1, channels: 2,
    kernel_size: 3,
    dilations: [128, 256, 512, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512],
    gated: false, head_bias: true,
  },
] as const;

const A2_KERNEL_SIZES = [...Array(14).fill(6), 15, 15, ...Array(7).fill(6)];
const A2_DILATIONS = [
  1, 3, 7, 17, 41, 101, 239,
  1, 3, 7, 17, 41, 101, 239,
  1, 13,
  1, 3, 7, 17, 41, 101, 239,
];

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireCapture(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function finiteNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isSupportedBackend(value: string): value is Backend {
  return value === "a1_nano_relu" || value === "a2_lite";
}

export function backendLabel(backend: Backend) {
  return backend === "a1_nano_relu" ? "A1 Nano-ReLU" : "A2-Lite";
}

export function captureName(fileName: string, document?: JsonObject) {
  const metadata = object(document?.metadata);
  const raw = metadata?.name ?? fileName.replace(/\.[^.]+$/, "");
  const printable = String(raw).replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return printable.slice(0, 63) || "Unnamed capture";
}

export function validateA1NanoRelu(document: JsonObject) {
  requireCapture(document.architecture === "WaveNet", "This is not an A1 WaveNet capture.");
  requireCapture(finiteNumber(document.sample_rate) === 48000, "A1 captures must be trained at 48 kHz.");
  const config = object(document.config);
  const layers = config?.layers;
  requireCapture(Array.isArray(layers) && layers.length === 2,
    "This A1 capture is not the supported two-stack Nano topology.");

  layers.forEach((value, index) => {
    const layer = object(value);
    const expected = A1_LAYERS[index];
    requireCapture(layer !== null && Object.entries(expected).every(([key, expectedValue]) => same(layer[key], expectedValue)),
      `A1 layer stack ${index} does not match the device-safe Nano topology.`);
    const activation = object(layer.activation)?.type ?? layer.activation;
    requireCapture(activation === "ReLU",
      "This is a Nano capture, but it uses Tanh. This A1 pedal supports Nano-ReLU captures.");
  });

  const weights = document.weights;
  const count = Array.isArray(weights) ? weights.length : 0;
  requireCapture(Array.isArray(weights) && count === A1_WEIGHT_COUNT,
    `This A1 capture has ${count.toLocaleString("en-US")} weights; the device-safe topology has ${A1_WEIGHT_COUNT.toLocaleString("en-US")}.`);
  requireCapture(weights.every((weight) => finiteNumber(weight) !== null),
    "A1 capture weights must all be finite numbers.");

  const version = String(document.version ?? "").split(".").map(Number);
  requireCapture(version.length >= 2 && version[0] === 0 && (version[1] === 5 || (version[1] === 6 && (version[2] ?? 0) === 0)),
    `A1 capture version ${String(document.version ?? "unknown")} is not supported by this firmware.`);
}

class BinaryWriter {
  private bytes: number[] = [];
  get length() { return this.bytes.length; }
  u8(value: number) { this.bytes.push(value & 0xff); }
  u16(value: number) { this.u8(value); this.u8(value >>> 8); }
  u32(value: number) { this.u16(value); this.u16(value >>> 16); }
  i32(value: number) { this.u32(value >>> 0); }
  f32(value: number) {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true);
    this.raw(new Uint8Array(buffer));
  }
  f64(value: number) {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, true);
    this.raw(new Uint8Array(buffer));
  }
  zeros(count: number) { for (let index = 0; index < count; index += 1) this.u8(0); }
  raw(values: Uint8Array) { this.bytes.push(...values); }
  setU16(offset: number, value: number) {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >>> 8) & 0xff;
  }
  setU32(offset: number, value: number) {
    this.setU16(offset, value);
    this.setU16(offset + 2, value >>> 16);
  }
  output() { return Uint8Array.from(this.bytes); }
}

function writeMetadata(writer: BinaryWriter, document: JsonObject) {
  const version = String(document.version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const metadata = object(document.metadata);
  let flags = 0;
  if (finiteNumber(metadata?.loudness) !== null) flags |= 1;
  if (finiteNumber(metadata?.input_level_dbu) !== null) flags |= 2;
  if (finiteNumber(metadata?.output_level_dbu) !== null) flags |= 4;
  writer.u8(version[0] ?? 0); writer.u8(version[1] ?? 0); writer.u8(version[2] ?? 0); writer.u8(flags);
  writer.f64(finiteNumber(document.sample_rate) ?? -1);
  writer.f64(finiteNumber(metadata?.loudness) ?? 0);
  writer.f64(finiteNumber(metadata?.input_level_dbu) ?? 0);
  writer.f64(finiteNumber(metadata?.output_level_dbu) ?? 0);
  writer.zeros(12);
}

function writeInactiveFilm(writer: BinaryWriter) {
  writer.u8(0); writer.u8(0); writer.u16(1);
}

function writeA1WaveNetModel(writer: BinaryWriter, document: JsonObject) {
  const config = object(document.config)!;
  const layers = config.layers as JsonObject[];
  writer.u8(3); // WaveNet
  writer.u8(0);
  const sizeOffset = writer.length;
  writer.u16(0);
  const start = writer.length;
  writer.u8((finiteNumber(config.in_channels) ?? 1));
  writer.u8(config.head === null || config.head === undefined ? 0 : 1);
  writer.u8(layers.length);
  writer.u8(0); // no condition DSP in the supported A1 topology
  for (const layer of layers) {
    const dilations = layer.dilations as number[];
    const channels = finiteNumber(layer.channels)!;
    writer.u16(finiteNumber(layer.input_size)!);
    writer.u16(finiteNumber(layer.condition_size)!);
    writer.u16(finiteNumber(layer.head_size)!);
    writer.u16(channels);
    writer.u16(finiteNumber(layer.bottleneck) ?? channels);
    writer.u16(finiteNumber(layer.kernel_size)!);
    writer.u8(layer.head_bias === true ? 1 : 0);
    writer.u8(dilations.length);
    writer.u16(finiteNumber(layer.groups_input) ?? 1);
    writer.u16(finiteNumber(layer.groups_input_mixin) ?? 1);
    const layer1x1 = object(layer.layer1x1);
    writer.u8(layer1x1?.active === false ? 0 : 1);
    writer.u16(finiteNumber(layer1x1?.groups) ?? 1);
    writer.u8(0);
    const head1x1 = object(layer.head1x1);
    writer.u8(head1x1?.active === true ? 1 : 0);
    writer.u16(finiteNumber(head1x1?.out_channels) ?? channels);
    writer.u16(finiteNumber(head1x1?.groups) ?? 1);
    writer.u8(0);
    for (let index = 0; index < 8; index += 1) writeInactiveFilm(writer);
    dilations.forEach((dilation) => writer.i32(dilation));
    dilations.forEach(() => { writer.u8(3); writer.u8(0); }); // ReLU
    dilations.forEach(() => writer.u8(0)); // no gating
    dilations.forEach(() => { writer.u8(0); writer.u8(0); }); // unused secondary activation
  }
  writer.setU16(sizeOffset, writer.length - start);
}

function nambFileCrc(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    if (index >= 24 && index < 28) continue;
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class BinaryReader {
  private offset = 0;
  private readonly view: DataView;
  private readonly end: number;
  constructor(view: DataView, end = view.byteLength) {
    this.view = view;
    this.end = end;
  }
  get position() { return this.offset; }
  private take(size: number) {
    requireCapture(this.offset + size <= this.end, "This .namb file is truncated.");
    const position = this.offset;
    this.offset += size;
    return position;
  }
  u8() { return this.view.getUint8(this.take(1)); }
  u16() { return this.view.getUint16(this.take(2), true); }
  u32() { return this.view.getUint32(this.take(4), true); }
  i32() { return this.view.getInt32(this.take(4), true); }
  skip(size: number) { this.take(size); }
}

function readA1Layer(reader: BinaryReader, expected: typeof A1_LAYERS[number]) {
  const channels = reader.u16();
  const values = {
    input_size: channels,
    condition_size: reader.u16(),
    head_size: reader.u16(),
    channels: reader.u16(),
    bottleneck: reader.u16(),
    kernel_size: reader.u16(),
  };
  requireCapture(values.input_size === expected.input_size
    && values.condition_size === expected.condition_size
    && values.head_size === expected.head_size
    && values.channels === expected.channels
    && values.bottleneck === expected.channels
    && values.kernel_size === expected.kernel_size,
  "This .namb file does not contain the device-safe A1 Nano topology.");
  requireCapture(reader.u8() === (expected.head_bias ? 1 : 0),
    "This .namb file has an unsupported A1 head configuration.");
  const dilationCount = reader.u8();
  requireCapture(dilationCount === expected.dilations.length && reader.u16() === 1 && reader.u16() === 1,
    "This .namb file has an unsupported A1 layer layout.");
  requireCapture(reader.u8() === 1 && reader.u16() === 1, "This .namb file has an unsupported layer1x1 layout.");
  reader.skip(1);
  requireCapture(reader.u8() === 0 && reader.u16() === expected.channels && reader.u16() === 1,
    "This .namb file has an unsupported head1x1 layout.");
  reader.skip(1);
  for (let index = 0; index < 8; index += 1) {
    requireCapture(reader.u8() === 0, "This .namb file uses unsupported FiLM layers.");
    reader.skip(1);
    requireCapture(reader.u16() === 1, "This .namb file uses unsupported FiLM groups.");
  }
  for (const dilation of expected.dilations) {
    requireCapture(reader.i32() === dilation, "This .namb file has an unsupported A1 dilation layout.");
  }
  for (let index = 0; index < dilationCount; index += 1) {
    requireCapture(reader.u8() === 3 && reader.u8() === 0,
      "This .namb file is not a Nano-ReLU capture.");
  }
  for (let index = 0; index < dilationCount; index += 1) {
    requireCapture(reader.u8() === 0, "This .namb file uses unsupported gating.");
  }
  for (let index = 0; index < dilationCount; index += 1) {
    reader.skip(2); // ignored identity activation for an ungated layer
  }
}

export function validateA1Namb(bytes: Uint8Array) {
  requireCapture(bytes.length >= 80 && new TextDecoder().decode(bytes.slice(0, 4)) === "BMAN",
    "This .namb file is not valid NAMB data.");
  requireCapture(bytes.length <= A1_LIMIT,
    `The A1 binary is ${bytes.length.toLocaleString("en-US")} bytes; the runtime limit is ${A1_LIMIT.toLocaleString("en-US")} bytes.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireCapture(view.getUint16(4, true) === 1, "This .namb file uses an unsupported binary format version.");
  const totalSize = view.getUint32(8, true);
  const weightsOffset = view.getUint32(12, true);
  const weightCount = view.getUint32(16, true);
  const modelSize = view.getUint32(20, true);
  requireCapture(totalSize === bytes.length && weightCount === A1_WEIGHT_COUNT
    && weightsOffset % 4 === 0 && weightsOffset + weightCount * 4 === totalSize
    && modelSize <= weightsOffset - 80,
  "This .namb file has an invalid or unsupported weight layout.");
  requireCapture(view.getUint32(24, true) === nambFileCrc(bytes),
    "This .namb file failed its checksum; download it again.");
  const major = view.getUint8(32), minor = view.getUint8(33), patch = view.getUint8(34);
  requireCapture(major === 0 && (minor === 5 || (minor === 6 && patch === 0)),
    `A1 capture version ${major}.${minor}.${patch} is not supported by this firmware.`);
  requireCapture(view.getFloat64(36, true) === 48000,
    "A1 captures must be trained at 48 kHz.");
  const reader = new BinaryReader(new DataView(bytes.buffer, bytes.byteOffset + 80, modelSize), modelSize);
  requireCapture(reader.u8() === 3, "This .namb file is not an A1 WaveNet capture.");
  reader.skip(1);
  const configSize = reader.u16();
  requireCapture(configSize + 4 === modelSize, "This .namb file has an invalid model block.");
  requireCapture(reader.u8() === 1 && reader.u8() === 0 && reader.u8() === 2 && reader.u8() === 0,
    "This .namb file does not contain the device-safe two-stack A1 topology.");
  readA1Layer(reader, A1_LAYERS[0]);
  readA1Layer(reader, A1_LAYERS[1]);
  requireCapture(reader.position === modelSize, "This .namb file has unexpected model data.");
}

export function encodeA1Namb(document: JsonObject) {
  validateA1NanoRelu(document);
  const writer = new BinaryWriter();
  writer.u32(0x4e414d42); // bytes on disk are BMAN
  writer.u16(1); writer.u16(0);
  writer.u32(0); writer.u32(0); writer.u32(0); writer.u32(0); writer.u32(0); writer.u32(0);
  writeMetadata(writer, document);
  const modelStart = writer.length;
  writeA1WaveNetModel(writer, document);
  const modelSize = writer.length - modelStart;
  while (writer.length % 4) writer.u8(0);
  const weightsOffset = writer.length;
  const weights = document.weights as unknown[];
  weights.forEach((weight) => writer.f32(finiteNumber(weight)!));
  writer.setU32(8, writer.length);
  writer.setU32(12, weightsOffset);
  writer.setU32(16, weights.length);
  writer.setU32(20, modelSize);
  const output = writer.output();
  writer.setU32(24, nambFileCrc(output));
  const finalized = writer.output();
  requireCapture(finalized.length <= A1_LIMIT,
    `The A1 binary is ${finalized.length.toLocaleString("en-US")} bytes; the runtime limit is ${A1_LIMIT.toLocaleString("en-US")} bytes.`);
  return finalized;
}

function inactiveFilm(value: unknown) {
  return object(value)?.active === false;
}

export function validateA2Lite(model: JsonObject) {
  requireCapture(model.architecture === "WaveNet", "A2-Lite submodel must be WaveNet");
  requireCapture(finiteNumber(model.sample_rate) === 48000, "A2-Lite model must be 48 kHz");
  const layers = object(model.config)?.layers;
  requireCapture(Array.isArray(layers) && layers.length === 1, "Expected one WaveNet layer stack");
  const config = object(layers[0]);
  requireCapture(config !== null, "Expected one WaveNet layer stack");
  requireCapture(config.input_size === 1, "Expected input_size=1");
  requireCapture(config.condition_size === 1, "Expected condition_size=1");
  requireCapture(config.channels === 3, "Expected 3-channel A2-Lite model");
  requireCapture(config.bottleneck === 3, "Expected bottleneck=3");
  requireCapture(same(config.kernel_sizes, A2_KERNEL_SIZES), "Unsupported A2 kernel layout");
  requireCapture(same(config.dilations, A2_DILATIONS), "Unsupported A2 dilation layout");
  const head = object(config.head);
  requireCapture(head?.out_channels === 1 && head.kernel_size === 16 && head.bias === true,
    "Expected a biased 16-tap mono head");
  requireCapture(same(config.layer1x1, { active: true, groups: 1 }), "Unsupported layer1x1");
  requireCapture(object(config.head1x1)?.active === false, "head1x1 must be inactive");
  requireCapture(config.groups_input === 1, "groups_input must be 1");
  requireCapture(config.groups_input_mixin === 1, "groups_input_mixin must be 1");
  const activations = config.activation;
  requireCapture(Array.isArray(activations) && activations.length === 23, "Expected 23 activations");
  requireCapture(activations.every((value) => {
    const activation = object(value);
    return activation?.type === "LeakyReLU" && finiteNumber(activation.negative_slope) === 0.01;
  }), "A2-Lite runtime requires LeakyReLU with slope 0.01");
  requireCapture(same(config.gating_mode, Array(23).fill("none")), "Gating is unsupported");
  requireCapture(same(config.secondary_activation, Array(23).fill(null)), "Secondary activations are unsupported");
  const filmKeys = ["conv_pre_film", "conv_post_film", "input_mixin_pre_film", "input_mixin_post_film",
    "activation_pre_film", "activation_post_film", "layer1x1_post_film", "head1x1_post_film"];
  requireCapture(filmKeys.every((key) => inactiveFilm(config[key])), "FiLM layers are unsupported");
  const weights = model.weights;
  requireCapture(Array.isArray(weights) && weights.length === A2_WEIGHT_COUNT,
    `Expected exactly ${A2_WEIGHT_COUNT} A2-Lite weights`);
  const values = weights.map(finiteNumber);
  requireCapture(values.every((value) => value !== null), "Weights must all be finite");
  return values as number[];
}

export function selectA2Lite(document: JsonObject) {
  let candidates: Array<[JsonObject, number]>;
  if (document.architecture === "SlimmableContainer") {
    const submodels = object(document.config)?.submodels;
    requireCapture(Array.isArray(submodels) && submodels.length > 0, "SlimmableContainer has no submodels");
    candidates = submodels.flatMap((value, index) => {
      const model = object(object(value)?.model);
      return model ? [[model, index] as [JsonObject, number]] : [];
    });
    requireCapture(candidates.length > 0, "SlimmableContainer has no readable submodels");
  } else candidates = [[document, -1]];
  const failures: string[] = [];
  for (const [model, index] of candidates) {
    try { return { model, index, weights: validateA2Lite(model) }; }
    catch (error) { failures.push(`${index < 0 ? "model" : `submodel ${index}`}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(`No device-compatible A2-Lite model found (${failures.join("; ")})`);
}

function parseNam(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const document = object(value);
    requireCapture(document !== null, "the NAM root must be an object");
    return document;
  } catch (error) {
    throw new Error(`Invalid NAM file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function prepareCapture(backend: Backend, fileName: string, bytes: Uint8Array): PreparedCapture {
  const suffix = fileName.toLowerCase().split(".").pop();
  if (backend === "a1_nano_relu") {
    if (suffix === "namb") {
      validateA1Namb(bytes);
      return { format: "a1_namb", name: captureName(fileName), payload: bytes };
    }
    requireCapture(suffix === "nam", "A1 firmware accepts .nam or .namb files.");
    const document = parseNam(bytes);
    return { format: "a1_namb", name: captureName(fileName, document), payload: encodeA1Namb(document) };
  }
  requireCapture(suffix === "nam", "A2-Lite firmware accepts .nam files.");
  const document = parseNam(bytes);
  let selected: ReturnType<typeof selectA2Lite>;
  try { selected = selectA2Lite(document); }
  catch (error) { throw new Error(`Incompatible A2-Lite capture: ${error instanceof Error ? error.message : String(error)}`); }
  const buffer = new ArrayBuffer(selected.weights.length * 4);
  const view = new DataView(buffer);
  selected.weights.forEach((weight, index) => view.setFloat32(index * 4, weight, true));
  return { format: "a2_weights_f32", name: captureName(fileName, document), payload: new Uint8Array(buffer) };
}

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ProtocolRequest = (command: string, timeout?: number) => Promise<string[]>;

export function decodeNameHex(value: string) {
  requireCapture(Boolean(value) && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value),
    "Pedal returned an invalid capture name");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  requireCapture([...name].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0x20 && code <= 0x7e;
  }), "Pedal returned an invalid capture name");
  return name;
}

export function backendFromInfo(fields: string[]) {
  requireCapture(fields[0] === "INFO" && Boolean(fields[1]), "This is not a Hothouse NAM pedal");
  requireCapture(isSupportedBackend(fields[1]),
    `This pedal reports unsupported firmware backend “${fields[1]}”. Update the editor or pedal firmware before loading captures.`);
  return fields[1];
}

export type ParsedDeviceSlot =
  | { status: "empty" | "invalid" }
  | { status: "installed"; name: string; size: number; format: string; crc: string };

export function parseDeviceSlot(slot: "A" | "B" | "C", fields: string[]): ParsedDeviceSlot {
  requireCapture(fields[0] === "SLOT" && fields[1] === slot
    && ["installed", "empty", "invalid"].includes(fields[2]),
  `Pedal returned invalid metadata for slot ${slot}`);
  if (fields[2] !== "installed") return { status: fields[2] as "empty" | "invalid" };
  requireCapture(fields.length >= 7, `Pedal returned incomplete metadata for slot ${slot}`);
  const size = Number(fields[4]);
  requireCapture(Number.isSafeInteger(size) && size > 0 && /^[0-9a-f]{8}$/i.test(fields[5]),
    `Pedal returned invalid metadata for slot ${slot}`);
  return { status: "installed", format: fields[3], size, crc: fields[5], name: decodeNameHex(fields[6]) };
}

export async function uploadCapture(
  request: ProtocolRequest,
  slot: "A" | "B" | "C",
  capture: PreparedCapture,
  onProgress?: (percent: number) => void,
) {
  const checksum = crc32(capture.payload).toString(16).padStart(8, "0");
  const encodedName = hex(new TextEncoder().encode(capture.name));
  try {
    const begin = await request(`HNAM BEGIN ${slot} ${capture.format} ${capture.payload.length} ${checksum} ${encodedName}`, 20000);
    requireCapture(begin[0] === "BEGIN" && Number(begin[1]) === 0,
      "Pedal did not confirm the capture transfer");
    for (let offset = 0; offset < capture.payload.length; offset += CHUNK_SIZE) {
      const chunk = capture.payload.slice(offset, offset + CHUNK_SIZE);
      const response = await request(`HNAM DATA ${offset} ${hex(chunk)}`, 5000);
      const expected = offset + chunk.length;
      requireCapture(response[0] === "DATA" && Number(response[1]) === expected,
        "Pedal acknowledged an unexpected transfer offset");
      onProgress?.(Math.round((expected / capture.payload.length) * 100));
    }
    const response = await request("HNAM COMMIT", 15000);
    requireCapture(response[0] === "COMMIT" && response[1]?.toLowerCase() === checksum,
      "Pedal did not confirm the capture checksum");
  } catch (error) {
    try { await request("HNAM CANCEL", 2000); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return checksum;
}
