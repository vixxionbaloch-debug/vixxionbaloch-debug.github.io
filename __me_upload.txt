// Sanj Studio — Media Engine, Part 2: Voice, Prompts, Visuals (Edge Function)
// Called by the Studio after the Big Brain (job-engine) has written the
// script for a job. Uses the JOB OWNER'S OWN saved Gemini API keys — pools
// in this order: Visuals, Writer, Brain (the Antigravity login token is
// NOT an API key and is never tried as one):
//   4 Voice   — Gemini TTS, one WAV file per script line, in the owner's
//               private "videos" bucket: <uid>/jobs/<jobId>/audio/line-NNN.wav
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
  const joined = [...new Set(errs)].join(" | ").slice(0, 700) || "no media account answered";
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
// voice the owner named). Gemini TTS needs a prebuilt voice name: take the
// first clean word; anything unusable falls back to "Charon".
function pickVoiceName(...raw: (string | null | undefined)[]): string {
  for (const r of raw) {
    const s = (r ?? "").trim();
    if (!s || /^auto$/i.test(s)) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]{1,30}$/.test(s)) return s;
    const first = s.split(/\s+/)[0];
    if (/^[A-Za-z][A-Za-z0-9_-]{1,30}$/.test(first)) return first;
  }
  return "Charon";
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

  // No keys at all: Prompts need no key, so still make them, then say
  // plainly why Voice and Visuals cannot run.
  if (candidates.length === 0) {
    if (stepOf("Prompts") && stepOf("Prompts")!.state !== "done") {
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
        markTodo("Prompts", `Prompts could not be saved: ${msg(e)}`);
      }
    }
    const noKeyNote =
      "No Gemini key is ready. Add a free Gemini API key in My Connections (Visuals pool) — voice and pictures run on your own keys only.";
    if (stepOf("Voice") && stepOf("Voice")!.state !== "done") markTodo("Voice", noKeyNote);
    if (stepOf("Visuals") && stepOf("Visuals")!.state !== "done") markTodo("Visuals", noKeyNote);
    await saveSteps();
    return json({
      ok: false,
      error: "No media account is ready. Add a free Gemini API key in My Connections (Visuals pool) first.",
    }, 400);
  }

  // Per-run helpers: model lists are cached per key; a key that hits a
  // quota / invalid-key answer is dead for the rest of the run.
  const modelCache = new Map<string, string[]>();
  const deadKeys = new Set<string>();
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
    for (let i = 1; i <= total; i++) if (existing.has(`line-${pad3(i)}.wav`)) voiceHave++;
    const voiceName = pickVoiceName(settings.voice, niche?.voice);
    const errs: string[] = [];
    let voiceUsed = "";
    let lineFailed = false;
    let stopped = false;
    for (let i = 1; i <= total; i++) {
      const name = `line-${pad3(i)}.wav`;
      if (existing.has(name)) continue;
      if (outOfTime()) {
        stopped = true;
        break;
      }
      let made = false;
      for (const cand of candidates) {
        if (deadKeys.has(cand.id)) continue;
        let models: string[];
        try {
          models = ttsModels(await modelsFor(cand));
        } catch (e) {
          const m = msg(e);
          errs.push(`${cand.label}: ${m}`);
          if (isKeyKiller(m)) deadKeys.add(cand.id);
          continue;
        }
        if (models.length === 0) {
          errs.push(`${cand.label}: this key has no speech (TTS) model`);
          continue;
        }
        for (const model of models) {
          try {
            const { pcm, rate } = await ttsOnce(cand.key, model, lines[i - 1], voiceName);
            await uploadFile(admin, `${prefix}/${name}`, pcmToWav(pcm, rate), "audio/wav");
            existing.add(name);
            voiceHave++;
            voiceUsed = cand.label;
            made = true;
            break;
          } catch (e) {
            const m = msg(e);
            errs.push(m.startsWith("saving a file failed") ? m : `${cand.label}: ${m}`);
            if (isKeyKiller(m)) {
              deadKeys.add(cand.id);
              break;
            }
          }
        }
        if (made) break;
      }
      if (!made) {
        lineFailed = true;
        break;
      }
    }
    if (voiceHave >= total) {
      markDone(
        "Voice",
        voiceUsed
          ? `Voice recorded (${voiceUsed}): ${total} lines — one audio file per script line, voice "${voiceName}".`
          : `Voice ready: ${total} lines — one audio file per script line.`,
      );
    } else if (lineFailed) {
      const note = detailsNote(errs);
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
        if (deadKeys.has(cand.id)) continue;
        let models: string[];
        try {
          models = imageModels(await modelsFor(cand));
        } catch (e) {
          const m = msg(e);
          errs.push(`${cand.label}: ${m}`);
          if (isKeyKiller(m)) deadKeys.add(cand.id);
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
              deadKeys.add(cand.id);
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
      const note = detailsNote(errs);
      markTodo("Visuals", note);
      firstFailure = firstFailure ?? note;
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
