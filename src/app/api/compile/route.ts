// Simple compile/execute endpoint for C++ using the public Piston API.
// WARNING: For demo use only. Do NOT expose to untrusted traffic without rate limits/auth.
// Docs: https://github.com/engineer-man/piston
import { NextResponse } from "next/server";

export const runtime = "nodejs"; // ensure Node runtime (not Edge) for outbound fetch and AbortController

type ExecuteRequest = {
  language?: string; // defaults to C++
  code: string;
  stdin?: string;
  args?: string[];
  version?: string;
};

export async function POST(req: Request) {
  let body: ExecuteRequest;
  try {
    body = (await req.json()) as ExecuteRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }
  const langRaw = (body.language || "").toLowerCase().trim();
  // Map common aliases to Piston identifiers
  let language = "cpp"; // default to C++
  if (langRaw) {
    if (langRaw === "c++" || langRaw === "cpp" || langRaw === "g++")
      language = "cpp";
    else language = langRaw;
  }
  const version =
    typeof body.version === "string" && body.version.trim()
      ? body.version.trim()
      : "*";
  const code = body.code ?? "";
  const stdin = body.stdin ?? "";
  const args = Array.isArray(body.args) ? body.args.slice(0, 16) : [];

  if (!code || typeof code !== "string" || code.length > 100_000) {
    return NextResponse.json(
      { ok: false, error: "Provide code (<= 100kB)" },
      { status: 400 }
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000); // 12s hard timeout
  try {
    async function execute(lang: string, ver: string) {
      return fetch("https://emkc.org/api/v2/piston/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          language: lang,
          version: ver,
          files: [{ name: "main.cpp", content: code }],
          stdin,
          args,
        }),
      });
    }
    let res = await execute(language, version);
    if (!res.ok && res.status === 400) {
      // Query runtimes to get an exact version and retry once
      const rt = await fetch("https://emkc.org/api/v2/piston/runtimes", {
        signal: controller.signal,
      });
      if (rt.ok) {
        const runtimes: Array<{
          language: string;
          version: string;
          aliases?: string[];
        }> = await rt.json();
        const match = runtimes.find(
          (r) => r.language === language || (r.aliases || []).includes(language)
        );
        if (match) {
          res = await execute(match.language, match.version);
        }
      }
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          error: `Upstream error (${res.status})`,
          details: text.slice(0, 2000),
        },
        { status: res.status }
      );
    }
    const data: {
      compile?: { stdout?: string; stderr?: string };
      run?: { stdout?: string; stderr?: string; code?: number; time?: number };
    } = await res.json();
    // Normalize output payload
    const out = [data.compile?.stdout, data.run?.stdout]
      .filter(Boolean)
      .join("");
    const err = [data.compile?.stderr, data.run?.stderr]
      .filter(Boolean)
      .join("");
    return NextResponse.json({
      ok: true,
      language,
      stdout: String(out || ""),
      stderr: String(err || ""),
      code: Number(data.run?.code ?? 0),
      time: data.run?.time ?? null,
    });
  } catch (e: unknown) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return NextResponse.json(
      { ok: false, error: aborted ? "Execution timed out" : "Request failed" },
      { status: 504 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
