// Sanj Studio — Media Engine, Part 2: Voice, Prompts, Visuals (Edge Function)
// Called by the Studio after the Big Brain (job-engine) has written the
// script for a job. Voice is Microsoft Edge TTS by default (keyless);
// pictures use the JOB OWNER'S OWN saved Gemini API keys — pools in this
// order: Visuals, Writer, Brain (the Antigravity login token is NOT an
// API key and is never tried as one):
//   4 Voice   — Microsoft Edge TTS by default (the Edge browser's Read
//               Aloud voices: no API key, no account, no daily cap in
//               practice), with the owner's Gemini TTS keys as fallback —
//               or the other way round when the owner deliberately picked
//               a Gemini voice. Files land in the owner's private
//               "videos" bucket: scripts up to 24 lines get one file per
//               line (<uid>/jobs/<jobId>/audio/line-NNN.mp3 from Edge,
//               .wav from Gemini); longer scripts are grouped — one
//               request per chunk of up to 8 lines (audio/group-NNN.*) —
//               because Google's free TTS budget is a tiny number of
//               requests per day. A manifest at
//               <uid>/jobs/<jobId>/media-manifest.json lists EVERY unit
//               with its file, line range, format and the provider that
//               voiced it. A group also counts as covered when every line
//               in its range already exists as a line-*.mp3/.wav from an
//               older run — those recordings are never wasted or re-made.
//   5 Prompts — one image prompt per script line: the niche card's LOCKED
//               style block + LOCKED character block + the line itself,
//               saved to <uid>/jobs/<jobId>/prompts.json
//   6 Visuals — Nano Banana (Gemini image model) turns each prompt into
//               <uid>/jobs/<jobId>/images/scene-NNN.png
// Everything is resumable: files already in storage are skipped, so a run
// that hits the time budget stops with an honest "N of M made" note and the
// next run continues where it stopped. Nothing is faked: a step is marked
// done only when every file for it really exists.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "https://vixxionbaloch-debug.github.io",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

type Step = { n: number; name: string; state: string; note?: string };
type Cand = { id: string; label: string; key: string };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const pad3 = (n: number) => String(n).padStart(3, "0");

// A key that answers with one of these is dead for the rest of the run.
const isKeyKiller = (m: string) =>
  /resource has been exhausted|quota|RESOURCE_EXHAUSTED|API key not valid|API_KEY_INVALID|key check failed/i.test(m);

function friendlyMediaError(raw: string): string {
  if (/high demand|overloaded/i.test(raw)) {
    return "Google's media models are overloaded right now (high demand). This is temporary and usually clears in a short while. Run the job again a bit later.";
  }
  const hasModelProblem = /not found|not supported|no speech|no picture model/i.test(raw);
  if (!hasModelProblem && /resource has been exhausted|quota|RESOURCE_EXHAUSTED/i.test(raw)) {
    return "Google's free media limit for this account is used up for now. It resets daily. Tip: add a free Gemini API key in My Connections (Visuals pool) and the tool will make voice and pictures with that instead.";
  }
  if (!hasModelProblem && /API key not valid|API_KEY_INVALID/i.test(raw)) {
    return "A saved API key is not valid. Add the right key again in My Connections.";
  }
  return raw;
}

function detailsNote(errs: string[]): string {
  const joined = [...new Set(errs)].join(" | ").slice(0, 900) || "no media account answered";
  const friendly = friendlyMediaError(joined);
  return friendly === joined ? joined : `${friendly} Details: ${joined}`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Gemini TTS returns raw PCM (16-bit little-endian, mono). Wrap it in the
// standard 44-byte WAV header so any player / the render step can use it.
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// Ask Google which models THIS key can use — never guess model names
// (same approach as job-engine).
async function listModels(apiKey: string): Promise<string[]> {
  const lr = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    { signal: AbortSignal.timeout(20000) },
  );
  const ld = await lr.json().catch(() => ({}));
  if (!lr.ok) {
    const m =
      (ld as { error?: { message?: string } })?.error?.message ?? `HTTP ${lr.status}`;
    throw new Error(`key check failed: ${m}`);
  }
  const allModels = ((ld as { models?: unknown }).models ?? []) as {
    name?: string;
    supportedGenerationMethods?: string[];
  }[];
  return allModels
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => (m.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}

// Speech models on the key, best first: working flash TTS first,
// "-latest" aliases last (they overload first) — mirrors job-engine.
function ttsModels(models: string[]): string[] {
  const rank = (n: string) => {
    const latest = /latest/i.test(n) ? 2 : 0;
    if (/flash/i.test(n)) return latest;
    return latest + 1;
  };
  return models
    .filter((n) => /tts/i.test(n))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3);
}

// Nano Banana image models on the key, best first.
function imageModels(models: string[]): string[] {
  const rank = (n: string) => {
    const latest = /latest/i.test(n) ? 2 : 0;
    if (/flash/i.test(n)) return latest;
    return latest + 1;
  };
  return models
    .filter((n) => /image|banana/i.test(n))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3);
}

async function ttsOnce(
  apiKey: string,
  model: string,
  text: string,
  voiceName: string,
): Promise<{ pcm: Uint8Array; rate: number }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
        },
      }),
      signal: AbortSignal.timeout(45000),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m =
      (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`${model}: ${m}`);
  }
  const parts =
    (data as { candidates?: { content?: { parts?: unknown[] } }[] }).candidates?.[0]
      ?.content?.parts ?? [];
  for (const p of parts) {
    const inl = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inl?.data) {
      const rate = Number(/rate=(\d+)/.exec(inl.mimeType ?? "")?.[1] ?? 24000);
      return { pcm: b64ToBytes(inl.data), rate: rate > 0 ? rate : 24000 };
    }
  }
  throw new Error(`${model}: answered with no audio`);
}

async function imageOnce(
  apiKey: string,
  model: string,
  prompt: string,
  aspect: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const call = async (withAspect: boolean): Promise<Record<string, unknown>> => {
    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: prompt }] }],
    };
    if (withAspect && aspect) {
      body.generationConfig = { imageConfig: { aspectRatio: aspect } };
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const m =
        (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`${model}: ${m}`);
    }
    return data as Record<string, unknown>;
  };
  // Ask for the job's shape (16:9 / 9:16); if the model refuses the shape
  // setting, ask again plainly before giving up on this model.
  let data: Record<string, unknown>;
  try {
    data = await call(true);
  } catch (e) {
    if (!aspect) throw e;
    data = await call(false);
  }
  const parts =
    (data as { candidates?: { content?: { parts?: unknown[] } }[] }).candidates?.[0]
      ?.content?.parts ?? [];
  for (const p of parts) {
    const inl = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inl?.data) return { bytes: b64ToBytes(inl.data), mime: inl.mimeType ?? "image/png" };
  }
  throw new Error(`${model}: answered with no picture`);
}

// ---- Microsoft Edge TTS ------------------------------------------------
// The Edge browser's Read Aloud voices, over the same WebSocket the
// browser itself uses. No API key, no account, and no daily cap in
// practice — this is the primary voice provider; Gemini TTS is the
// fallback (or the primary when the owner picked a Gemini voice).
// Deno's global WebSocket cannot set custom headers, so the connection
// is made with the URL alone; if Microsoft refuses an attempt, the
// error simply flows into the caller's normal per-unit fallback.
const EDGE_TTS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

function randomHex32(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// One connection per unit. Sends the speech.config frame, then the SSML
// frame; collects the audio payloads of the binary frames (each starts
// with a 2-byte big-endian header length, then the header text — audio
// frames are the ones whose header says "Path:audio") until a text
// frame says "Path:turn.end". Gives up after about 30 seconds.
function edgeTtsOnce(text: string, voice: string): Promise<Uint8Array> {
  const locale = voice.slice(0, 5); // "ja-JP" out of "ja-JP-NanamiNeural"
  const url =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
    `?TrustedClientToken=${EDGE_TTS_TOKEN}&ConnectionId=${randomHex32()}`;
  const configBody = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: "false",
            wordBoundaryEnabled: "false",
          },
          outputFormat: "audio-24khz-96kbitrate-mono-mp3",
        },
      },
    },
  });
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
    `<voice name='${voice}'><prosody rate='+0%' pitch='+0%'>${xmlEscape(text)}</prosody></voice></speak>`;
  return new Promise<Uint8Array>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new Error(`connection failed: ${msg(e)}`));
      return;
    }
    ws.binaryType = "arraybuffer";
    const chunks: Uint8Array[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (m: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch { /* already closed */ }
      reject(new Error(m));
    };
    timer = setTimeout(() => fail("timed out after 30 seconds"), 30000);
    ws.onopen = () => {
      // The timestamp shape Microsoft's own client sends; the SSML
      // frame carries the same stamp with the extra trailing "Z" the
      // service expects on that frame.
      const ts = new Date().toString();
      try {
        ws.send(
          `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${configBody}`,
        );
        ws.send(
          `X-RequestId:${randomHex32()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`,
        );
      } catch (e) {
        fail(`could not send the request: ${msg(e)}`);
      }
    };
    ws.onmessage = (ev) => {
      if (settled) return;
      if (typeof ev.data === "string") {
        if (ev.data.includes("Path:turn.end")) {
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch { /* ignore */ }
          if (chunks.length === 0) {
            reject(new Error("the turn ended with no audio"));
            return;
          }
          const size = chunks.reduce((n, c) => n + c.length, 0);
          const out = new Uint8Array(size);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          resolve(out);
        }
        return;
      }
      const buf = new Uint8Array(ev.data as ArrayBuffer);
      if (buf.length < 2) return;
      const headerLen = (buf[0] << 8) | buf[1];
      if (buf.length < 2 + headerLen) return;
      const header = new TextDecoder().decode(buf.subarray(2, 2 + headerLen));
      if (header.includes("Path:audio")) {
        chunks.push(buf.slice(2 + headerLen));
      }
    };
    ws.onerror = () => fail("the connection errored");
    ws.onclose = () => {
      if (!settled) fail("the connection closed before the voice finished");
    };
  });
}

async function listNames(
  admin: SupabaseClient,
  prefix: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const { data, error } = await admin.storage
    .from("videos")
    .list(prefix, { limit: 1000 });
  if (!error && data) {
    for (const o of data as { name?: string }[]) if (o.name) out.add(o.name);
  }
  return out;
}

async function uploadFile(
  admin: SupabaseClient,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await admin.storage
    .from("videos")
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`saving a file failed: ${error.message}`);
}

// The job / niche voice fields hold a display name (e.g. "Charon" or a
// voice the owner named). Gemini TTS needs a prebuilt voice name: take
// the first clean word; anything unusable falls back to "Charon".
function explicitVoiceWord(...raw: (string | null | undefined)[]): string | null {
  for (const r of raw) {
    const s = (r ?? "").trim();
    if (!s || /^auto$/i.test(s)) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]{1,30}$/.test(s)) return s;
    const first = s.split(/\s+/)[0];
    if (/^[A-Za-z][A-Za-z0-9_-]{1,30}$/.test(first)) return first;
  }
  return null;
}

function pickVoiceName(...raw: (string | null | undefined)[]): string {
  return explicitVoiceWord(...raw) ?? "Charon";
}

// A Microsoft Edge voice name hiding in a voice field, if the owner
// named one: a full neural name ("ja-JP-NanamiNeural") or any
// locale-shaped name ("ja-JP-...").
function edgeVoiceIn(...raw: (string | null | undefined)[]): string | null {
  for (const r of raw) {
    const s = (r ?? "").trim();
    if (!s) continue;
    const m =
      s.match(/[A-Za-z]{2}-[A-Za-z]{2}-[A-Za-z0-9]+Neural/) ??
      s.match(/[A-Za-z]{2}-[A-Za-z]{2}-[A-Za-z][A-Za-z0-9]*/);
    if (m) return m[0];
  }
  return null;
}

// The default Edge voice for the job's language. The app stores the
// language as a display name ("Japanese"); locale codes ("ja", "ja-JP")
// are understood too. Anything unrecognised gets the English voice.
function defaultEdgeVoice(rawLang: string): string {
  const s = (rawLang ?? "").trim().toLowerCase();
  if (/japan/.test(s) || s === "ja" || s.startsWith("ja-") || s.startsWith("ja ")) {
    return "ja-JP-NanamiNeural";
  }
  if (/hindi/.test(s) || s === "hi" || s.startsWith("hi-") || s.startsWith("hi ")) {
    return "hi-IN-SwaraNeural";
  }
  if (/urdu/.test(s) || s === "ur" || s.startsWith("ur-") || s.startsWith("ur ")) {
    return "ur-PK-UzmaNeural";
  }
  return "en-US-AriaNeural";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ ok: false, error: "Please sign in to Sanj Studio first." }, 401);
  }
  const userId = userData.user.id;

  const body = await req.json().catch(() => ({}));
  const jobId = body?.job_id as string;
  if (!jobId) return json({ ok: false, error: "No job given." }, 400);

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, title, kind, source, settings, steps, owner_id")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) return json({ ok: false, error: "That job was not found." }, 404);
  if (job.owner_id !== userId) {
    return json({ ok: false, error: "That job belongs to someone else." }, 403);
  }

  const settings = (job.settings ?? {}) as Record<string, string>;

  // The script the Big Brain saved for this job (newest first).
  const { data: scriptRows } = await admin
    .from("scripts")
    .select("id, body")
    .eq("job_id", job.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const scriptRow = (scriptRows ?? [])[0];
  if (!scriptRow) {
    return json({
      ok: false,
      error: "No script was found for this job. The Big Brain writes the script first — steps 1 to 3 must finish before voice and pictures.",
    }, 400);
  }
  const lines = String(scriptRow.body ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return json({ ok: false, error: "The saved script for this job is empty." }, 400);
  }
  const total = lines.length;

  // The owner's niche card, when the job names one (same lookup as job-engine).
  let niche: {
    name: string;
    language: string;
    style: string;
    character_desc: string;
    voice: string;
    script_dna: string;
  } | null = null;
  if (settings.niche) {
    const { data: niches } = await admin
      .from("niches")
      .select("name, language, style, character_desc, voice, script_dna")
      .eq("owner_id", userId)
      .eq("name", settings.niche)
      .limit(1);
    const n = (niches ?? [])[0];
    if (n) {
      niche = {
        name: n.name as string,
        language: (n.language as string) ?? "",
        style: (n.style as string) ?? "",
        character_desc: (n.character_desc as string) ?? "",
        voice: (n.voice as string) ?? "",
        script_dna:
          typeof n.script_dna === "string"
            ? n.script_dna
            : JSON.stringify(n.script_dna ?? ""),
      };
    }
  }

  // ---- Media keys: the owner's own Gemini API keys ---------------------
  // Order: Visuals pool, then Writer, then Brain. The first ready Brain
  // connection is the Antigravity account — its saved secret is a Google
  // login (refresh) token, NOT an API key, so it is excluded exactly the
  // way job-engine excludes it.
  const { data: brainConns } = await admin
    .from("connections")
    .select("id")
    .eq("owner_id", userId)
    .eq("pool", "brain")
    .eq("status", "ready")
    .order("created_at", { ascending: true })
    .limit(1);
  const agConnId = brainConns && brainConns.length > 0 ? brainConns[0].id : null;

  const poolRank: Record<string, number> = { visuals: 0, writer: 1, brain: 2 };
  const { data: keyConns } = await admin
    .from("connections")
    .select("id, label, pool")
    .eq("owner_id", userId)
    .in("pool", ["visuals", "writer", "brain"])
    .eq("status", "ready")
    .order("created_at", { ascending: true });
  const orderedConns = [...(keyConns ?? [])].sort(
    (a, b) => (poolRank[a.pool as string] ?? 3) - (poolRank[b.pool as string] ?? 3),
  );
  const candidates: Cand[] = [];
  const seenKeys = new Set<string>();
  for (const kc of orderedConns) {
    if (agConnId && kc.id === agConnId) continue;
    const { data: s } = await admin
      .from("connection_secrets")
      .select("refresh_token")
      .eq("connection_id", kc.id)
      .single();
    const key = s?.refresh_token as string | undefined;
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      candidates.push({ id: kc.id as string, label: kc.label as string, key });
    }
  }

  // ---- Steps ------------------------------------------------------------
  const steps = ((job.steps ?? []) as Step[]).map((s) => ({ ...s }));
  const stepOf = (name: string) => steps.find((x) => x.name === name);
  const MEDIA_ORDER = ["Voice", "Prompts", "Visuals", "Render"];
  const advance = (doneName: string) => {
    const i = MEDIA_ORDER.indexOf(doneName);
    if (i < 0) return;
    const nxt = steps.find((x) => x.name === MEDIA_ORDER[i + 1]);
    if (nxt && nxt.state === "todo") nxt.state = "now";
  };
  const markDone = (name: string, note: string) => {
    const st = stepOf(name);
    if (st) {
      st.state = "done";
      st.note = note;
    }
    advance(name);
  };
  const markTodo = (name: string, note: string) => {
    const st = stepOf(name);
    if (st) {
      st.state = "todo";
      st.note = note;
    }
  };
  const saveSteps = async () => {
    const doneCount = steps.filter((x) => x.state === "done").length;
    const progress = Math.round((doneCount / Math.max(1, steps.length)) * 100);
    await admin
      .from("jobs")
      .update({ steps, progress, status: "making" })
      .eq("id", job.id);
  };

  // ---- Prompts are built in memory first (Visuals needs them even when
  // the Prompts step was finished by an earlier run). The LOCKED blocks
  // come from the niche card: `style` is the style block, `character_desc`
  // is the character block. Fallbacks: the niche's script_dna text, then
  // the job's own settings.
  const dna = (niche?.script_dna ?? "").trim();
  const styleBlock =
    (niche?.style ?? "").trim() ||
    (dna ? `Follow this niche style DNA exactly: ${dna}` : "") ||
    `One consistent, professional art style for the whole video (${settings.format ?? "16:9"}), clean and detailed — the exact same look in every picture.`;
  let charBlock = (niche?.character_desc ?? "").trim();
  if (!charBlock && dna) {
    charBlock = `Keep the characters exactly as this niche DNA describes: ${dna}`;
  }
  const charactersOff = settings.charactersOn === "false";
  const charLockOff = settings.charLock === "false";
  const buildPrompt = (line: string, idx: number): string => {
    const parts: string[] = [
      `STYLE (locked — identical in every scene): ${styleBlock}`,
    ];
    if (!charactersOff && charBlock) {
      parts.push(
        `CHARACTER (locked — same character in every scene, same face, hair, clothes and colors): ${charBlock}`,
      );
    } else if (!charactersOff && !charLockOff) {
      parts.push(
        "CHARACTER (locked): if a character appears, keep the exact same face, hair, clothes and colors in every scene.",
      );
    }
    parts.push(`SCENE ${idx + 1}: ${line}`);
    return parts.join("\n");
  };
  const scenePrompts = lines.map((line, i) => ({
    scene: i + 1,
    line,
    prompt: buildPrompt(line, i),
  }));

  // Zero saved keys no longer stops the run: Voice has the keyless Edge
  // provider, and Prompts never needed a key. Only Visuals still
  // requires the owner's Gemini keys — it says so on its own step below.

  // Per-run helpers: model lists are cached per key; a key that hits a
  // quota / invalid-key answer is dead for the rest of the run.
  const modelCache = new Map<string, string[]>();
  // Dead keys are tracked PER CAPABILITY: Google gives TTS and image
  // generation separate quotas, so a key whose TTS quota is used up can
  // still make pictures, and the other way round. A key is dead only for
  // the capability whose call actually killed it in this run.
  type Cap = "tts" | "img";
  const deadKeys: Record<Cap, Set<string>> = { tts: new Set(), img: new Set() };
  // Why each key died, per capability — a step that skips a dead key must
  // still be able to SAY why, instead of losing the reason and reporting
  // a bare "no media account answered".
  const deadReason: Record<Cap, Map<string, string>> = {
    tts: new Map(),
    img: new Map(),
  };
  const killKey = (cap: Cap, cand: Cand, m: string) => {
    deadKeys[cap].add(cand.id);
    if (!deadReason[cap].has(cand.id)) {
      deadReason[cap].set(cand.id, `${cand.label}: ${m}`);
    }
  };
  const noteDead = (cap: Cap, cand: Cand, errs: string[]) => {
    const r = deadReason[cap].get(cand.id);
    if (r) errs.push(r);
  };
  // Attempt order starting at an offset, wrapping around — used to spread
  // requests across keys and models instead of always draining the first.
  const rotated = <T,>(arr: T[], offset: number): T[] =>
    arr.length <= 1
      ? arr
      : [...arr.slice(offset % arr.length), ...arr.slice(0, offset % arr.length)];
  const modelsFor = async (cand: Cand): Promise<string[]> => {
    const hit = modelCache.get(cand.id);
    if (hit) return hit;
    const names = await listModels(cand.key);
    modelCache.set(cand.id, names);
    return names;
  };

  // One bounded invocation: leave time to save state before the platform
  // cuts the call. Anything unfinished keeps an honest partial note and
  // the next run resumes from the files already in storage.
  const startedAt = Date.now();
  const DEADLINE_MS = 110_000;
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  let firstFailure: string | null = null;

  // ================= STEP: VOICE =================
  let voiceHave = 0;
  const voiceStep = stepOf("Voice");
  if (voiceStep && voiceStep.state === "done") {
    voiceHave = total;
  } else if (voiceStep) {
    const prefix = `${userId}/jobs/${job.id}/audio`;
    const existing = await listNames(admin, prefix);
    // ---- Voice choice ---------------------------------------------------
    // A voice field that names an Edge voice (a neural name, or any
    // locale-shaped name) picks that Edge voice. A voice field that
    // names a Gemini prebuilt voice (one clean word, e.g. "Charon") was
    // picked deliberately, so Gemini goes first for this job and Edge is
    // its fallback. "Auto" / empty: the Edge default for the job's
    // language, with Gemini as fallback — Edge needs no key and has no
    // daily cap, so voice works even with zero Gemini keys saved.
    const namedEdge = edgeVoiceIn(settings.voice, niche?.voice);
    const namedWord = explicitVoiceWord(settings.voice, niche?.voice);
    const edgeVoice = namedEdge ?? defaultEdgeVoice(settings.language || niche?.language || "");
    const geminiVoiceName = pickVoiceName(settings.voice, niche?.voice);
    const geminiFirst = !namedEdge && namedWord !== null;
    const providerOrder: ("edge" | "gemini")[] = geminiFirst
      ? ["gemini", "edge"]
      : ["edge", "gemini"];
    const edgeLabel = `Microsoft Edge voice ${edgeVoice}`;
    // Long scripts are voiced in GROUPS: one request covers up to 8
    // script lines. Google's free TTS budget is a small number of
    // requests per day per model per project (the first live run hit
    // "limit: 10"), so per-line Gemini requests can never finish a long
    // script, while a 49-line script needs only 7 group requests. Short
    // scripts keep the original one-file-per-line mode exactly. (Edge
    // has no such cap; groups stay anyway — fewer, longer files are
    // kinder to every provider and to the render step.)
    const GROUP_SIZE = 8;
    const useGroups = total > 24;
    type Unit = { base: string; from: number; to: number; text: string };
    const units: Unit[] = [];
    if (useGroups) {
      for (let from = 1; from <= total; from += GROUP_SIZE) {
        const to = Math.min(total, from + GROUP_SIZE - 1);
        units.push({
          base: `group-${pad3(units.length + 1)}`,
          from,
          to,
          text: lines.slice(from - 1, to).join("\n"),
        });
      }
    } else {
      for (let i = 1; i <= total; i++) {
        units.push({ base: `line-${pad3(i)}`, from: i, to: i, text: lines[i - 1] });
      }
    }
    // How a unit is covered by files already in storage. A unit's own
    // file may be .mp3 (Edge) or .wav (Gemini) — either covers it. In
    // groups mode a group is also covered when every line in its range
    // already exists as a single-line recording from an older per-line
    // run ("lines") — those recordings are never wasted: only uncovered
    // groups cost a new request. (In lines mode an own-file hit is
    // reported as "lines": the unit IS a single-line recording.)
    const ownFile = (u: Unit): string | null =>
      existing.has(`${u.base}.mp3`)
        ? `${u.base}.mp3`
        : existing.has(`${u.base}.wav`)
          ? `${u.base}.wav`
          : null;
    const lineFile = (ln: number): string | null =>
      existing.has(`line-${pad3(ln)}.mp3`)
        ? `line-${pad3(ln)}.mp3`
        : existing.has(`line-${pad3(ln)}.wav`)
          ? `line-${pad3(ln)}.wav`
          : null;
    const coverageOf = (u: Unit): "group" | "lines" | "none" => {
      if (ownFile(u)) return useGroups ? "group" : "lines";
      if (useGroups) {
        for (let ln = u.from; ln <= u.to; ln++) {
          if (!lineFile(ln)) return "none";
        }
        return "lines";
      }
      return "none";
    };
    const unitCovered = (u: Unit): boolean => coverageOf(u) !== "none";
    // Progress is always counted in LINES (a covered group counts all of
    // its lines, whichever kind of file covers them).
    const linesCovered = () =>
      units.reduce((n, u) => n + (unitCovered(u) ? u.to - u.from + 1 : 0), 0);
    voiceHave = linesCovered();
    const errs: string[] = [];
    let unitFailed = false;
    let stopped = false;
    // TTS requests already made this run. Each new Gemini request starts
    // its key/model attempt order at this offset, so consecutive lines
    // and groups spread across Gemini 1/2/3 and across the working TTS
    // models instead of always draining the first key first.
    let requestsMade = 0;
    let madeThisRun = 0;
    // What actually voiced each unit made in THIS run (unit index ->
    // provider + human label). Units covered by older files get their
    // provider from the file extension instead: Edge only ever writes
    // .mp3, and Gemini only ever wrote .wav.
    const madeInfo = new Map<number, { provider: "edge" | "gemini"; label: string }>();
    // Edge state for this run: three failures in a row and Edge sits
    // out the rest of the run (Gemini still runs, and the reason is
    // kept for the step's Details).
    let edgeFails = 0;
    let edgeDead = false;
    let edgeDeadReason = "";
    const tryEdgeUnit = async (u: Unit, idx: number): Promise<boolean> => {
      if (edgeDead) {
        errs.push(`Edge voice: stopped for this run (${edgeDeadReason})`);
        return false;
      }
      let mp3: Uint8Array;
      try {
        mp3 = await edgeTtsOnce(u.text, edgeVoice);
      } catch (e) {
        const m = msg(e);
        errs.push(`Edge voice: ${m}`);
        edgeFails++;
        if (edgeFails >= 3) {
          edgeDead = true;
          edgeDeadReason = m;
        }
        return false;
      }
      edgeFails = 0;
      const file = `${u.base}.mp3`;
      try {
        await uploadFile(admin, `${prefix}/${file}`, mp3, "audio/mpeg");
      } catch (e) {
        errs.push(msg(e));
        return false;
      }
      existing.add(file);
      madeInfo.set(idx, { provider: "edge", label: edgeLabel });
      return true;
    };
    const tryGeminiUnit = async (u: Unit, idx: number): Promise<boolean> => {
      for (const cand of rotated(candidates, requestsMade)) {
        if (deadKeys.tts.has(cand.id)) {
          noteDead("tts", cand, errs);
          continue;
        }
        let models: string[];
        try {
          models = ttsModels(await modelsFor(cand));
        } catch (e) {
          const m = msg(e);
          errs.push(`${cand.label}: ${m}`);
          if (isKeyKiller(m)) killKey("tts", cand, m);
          continue;
        }
        if (models.length === 0) {
          errs.push(`${cand.label}: this key has no speech (TTS) model`);
          continue;
        }
        for (const model of rotated(models, requestsMade)) {
          try {
            requestsMade++;
            const { pcm, rate } = await ttsOnce(cand.key, model, u.text, geminiVoiceName);
            const file = `${u.base}.wav`;
            await uploadFile(admin, `${prefix}/${file}`, pcmToWav(pcm, rate), "audio/wav");
            existing.add(file);
            madeInfo.set(idx, { provider: "gemini", label: cand.label });
            return true;
          } catch (e) {
            const m = msg(e);
            errs.push(m.startsWith("saving a file failed") ? m : `${cand.label}: ${m}`);
            if (isKeyKiller(m)) {
              killKey("tts", cand, m);
              break;
            }
          }
        }
      }
      return false;
    };
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui];
      if (unitCovered(u)) continue;
      if (outOfTime()) {
        stopped = true;
        break;
      }
      let made = false;
      for (const prov of providerOrder) {
        made = prov === "edge"
          ? await tryEdgeUnit(u, ui)
          : await tryGeminiUnit(u, ui);
        if (made) break;
      }
      if (!made) {
        unitFailed = true;
        break;
      }
      madeThisRun++;
      voiceHave = linesCovered();
    }
    // The render step reads this manifest to know how the voice was
    // made: EVERY unit is listed (both modes) with the actual file that
    // covers it, its format, and the provider that voiced it. Refreshed
    // on every voice run; a manifest problem never fails the step
    // itself, and voiceUsed keeps the last known label when nothing is
    // covered yet.
    type UnitEntry = {
      file: string | null;
      fromLine: number;
      toLine: number;
      chars: number;
      audio: "group" | "lines" | "none";
      format: "mp3" | "wav" | null;
      provider: "edge" | "gemini" | null;
    };
    const fmtOf = (f: string): "mp3" | "wav" => (f.endsWith(".mp3") ? "mp3" : "wav");
    const provOfFile = (f: string): "edge" | "gemini" =>
      f.endsWith(".mp3") ? "edge" : "gemini";
    const entries: UnitEntry[] = units.map((u, ui) => {
      const cov = coverageOf(u);
      if (cov === "none") {
        return {
          file: null,
          fromLine: u.from,
          toLine: u.to,
          chars: u.text.length,
          audio: "none",
          format: null,
          provider: null,
        };
      }
      const own = ownFile(u);
      if (own) {
        return {
          file: own,
          fromLine: u.from,
          toLine: u.to,
          chars: u.text.length,
          audio: cov,
          format: fmtOf(own),
          provider: madeInfo.get(ui)?.provider ?? provOfFile(own),
        };
      }
      // Groups mode, covered by single-line recordings: the entry's own
      // file is null (the line files are named by fromLine/toLine); the
      // format and provider are read off the first line's file.
      const first = lineFile(u.from)!;
      return {
        file: null,
        fromLine: u.from,
        toLine: u.to,
        chars: u.text.length,
        audio: "lines",
        format: fmtOf(first),
        provider: provOfFile(first),
      };
    });
    const labelOf = (ui: number, e: UnitEntry): string | null => {
      if (e.provider === "edge") return edgeLabel;
      if (e.provider === "gemini") return madeInfo.get(ui)?.label ?? "Gemini";
      return null;
    };
    // Line counts per provider label, over the units covered right now
    // — the done-notes and the manifest's voiceUsed speak from the same
    // numbers.
    const perLabel = new Map<string, number>();
    units.forEach((u, ui) => {
      const lbl = labelOf(ui, entries[ui]);
      if (lbl) perLabel.set(lbl, (perLabel.get(lbl) ?? 0) + (u.to - u.from + 1));
    });
    const singleLabel = perLabel.size === 1 ? [...perLabel.keys()][0] : null;
    const mixedText = [...perLabel.entries()]
      .map(([l, n]) => `${n} lines by ${l}`)
      .join(", ");
    const computedVoiceUsed = (() => {
      const ls = new Set(perLabel.keys());
      // Files from older Gemini runs carry no key label; when a named
      // Gemini key also voiced units, the plain "Gemini" adds nothing.
      if (ls.has("Gemini") && [...ls].some((l) => /^Gemini \S/.test(l))) {
        ls.delete("Gemini");
      }
      return [...ls].join(" + ");
    })();
    try {
      let prevVoiceUsed = "";
      const { data: prevManifest } = await admin.storage
        .from("videos")
        .download(`${userId}/jobs/${job.id}/media-manifest.json`);
      if (prevManifest) {
        const prev = JSON.parse(await prevManifest.text()) as { voiceUsed?: string };
        prevVoiceUsed = prev?.voiceUsed ?? "";
      }
      const manifest = {
        mode: useGroups ? "groups" : "lines",
        totalLines: total,
        groups: entries,
        voiceUsed: computedVoiceUsed || prevVoiceUsed,
      };
      await uploadFile(
        admin,
        `${userId}/jobs/${job.id}/media-manifest.json`,
        new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        "application/json",
      );
    } catch {
      // Bookkeeping only — the audio files themselves are the real state.
    }
    if (voiceHave >= total) {
      if (useGroups) {
        // Count the two kinds of coverage honestly: finished group
        // recordings vs lines covered by single-line recordings.
        const gCount = units.filter((u) => coverageOf(u) === "group").length;
        const lLines = units
          .filter((u) => coverageOf(u) === "lines")
          .reduce((n, u) => n + (u.to - u.from + 1), 0);
        const coverParts: string[] = [];
        if (gCount > 0) coverParts.push(`${gCount} group recordings`);
        if (lLines > 0) coverParts.push(`${lLines} single-line recordings`);
        const head = madeThisRun > 0 ? "Voice done" : "Voice ready";
        markDone(
          "Voice",
          singleLabel
            ? `${head}: ${total} lines in ${coverParts.join(" + ")} (${singleLabel}).`
            : `${head}: ${total} lines in ${coverParts.join(" + ")} — ${mixedText}.`,
        );
      } else if (singleLabel === edgeLabel) {
        markDone(
          "Voice",
          madeThisRun > 0
            ? `Voice recorded (${edgeLabel}): ${total} lines — one audio file per script line.`
            : `Voice ready: ${total} lines — one audio file per script line (${edgeLabel}).`,
        );
      } else if (singleLabel) {
        markDone(
          "Voice",
          madeThisRun > 0
            ? `Voice recorded (${singleLabel}): ${total} lines — one audio file per script line, voice "${geminiVoiceName}".`
            : `Voice ready: ${total} lines — one audio file per script line (${singleLabel}, voice "${geminiVoiceName}").`,
        );
      } else {
        markDone(
          "Voice",
          madeThisRun > 0
            ? `Voice recorded: ${total} lines — one audio file per script line (${mixedText}).`
            : `Voice ready: ${total} lines — one audio file per script line (${mixedText}).`,
        );
      }
    } else if (unitFailed) {
      const note = `Voice: ${voiceHave} of ${total} lines made. ${detailsNote(errs)}`;
      markTodo("Voice", note);
      firstFailure = firstFailure ?? note;
    } else if (stopped) {
      markTodo(
        "Voice",
        `Voice: ${voiceHave} of ${total} lines made — run again to continue.`,
      );
    }
    await saveSteps();
  }

  // ================= STEP: PROMPTS =================
  const promptsStep = stepOf("Prompts");
  if (promptsStep && promptsStep.state !== "done") {
    try {
      await uploadFile(
        admin,
        `${userId}/jobs/${job.id}/prompts.json`,
        new TextEncoder().encode(JSON.stringify(scenePrompts, null, 2)),
        "application/json",
      );
      markDone(
        "Prompts",
        niche
          ? `Prompts locked: ${total} scenes — the niche card's style and character words are in every prompt.`
          : `Prompts made: ${total} scenes (no niche card — a plain default style was used).`,
      );
    } catch (e) {
      const note = `Prompts could not be saved: ${msg(e)}`;
      markTodo("Prompts", note);
      firstFailure = firstFailure ?? note;
    }
    await saveSteps();
  }

  // ================= STEP: VISUALS =================
  let imgHave = 0;
  const visualsStep = stepOf("Visuals");
  if (visualsStep && visualsStep.state === "done") {
    imgHave = total;
  } else if (visualsStep) {
    const prefix = `${userId}/jobs/${job.id}/images`;
    const existing = await listNames(admin, prefix);
    for (let i = 1; i <= total; i++) if (existing.has(`scene-${pad3(i)}.png`)) imgHave++;
    const aspect =
      job.kind === "short" || /9:16/.test(settings.format ?? "") ? "9:16" : "16:9";
    const errs: string[] = [];
    let imgUsed = "";
    let sceneFailed = false;
    let stopped = false;
    for (let i = 1; i <= total; i++) {
      const name = `scene-${pad3(i)}.png`;
      if (existing.has(name)) continue;
      if (outOfTime()) {
        stopped = true;
        break;
      }
      let made = false;
      for (const cand of candidates) {
        if (deadKeys.img.has(cand.id)) {
          noteDead("img", cand, errs);
          continue;
        }
        let models: string[];
        try {
          models = imageModels(await modelsFor(cand));
        } catch (e) {
          const m = msg(e);
          errs.push(`${cand.label}: ${m}`);
          if (isKeyKiller(m)) killKey("img", cand, m);
          continue;
        }
        if (models.length === 0) {
          errs.push(`${cand.label}: this key has no picture (Nano Banana) model`);
          continue;
        }
        for (const model of models) {
          try {
            const { bytes, mime } = await imageOnce(
              cand.key,
              model,
              scenePrompts[i - 1].prompt,
              aspect,
            );
            await uploadFile(admin, `${prefix}/${name}`, bytes, mime || "image/png");
            existing.add(name);
            imgHave++;
            imgUsed = cand.label;
            made = true;
            break;
          } catch (e) {
            const m = msg(e);
            errs.push(m.startsWith("saving a file failed") ? m : `${cand.label}: ${m}`);
            if (isKeyKiller(m)) {
              killKey("img", cand, m);
              break;
            }
          }
        }
        if (made) break;
      }
      if (!made) {
        sceneFailed = true;
        break;
      }
    }
    if (imgHave >= total) {
      markDone(
        "Visuals",
        imgUsed
          ? `Pictures made (${imgUsed}): ${total} scenes — one picture per script line, same style and character throughout.`
          : `Pictures ready: ${total} scenes — one picture per script line.`,
      );
    } else if (sceneFailed) {
      if (candidates.length === 0) {
        // Pictures run on the owner's Gemini keys only — there is no
        // keyless picture provider. Say so plainly instead of dressing
        // it up as a model failure.
        const note =
          "No Gemini key is ready. Add a free Gemini API key in My Connections (Visuals pool) — pictures run on your own keys only.";
        markTodo("Visuals", note);
        firstFailure = firstFailure ?? note;
      } else {
        if (errs.length === 0) {
          errs.push("no Gemini key answered a picture call in this run");
        }
        const note = `Visuals: ${imgHave} of ${total} pictures made. ${detailsNote(errs)}`;
        markTodo("Visuals", note);
        firstFailure = firstFailure ?? note;
      }
    } else if (stopped) {
      markTodo(
        "Visuals",
        `Visuals: ${imgHave} of ${total} pictures made — run again to continue.`,
      );
    }
    await saveSteps();
  }

  // ================= Result =================
  const vDone = stepOf("Voice")?.state === "done";
  const pDone = stepOf("Prompts")?.state === "done";
  const iDone = stepOf("Visuals")?.state === "done";
  if (vDone && pDone && iDone) {
    return json({ ok: true, done: true, voice_lines: total, scenes: total });
  }
  if (vDone || pDone || iDone) {
    return json({
      ok: true,
      partial: true,
      voice: `${voiceHave}/${total}`,
      images: `${imgHave}/${total}`,
    });
  }
  return json({
    ok: false,
    error: `The media steps could not run: ${firstFailure ?? "no media account answered"}`,
  }, 502);
});
