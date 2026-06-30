import { ToolError } from "./tool-error";

/**
 * Microsoft Edge neural text-to-speech for Hebrew.
 *
 * This is the dashboard's keyless Hebrew speech path. It ports the Edge
 * read-aloud WebSocket protocol to workerd's fetch-upgrade WebSocket API:
 * fetch the WSS URL with Upgrade headers, accept the returned socket, send
 * speech.config + SSML frames, collect MP3 audio frames, and finish on turn.end.
 */

const AI_TIMEOUT_MS = 60_000;
// workerd outbound WebSockets go through fetch() with an `Upgrade: websocket` header
// and require the HTTPS scheme (not wss://) — fetch() rejects the wss:// scheme.
const EDGE_TTS_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION = "1-143.0.3650.75";
const DEFAULT_HEBREW_VOICE = "he-IL-AvriNeural";
const HEBREW_VOICES = new Set(["he-IL-AvriNeural", "he-IL-HilaNeural"]);
const EDGE_HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
};

type WorkerdWebSocket = EventTarget & {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  readonly readyState?: number;
};

export async function synthesizeHebrew(text: string, voice: string): Promise<Uint8Array> {
  const selectedVoice = HEBREW_VOICES.has(voice) ? voice : DEFAULT_HEBREW_VOICE;
  const token = await edgeGecToken();
  const url = `${EDGE_TTS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${GEC_VERSION}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Upgrade: "websocket", ...EDGE_HEADERS } });
  } catch (e) {
    throw new ToolError(502, `Edge connect failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // workerd exposes outbound WebSockets as Response.webSocket, which is not in DOM Response types.
  const ws = (resp as Response & { webSocket?: WorkerdWebSocket }).webSocket;
  if (!ws) throw new ToolError(502, `Edge handshake rejected (HTTP ${resp.status}).`);

  ws.accept();
  try {
    return await synthesizeOverSocket(ws, text, selectedVoice);
  } finally {
    closeSocket(ws);
  }
}

async function edgeGecToken(): Promise<string> {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  let ticks = (unixSeconds + 11644473600n) * 10_000_000n;
  ticks -= ticks % 3_000_000_000n;

  const input = new TextEncoder().encode(`${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return hex(new Uint8Array(digest)).toUpperCase();
}

function synthesizeOverSocket(ws: WorkerdWebSocket, text: string, voice: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const audioChunks: Uint8Array[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const fail = (error: ToolError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      const total = audioChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (total === 0) {
        fail(new ToolError(502, "No Hebrew audio was returned."));
        return;
      }
      const audio = new Uint8Array(total);
      let offset = 0;
      for (const chunk of audioChunks) {
        audio.set(chunk, offset);
        offset += chunk.byteLength;
      }
      settled = true;
      cleanup();
      resolve(audio);
    };

    const onMessage = (event: Event) => {
      const data: unknown = (event as MessageEvent).data;
      try {
        if (typeof data === "string") {
          if (data.includes("Path:turn.end")) finish();
          return;
        }
        if (data instanceof ArrayBuffer) {
          const audio = parseAudioFrame(data);
          if (audio) audioChunks.push(audio);
        }
      } catch (e) {
        fail(e instanceof ToolError ? e : new ToolError(502, "Hebrew speech service returned invalid audio."));
      }
    };
    const onError = () => fail(new ToolError(502, "Hebrew speech service connection failed."));
    const onClose = () => fail(new ToolError(502, "Hebrew speech service closed before synthesis completed."));

    timer = setTimeout(() => fail(new ToolError(502, "Hebrew speech service timed out.")), AI_TIMEOUT_MS);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);

    try {
      const timestamp = new Date().toString();
      ws.send(speechConfigFrame(timestamp));
      ws.send(ssmlFrame(timestamp, randomHex32(), ssml(text, voice)));
    } catch {
      fail(new ToolError(502, "Hebrew speech service unavailable."));
    }
  });
}

function speechConfigFrame(timestamp: string): string {
  const body =
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
  return `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}`;
}

function ssmlFrame(timestamp: string, requestId: string, body: string): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${body}`;
}

function ssml(text: string, voice: string): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='he-IL'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
}

function parseAudioFrame(data: ArrayBuffer): Uint8Array | null {
  if (data.byteLength < 2) throw new ToolError(502, "Hebrew speech service returned an invalid frame.");
  const view = new DataView(data);
  const headerLength = view.getUint16(0, false);
  if (headerLength > data.byteLength - 2) {
    throw new ToolError(502, "Hebrew speech service returned an invalid frame.");
  }

  const bytes = new Uint8Array(data);
  const header = new TextDecoder().decode(bytes.slice(2, 2 + headerLength));
  if (!header.includes("Path:audio")) return null;
  return bytes.slice(2 + headerLength);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function closeSocket(ws: WorkerdWebSocket): void {
  try {
    if (ws.readyState === undefined || ws.readyState < 2) ws.close();
  } catch {
    /* closing a WebSocket can race with peer close */
  }
}
