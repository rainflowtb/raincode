import { NextRequest, NextResponse } from "next/server";
import {
  deleteHook,
  getHooksPathForScope,
  getUserHooksPath,
  getProjectHooksPath,
  listHooks,
  setHookEnabled,
  upsertHook,
  validateHookPayload,
  type HookScope,
} from "@/lib/hooks-config";
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

function parseScope(raw: unknown): HookScope | null {
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
    return NextResponse.json({
      hooks: listHooks(cwd),
      paths: {
        user: getUserHooksPath(),
        ...(cwd ? { project: getProjectHooksPath(cwd) } : {}),
      },
    });
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
    const existingId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
    const existing = existingId
      ? listHooks(cwd).find((h) => h.id === existingId && h.scope === scope)
      : undefined;
    const result = validateHookPayload(body, existing);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (existingId && !existing) {
      return NextResponse.json({ error: "hook not found in this scope" }, { status: 404 });
    }
    const hook = upsertHook(result.hook, scope, cwd);
    return NextResponse.json({ hook: { ...hook, scope, sourcePath: getHooksPathForScope(scope, cwd) } });
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
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled boolean required" }, { status: 400 });
    }
    const scope = parseScope(body.scope);
    if (!scope) return NextResponse.json({ error: "scope must be \"user\" or \"project\"" }, { status: 400 });
    const cwd = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
    const hook = setHookEnabled(id, body.enabled, scope, cwd);
    if (!hook) return NextResponse.json({ error: "hook not found" }, { status: 404 });
    return NextResponse.json({ hook: { ...hook, scope, sourcePath: getHooksPathForScope(scope, cwd) } });
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
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const scope = parseScope(body.scope);
    if (!scope) return NextResponse.json({ error: "scope must be \"user\" or \"project\"" }, { status: 400 });
    const cwd = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
    const removed = deleteHook(id, scope, cwd);
    if (!removed) return NextResponse.json({ error: "hook not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: errorStatus(error) },
    );
  }
}
