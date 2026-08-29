import { NextRequest, NextResponse } from "next/server";
import {
  deleteSubagent,
  getAgentsDirForScope,
  listSubagents,
  setSubagentEnabled,
  upsertSubagent,
  validateSubagentPayload,
} from "@/lib/subagent-files";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { resolve } from "path";
import { stat } from "fs/promises";

export const dynamic = "force-dynamic";

/** Throws 403 outside allowed roots; returns null for empty input. */
async function resolveCwd(raw: string | null | undefined): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  const cwd = resolve(raw.trim());
  try {
    if (!(await stat(cwd)).isDirectory()) return null;
  } catch {
    return null;
  }
  const roots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, roots)) {
    throw Object.assign(new Error("Access denied for cwd"), { status: 403 });
  }
  return cwd;
}

function parseScope(raw: unknown): "user" | "project" | null {
  return raw === "user" || raw === "project" ? raw : null;
}

function errorStatus(error: unknown): number {
  if (typeof error === "object" && error && "status" in error) {
    return Number((error as { status?: number }).status) || 500;
  }
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const cwd = await resolveCwd(req.nextUrl.searchParams.get("cwd"));
    return NextResponse.json(listSubagents(cwd));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: errorStatus(error) },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const scope = parseScope(body.scope);
    if (!scope) {
      return NextResponse.json({ error: "scope must be \"user\" or \"project\"" }, { status: 400 });
    }
    const cwd = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
    if (scope === "project" && !cwd) {
      return NextResponse.json({ error: "project scope requires cwd" }, { status: 400 });
    }
    const existingName = typeof body.originalName === "string" && body.originalName.trim()
      ? body.originalName.trim()
      : null;
    let existing;
    if (existingName) {
      const list = listSubagents(cwd);
      const pool = scope === "user" ? list.user : list.project;
      existing = pool.find((item) => item.name === existingName);
      if (!existing) {
        return NextResponse.json({ error: "agent not found in this scope" }, { status: 404 });
      }
    }
    const result = validateSubagentPayload(body, existing);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const def = upsertSubagent(result.def, scope, cwd);
    return NextResponse.json({
      agent: { ...def, scope, sourcePath: getAgentsDirForScope(scope, cwd) },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: errorStatus(error) },
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled boolean required" }, { status: 400 });
    }
    const scope = parseScope(body.scope);
    if (!scope) return NextResponse.json({ error: "scope must be \"user\" or \"project\"" }, { status: 400 });
    const cwd = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
    const def = setSubagentEnabled(name, body.enabled, scope, cwd);
    if (!def) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    return NextResponse.json({ agent: { ...def, scope, sourcePath: getAgentsDirForScope(scope, cwd) } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: errorStatus(error) },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const scope = parseScope(body.scope);
    if (!scope) return NextResponse.json({ error: "scope must be \"user\" or \"project\"" }, { status: 400 });
    const cwd = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
    const removed = deleteSubagent(name, scope, cwd);
    if (!removed) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: errorStatus(error) },
    );
  }
}
