import { useEffect, useRef, useState } from "react";

/**
 * Shared microphone → base64-WAV recorder used by both the Tools page
 * (Speak → Text panel) and the Assistant window (push-to-talk mic button).
 *
 * The recorder captures via MediaRecorder, decodes to 16-bit PCM mono WAV, and
 * hands back a base64 string ready for the fork's `whisper` tool. It lives here
 * (not in a component file) so any surface can reuse one hardened implementation.
 */

export const MAX_RECORD_MS = 300_000; // cap a recording at 5 min (memory + upload size). Beyond a
// few minutes the right path is chunked transcription, not a bigger single base64 WAV upload.

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Decode any recorded blob → 16-bit PCM mono WAV → base64 (whisper accepts WAV reliably). */
function encodeWavMono(buf: AudioBuffer): ArrayBuffer {
  const len = buf.length;
  const mono = new Float32Array(len);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += data[i] / buf.numberOfChannels;
  }
  const sampleRate = buf.sampleRate; // header rate == decoded data rate by construction
  const dataSize = len * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return out;
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer();
  // OfflineAudioContext for decode-only — no concurrent live-context cap (L3).
  const OAC: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  const ctx = new OAC(1, 1, 44100);
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  return bytesToBase64(new Uint8Array(encodeWavMono(audioBuf)));
}

/**
 * Mic recorder with full lifecycle hygiene (H2): the stream is held in a ref and
 * released on stop, on the 2-min cap, AND on unmount — so switching workspace
 * tabs mid-recording can never orphan a live mic. Delivers the encoded clip via
 * `onResult` (also fired when the cap auto-stops), never after unmount.
 */
export function useRecorder(onResult: (b64: string | null) => void) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const releaseStream = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive")
          recorderRef.current.stop();
      } catch {
        /* recorder already gone */
      }
      releaseStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    const mr = recorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop(); // onstop does the encode + deliver
    if (mountedRef.current) setRecording(false);
  };

  const start = async () => {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (mountedRef.current) setError("Microphone access was denied or is unavailable.");
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      releaseStream();
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      chunksRef.current = [];
      let out: string | null = null;
      try {
        out = await blobToWavBase64(blob);
      } catch {
        if (mountedRef.current) setError("Couldn't process that recording. Try again.");
      }
      if (mountedRef.current) onResultRef.current(out); // never deliver after unmount
    };
    recorderRef.current = mr;
    mr.start();
    if (mountedRef.current) setRecording(true);
    timerRef.current = setTimeout(() => stop(), MAX_RECORD_MS);
  };

  return { recording, error, start, stop };
}
