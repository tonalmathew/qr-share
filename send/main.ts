// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.

import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, wrapPayload, type FrameHeader } from "../shared/protocol";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 3;

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const pickBtn = document.getElementById("pick-btn") as HTMLButtonElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const cfgTiles = document.getElementById("cfg-tiles") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

let filePayload: Uint8Array | null = null;
let payloadName = "";
let streaming = false; // becomes true on "Start sharing"
let generation = 0; // bumped on every restart; stale loops see it and die

function clearCanvas() {
  canvas.width = 16;
  canvas.height = 16;
  canvas.style.width = "";
  canvas.style.height = "";
}

async function main() {
  pickBtn.addEventListener("click", () => cfgFile.click());
  cfgFile.addEventListener("change", async () => {
    const file = cfgFile.files?.[0];
    if (!file) return;
    const gen = ++generation; // invalidate any running stream while we read
    streaming = false;
    startBtn.style.display = "none";
    specs.textContent = `reading ${file.name}…`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      specs.textContent = `✗ couldn't read ${file.name} — likely too large to load into memory`;
      return;
    }
    if (gen !== generation) return; // superseded by another pick
    filePayload = wrapPayload(file.name, bytes);
    payloadName = file.name;
    pickBtn.textContent = "Change file";
    startBtn.style.display = "";
    clearCanvas();
    specs.textContent = `${file.name} · ${Math.round(bytes.length / 1024)} KB — ready to share`;
  });
  startBtn.addEventListener("click", () => {
    startBtn.style.display = "none";
    streaming = true;
    void startStream();
  });
  for (const el of [cfgTiles, cfgFps, cfgBytes, cfgEcc, cfgSize]) {
    el.addEventListener("change", () => {
      if (streaming) void startStream();
    });
  }
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}

async function startStream() {
  const payload = filePayload;
  if (!payload) return; // nothing picked yet
  const gen = ++generation;
  const grid = Number(cfgTiles.value); // grid×grid QR tiles per displayed frame
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = frameBytes - HEADER_LEN;
  const maxLen = 0xffff * blockLen; // k is a u16 in the frame header
  if (payload.length > maxLen) {
    streaming = false;
    startBtn.style.display = "";
    specs.textContent =
      `✗ ${payloadName} is ${Math.round(payload.length / 1024 / 1024)} MB — ` +
      `max ${Math.floor(maxLen / 1024 / 1024)} MB at ${frameBytes} bytes/frame. ` +
      `QR is a slow optical channel; large videos aren't practical.`;
    return;
  }
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
  };

  let version: number | undefined; // locked after the first frame
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  // Each tile lives in a (modules + 2·MARGIN) cell: MARGIN of quiet zone on
  // every side, so neighboring tiles are separated by 2·MARGIN of white.
  const totalModules = () => grid * (modules + 2 * MARGIN);

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = totalModules();
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeQr = () => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      const etaSec = (encoder.k * 1.18) / (txFps * grid * grid); // ≈ frames needed / tx rate
      const eta = etaSec >= 90 ? `~${Math.ceil(etaSec / 60)} min` : `~${Math.ceil(etaSec)} s`;
      specs.textContent =
        `${payloadName} · ${grid}×${grid} tiles · ${txFps} FPS · ${frameBytes} bytes per frame · ` +
        `V${version} · ECC ${ecc} · ${Math.round(payload.length / 1024)} KB payload · ` +
        `K=${encoder.k} · ${eta} best case`;
    }
    return qr;
  };

  const makeFrame = (): ImageData => {
    // grid² independent fountain frames composed into one displayed image
    const codes = Array.from({ length: grid * grid }, makeQr);
    const cell = modules + 2 * MARGIN;
    const total = totalModules();
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let t = 0; t < codes.length; t++) {
      const data = codes[t]!.modules.data;
      const ox = (t % grid) * cell + MARGIN;
      const oy = Math.floor(t / grid) * cell + MARGIN;
      for (let y = 0; y < modules; y++) {
        const row = (y + oy) * total + ox;
        const src = y * modules;
        for (let x = 0; x < modules; x++) {
          if (data[src + x]) px[row + x] = 0xff000000;
        }
      }
    }
    return img;
  };

  const pump = () => {
    if (gen !== generation) return; // superseded by a settings change
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      // e.g. frame bytes over capacity for the chosen ECC level
      specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval; // fell behind — don't burst
  };
  requestAnimationFrame(tick);
}

void main();
