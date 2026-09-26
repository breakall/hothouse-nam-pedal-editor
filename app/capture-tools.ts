export const A2_WEIGHT_COUNT = 1871;
export const CHUNK_SIZE = 128;

export type Backend = "a2_lite";

export type PreparedCapture = {
  format: "a2_weights_f32";
  name: string;
  payload: Uint8Array;
  loudnessMillidb: number | null;
};

type JsonObject = Record<string, unknown>;

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
  return value === "a2_lite";
}

export function captureName(fileName: string, document?: JsonObject) {
  const metadata = object(document?.metadata);
  const raw = metadata?.name ?? fileName.replace(/\.[^.]+$/, "");
  const printable = String(raw).replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return printable.slice(0, 63) || "Unnamed capture";
}

function inactiveFilm(value: unknown) {
  return object(value)?.active === false;
}

export function validateA2Lite(model: JsonObject) {
  requireCapture(model.architecture === "WaveNet", "submodel must be WaveNet");
  requireCapture(finiteNumber(model.sample_rate) === 48000, "model must be 48 kHz");
  const layers = object(model.config)?.layers;
  requireCapture(Array.isArray(layers) && layers.length === 1, "expected one WaveNet layer stack");
  const config = object(layers[0]);
  requireCapture(config !== null, "expected one WaveNet layer stack");
  requireCapture(config.input_size === 1, "expected input_size=1");
  requireCapture(config.condition_size === 1, "expected condition_size=1");
  requireCapture(config.channels === 3, "expected 3-channel model");
  requireCapture(config.bottleneck === 3, "expected bottleneck=3");
  requireCapture(same(config.kernel_sizes, A2_KERNEL_SIZES), "unsupported kernel layout");
  requireCapture(same(config.dilations, A2_DILATIONS), "unsupported dilation layout");
  const head = object(config.head);
  requireCapture(head?.out_channels === 1 && head.kernel_size === 16 && head.bias === true,
    "expected a biased 16-tap mono head");
  requireCapture(same(config.layer1x1, { active: true, groups: 1 }), "unsupported layer1x1");
  requireCapture(object(config.head1x1)?.active === false, "head1x1 must be inactive");
  requireCapture(config.groups_input === 1, "groups_input must be 1");
  requireCapture(config.groups_input_mixin === 1, "groups_input_mixin must be 1");
  const activations = config.activation;
  requireCapture(Array.isArray(activations) && activations.length === 23, "expected 23 activations");
  requireCapture(activations.every((value) => {
    const activation = object(value);
    return activation?.type === "LeakyReLU" && finiteNumber(activation.negative_slope) === 0.01;
  }), "runtime requires LeakyReLU with slope 0.01");
  requireCapture(same(config.gating_mode, Array(23).fill("none")), "gating is unsupported");
  requireCapture(same(config.secondary_activation, Array(23).fill(null)), "secondary activations are unsupported");
  const filmKeys = ["conv_pre_film", "conv_post_film", "input_mixin_pre_film", "input_mixin_post_film",
    "activation_pre_film", "activation_post_film", "layer1x1_post_film", "head1x1_post_film"];
  requireCapture(filmKeys.every((key) => inactiveFilm(config[key])), "FiLM layers are unsupported");
  const weights = model.weights;
  requireCapture(Array.isArray(weights) && weights.length === A2_WEIGHT_COUNT,
    `expected exactly ${A2_WEIGHT_COUNT} weights`);
  const values = weights.map(finiteNumber);
  requireCapture(values.every((value) => value !== null), "weights must all be finite");
  return values as number[];
}

export function selectA2Lite(document: JsonObject) {
  let candidates: Array<[JsonObject, number]>;
  if (document.architecture === "SlimmableContainer") {
    const submodels = object(document.config)?.submodels;
    requireCapture(Array.isArray(submodels) && submodels.length > 0,
      "this Tone3000 download contains no submodels");
    candidates = submodels.flatMap((value, index) => {
      const model = object(object(value)?.model);
      return model ? [[model, index] as [JsonObject, number]] : [];
    });
    requireCapture(candidates.length > 0, "this Tone3000 download contains no readable submodels");
  } else candidates = [[document, -1]];
  const failures: string[] = [];
  for (const [model, index] of candidates) {
    try { return { model, index, weights: validateA2Lite(model) }; }
    catch (error) {
      failures.push(`${index < 0 ? "model" : `submodel ${index}`}: ${error instanceof Error ? error.message : String(error)}`);
    }
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

export function prepareCapture(_backend: Backend, fileName: string, bytes: Uint8Array): PreparedCapture {
  requireCapture(fileName.toLowerCase().endsWith(".nam"),
    "Choose a Tone3000 .nam download containing an A2-Lite model.");
  const document = parseNam(bytes);
  let selected: ReturnType<typeof selectA2Lite>;
  try { selected = selectA2Lite(document); }
  catch (error) {
    throw new Error(`This capture cannot run on the pedal. ${error instanceof Error ? error.message : String(error)}`);
  }
  const buffer = new ArrayBuffer(selected.weights.length * 4);
  const view = new DataView(buffer);
  selected.weights.forEach((weight, index) => view.setFloat32(index * 4, weight, true));
  return {
    format: "a2_weights_f32",
    name: captureName(fileName, document),
    payload: new Uint8Array(buffer),
    loudnessMillidb: (() => {
      const loudness = finiteNumber(object(selected.model.metadata)?.loudness);
      return loudness !== null && loudness >= -120 && loudness <= 24
        ? Math.round(loudness * 1000) : null;
    })(),
  };
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

export function backendFromInfo(fields: string[]): Backend {
  requireCapture(fields[0] === "INFO" && Boolean(fields[1]), "This is not a Hothouse NAM pedal");
  requireCapture(isSupportedBackend(fields[1]),
    "This pedal is running incompatible firmware. Install the latest Hothouse firmware before loading captures.");
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
  requireCapture(fields[3] === "a2_weights_f32" && Number.isSafeInteger(size) && size > 0
    && /^[0-9a-f]{8}$/i.test(fields[5]),
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
