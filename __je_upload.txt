// Sanj Studio — Job Engine, Part 1: the Big Brain writer (Edge Function)
// Called by the Studio when a job starts. Uses the JOB OWNER'S OWN
// Antigravity account (Big Brain pool) to do the first three steps for real:
//   1 Research — read the source, gather facts and angles
//   2 Summary  — the main point, best facts, the new angle
//   3 Script   — a full ORIGINAL narration script, saved into Scripts
// Free: it runs on the owner's own connected Antigravity account.
// Nothing is faked: a step is marked done only after its text exists.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const AG_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

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

async function genText(
  accessToken: string,
  project: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const models = ["gemini-2.5-flash", "gemini-2.5-pro"];
  let lastErr = "the brain did not answer";
  for (const model of models) {
    const res = await fetch(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity/1.5.0 (linux)",
        },
        body: JSON.stringify({
          model,
          project,
          request: {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
          },
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      lastErr = msg;
      continue;
    }
    const resp = (data as { response?: unknown }).response ?? data;
    const candidates =
      (resp as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
        .candidates ?? [];
    const text = (candidates[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (text) return text;
    lastErr = "the brain answered empty";
  }
  throw new Error(lastErr);
}

async function geminiGen(
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  // Never guess model names: ask Google which models THIS key can use.
  const lr = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );
  const ld = await lr.json().catch(() => ({}));
  if (!lr.ok) {
    const msg =
      (ld as { error?: { message?: string } })?.error?.message ?? `HTTP ${lr.status}`;
    throw new Error(`key check failed: ${msg}`);
  }
  const allModels = ((ld as { models?: unknown }).models ?? []) as {
    name?: string;
    supportedGenerationMethods?: string[];
  }[];
  const usable = allModels
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => (m.name ?? "").replace(/^models\//, ""))
    .filter((n) => n && !/image|banana|tts|embedding|aqa|robotics|computer-use/i.test(n));
  // Steady versioned models first; "-latest" aliases last — they overload first.
  const rank = (n: string) => {
    const latest = /latest/i.test(n) ? 2 : 0;
    if (/flash/i.test(n)) return latest;
    return latest + 1;
  };
  const models = usable.sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  if (models.length === 0) {
    throw new Error(
      "This Gemini key sees no writing models. The key may be wrong, or the Gemini API is not switched on for its project.",
    );
  }
  const merrs: string[] = [];
  for (const model of models) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      merrs.push(`${model}: ${msg}`);
      continue;
    }
    const candidates =
      (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
        .candidates ?? [];
    const text = (candidates[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (text) return text;
    merrs.push(`${model}: answered empty`);
  }
  throw new Error(merrs.join("; ").slice(0, 380) || "the Gemini key did not answer");
}

function friendlyError(raw: string): string {
  if (/high demand|overloaded/i.test(raw)) {
    return "Google's writing models are overloaded right now (high demand). This is temporary and usually clears in a short while — the tool already waited and retried once. Run the job again a bit later.";
  }
  const hasModelProblem = /not found|not supported|no writing models/i.test(raw);
  if (!hasModelProblem && /resource has been exhausted|quota|RESOURCE_EXHAUSTED/i.test(raw)) {
    return "Google's free writing limit for this account is used up for now. It resets daily. Tip: add a free Gemini API key in My Connections (Writer pool) and the tool will write with that instead.";
  }
  if (!hasModelProblem && /API key not valid|API_KEY_INVALID/i.test(raw)) {
    return "A saved API key is not valid. Add the right key again in My Connections.";
  }
  return raw;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const agSecret = Deno.env.get("ANTIGRAVITY_CLIENT_SECRET");
  if (!agSecret) {
    return json({ ok: false, error: "The Big Brain is not set up on the server yet." }, 500);
  }

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
  const language =
    settings.language && settings.language !== "" ? settings.language : "English";

  // Writing providers, in order: (A) the owner's Antigravity (Big Brain)
  // account, (B) any saved API key in the Brain or Writer pool (Gemini).
  let ag: { accessToken: string; project: string; label: string } | null = null;
  const keyCandidates: { label: string; key: string }[] = [];

  const { data: conns } = await admin
    .from("connections")
    .select("id, label, email")
    .eq("owner_id", userId)
    .eq("pool", "brain")
    .eq("status", "ready")
    .order("created_at", { ascending: true })
    .limit(1);
  if (conns && conns.length > 0) {
    const { data: secret } = await admin
      .from("connection_secrets")
      .select("refresh_token")
      .eq("connection_id", conns[0].id)
      .single();
    if (secret?.refresh_token) {
      try {
        const tokRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: AG_CLIENT_ID,
            client_secret: agSecret,
            refresh_token: secret.refresh_token,
            grant_type: "refresh_token",
          }),
        });
        const tok = await tokRes.json().catch(() => ({}));
        if (tokRes.ok && tok.access_token) {
          const lcRes = await fetch(
            "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${tok.access_token}`,
                "Content-Type": "application/json",
                "User-Agent": "antigravity/1.5.0 (linux)",
              },
              body: JSON.stringify({
                metadata: { ideType: "ANTIGRAVITY", ideName: "Antigravity", ideVersion: "1.5.0" },
              }),
            },
          );
          const lc = await lcRes.json().catch(() => ({}));
          const p = lc?.cloudaicompanionProject;
          const proj = typeof p === "string" ? p : (p?.id ?? "");
          if (proj) {
            ag = { accessToken: tok.access_token as string, project: proj, label: conns[0].label };
          }
        }
      } catch {
        ag = null;
      }
    }
  }

  const agConnId = conns && conns.length > 0 ? conns[0].id : null;

  const { data: keyConns } = await admin
    .from("connections")
    .select("id, label, pool")
    .eq("owner_id", userId)
    .in("pool", ["brain", "writer"])
    .eq("status", "ready")
    .order("created_at", { ascending: true });
  for (const kc of keyConns ?? []) {
    if (agConnId && kc.id === agConnId) continue; // the Antigravity login token is not an API key — never try it as one
    const { data: s } = await admin
      .from("connection_secrets")
      .select("refresh_token")
      .eq("connection_id", kc.id)
      .single();
    if (s?.refresh_token) keyCandidates.push({ label: kc.label, key: s.refresh_token });
  }

  if (!ag && keyCandidates.length === 0) {
    return json({
      ok: false,
      error: "No writing account is ready. Connect the Big Brain (Antigravity) or add a free Gemini API key in My Connections first.",
    }, 400);
  }

  let usedLabel = ag?.label ?? "";
  let agDead = false;
  const deadKeys = new Set<string>();
  const attempt = async (prompt: string, maxTokens: number): Promise<string> => {
    const errs: string[] = [];
    if (ag && !agDead) {
      try {
        const t = await genText(ag.accessToken, ag.project, prompt, maxTokens);
        usedLabel = ag.label;
        return t;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        errs.push(`${ag.label}: ${m}`);
        if (/resource has been exhausted|quota|RESOURCE_EXHAUSTED/i.test(m)) agDead = true;
      }
    }
    for (const kc of keyCandidates) {
      if (deadKeys.has(kc.label)) continue;
      try {
        const t = await geminiGen(kc.key, prompt, maxTokens);
        usedLabel = kc.label;
        return t;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        errs.push(`${kc.label}: ${m}`);
        if (/resource has been exhausted|quota|RESOURCE_EXHAUSTED|API key not valid|API_KEY_INVALID|key check failed/i.test(m)) {
          deadKeys.add(kc.label);
        }
      }
    }
    throw new Error(errs.join(" | ").slice(0, 700) || "no writer answered");
  };
  const generate = async (prompt: string, maxTokens: number): Promise<string> => {
    try {
      return await attempt(prompt, maxTokens);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // Google overload ("high demand") is temporary: wait, then one more full pass.
      if (/high demand|overloaded|UNAVAILABLE/i.test(m) && !/API key not valid/i.test(m)) {
        await new Promise((r) => setTimeout(r, 20000));
        try {
          return await attempt(prompt, maxTokens);
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          const friendly2 = friendlyError(m2);
          throw new Error(friendly2 === m2 ? m2 : `${friendly2} Details: ${m2}`);
        }
      }
      const friendly = friendlyError(m);
      throw new Error(friendly === m ? m : `${friendly} Details: ${m}`);
    }
  };

  // Real facts about the source video, when the source is a YouTube link.
  let factsBlock = "";
  let sourceMinutes = 0;
  const ytKey = Deno.env.get("YOUTUBE_API_KEY");
  const vidMatch = String(job.source ?? "").match(
    /(?:v=|youtu\.be\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/,
  );
  if (ytKey && vidMatch) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${vidMatch[1]}&key=${ytKey}`,
      );
      const d = await r.json().catch(() => ({}));
      const it = (d.items ?? [])[0];
      if (it) {
        const durM = String(it.contentDetails?.duration ?? "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (durM) sourceMinutes = Math.max(1, Math.round(((+durM[1] || 0) * 3600 + (+durM[2] || 0) * 60 + (+durM[3] || 0)) / 60));
        factsBlock =
          `\nReal facts about the source video (from YouTube): title "${it.snippet.title}", ` +
          `channel "${it.snippet.channelTitle}", views ${it.statistics.viewCount}, ` +
          `published ${String(it.snippet.publishedAt).slice(0, 10)}. ` +
          `Description starts: ${String(it.snippet.description ?? "").slice(0, 600)}`;
      }
    } catch {
      factsBlock = "";
    }
  }

  // The owner's niche card, when the job names one.
  let nicheBlock = "";
  if (settings.niche) {
    const { data: niches } = await admin
      .from("niches")
      .select("name, language, style, character_desc, voice, script_dna")
      .eq("owner_id", userId)
      .eq("name", settings.niche)
      .limit(1);
    const n = (niches ?? [])[0];
    if (n) {
      const dna =
        typeof n.script_dna === "string"
          ? n.script_dna
          : JSON.stringify(n.script_dna ?? "");
      nicheBlock =
        `\nNiche card "${n.name}": style — ${n.style ?? ""}; character — ${n.character_desc ?? ""}; ` +
        `voice — ${n.voice ?? ""}; script DNA — ${dna}`;
    }
  }

  // Target length: the job's setting first; "Same as source" (or a setting
  // with no minutes in it) means the source video's real length.
  const lengthText = settings.length ?? "Same as source";
  let minutes = 0;
  const mNum = lengthText.match(/(\d+)\s*min/);
  if (mNum) minutes = Math.max(1, parseInt(mNum[1], 10));
  if (!minutes && sourceMinutes > 0) minutes = sourceMinutes;
  if (!minutes) minutes = 10;
  if (job.kind === "short") minutes = 1;
  const isJa = language === "Japanese";
  const targetTotal = isJa ? Math.round(minutes * 300) : Math.round(minutes * 150 * 6);
  const sizeGuide = isJa
    ? `about ${targetTotal} Japanese characters`
    : `about ${Math.round(minutes * 150)} words (about ${targetTotal} characters)`;

  const base =
    `Job title: ${job.title}\nSource: ${job.source ?? ""}\nVideo kind: ${job.kind}\n` +
    `Language of the video: ${language}${factsBlock}${nicheBlock}`;

  try {
    // Step 1 — Research
    const research = await generate(
      `You are the research brain of a video studio. Research this video job and return plain text with: the main facts (only facts you are confident are true; mark anything unsure as "check before use"), why viewers care, the 3 strongest angles, and what a fresh ORIGINAL video should do differently from the source. Never plan a copy of the source.\n\n${base}`,
      4000,
    );

    // Step 2 — Summary
    const summary = await generate(
      `Write a short summary (6-8 lines, plain text) for the script writer: the main point, the best facts to use, the new original angle, and one strong hook line for the first 10 seconds. Write in ${language}.\n\nRESEARCH:\n${research}\n\n${base}`,
      1500,
    );

    // Step 3 — Script. A single call stops early on long targets, so long
    // scripts are written part by part until the target length is reached.
    const scriptRules =
      `One line per spoken sentence (each line becomes one visual). Rules: simple clear words; keep a steady story flow with no long gaps; the video is ORIGINAL — never copy the source's words or order; no stage directions, no timestamps, no speaker labels — narration lines only.`;
    let script = "";
    if (targetTotal <= 4500) {
      script = await generate(
        `Write the FULL narration script for an original video, in ${language}. ${scriptRules} Also: a strong hook in the first 2 lines; length ${sizeGuide}; finish with one fresh, original closing line that asks viewers to like the video, subscribe to the channel, and leave a comment (write it new, in ${language}).\n\nSUMMARY:\n${summary}\n\nRESEARCH:\n${research.slice(0, 6000)}\n\n${base}`,
        30000,
      );
    } else {
      const chunkTarget = 4000;
      const totalParts = Math.min(8, Math.ceil(targetTotal / chunkTarget));
      for (let part = 1; part <= totalParts; part++) {
        const isLast = part === totalParts;
        const partPrompt = part === 1
          ? `Write the narration script for an original video, in ${language}. This is PART 1 of ${totalParts}: write about ${chunkTarget} characters now (the full script will be ${sizeGuide}). Start with a strong hook in the first 2 lines. Do NOT write a closing line yet — the story continues in the next part. ${scriptRules}\n\nSUMMARY:\n${summary}\n\nRESEARCH:\n${research.slice(0, 6000)}\n\n${base}`
          : `Continue the narration script, in ${language}. This is PART ${part} of ${totalParts}: write about ${chunkTarget} more characters, continuing seamlessly from the exact point where the text below stops — no recap, no repetition, no new introduction. ${isLast ? "This is the FINAL part: bring the story to its end and finish with one fresh, original closing line that asks viewers to like the video, subscribe to the channel, and leave a comment (write it new, in " + language + ")." : "Do NOT write a closing line yet — the story continues."} ${scriptRules}\n\nTHE SCRIPT SO FAR ENDS WITH:\n${script.slice(-900)}`;
        const piece = await generate(partPrompt, 30000);
        script = script ? `${script}\n${piece.trim()}` : piece.trim();
        if (script.length >= targetTotal * 0.92) break;
      }
    }

    const lines = script.split("\n").map((s) => s.trim()).filter(Boolean);
    const endLine = lines.length > 0 ? lines[lines.length - 1] : "";

    const { data: scriptRow, error: scriptErr } = await admin
      .from("scripts")
      .insert({
        owner_id: userId,
        title: job.title,
        body: script,
        pack: { title: job.title },
        end_line: endLine,
        job_id: job.id,
      })
      .select("id")
      .single();
    if (scriptErr || !scriptRow) {
      return json({ ok: false, error: "The script was written but saving it failed." }, 500);
    }

    const steps = ((job.steps ?? []) as Step[]).map((s) => ({ ...s }));
    const setStep = (name: string, note: string) => {
      const st = steps.find((x) => x.name === name);
      if (st) {
        st.state = "done";
        st.note = note;
      }
    };
    setStep("Research", `Read by the Big Brain (${usedLabel}). Facts and angles saved.`);
    setStep("Summary", summary.split("\n").filter(Boolean)[0]?.slice(0, 240) ?? "Summary saved.");
    setStep("Script", `Original script written by the Big Brain (${lines.length} lines) and saved in Scripts.`);
    const voice = steps.find((x) => x.name === "Voice");
    if (voice && voice.state === "todo") voice.state = "now";
    const doneCount = steps.filter((x) => x.state === "done").length;
    const progress = Math.round((doneCount / Math.max(1, steps.length)) * 100);

    await admin
      .from("jobs")
      .update({ steps, progress, status: "making" })
      .eq("id", job.id);

    return json({
      ok: true,
      script_id: scriptRow.id,
      lines: lines.length,
      chars: script.length,
      research_chars: research.length,
    });
  } catch (e) {
    return json({
      ok: false,
      error: `The Big Brain could not write this job: ${e instanceof Error ? e.message : "unknown error"}`,
    }, 502);
  }
});
