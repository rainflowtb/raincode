import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { allowFileRoot } from "@/lib/file-access";

// POST /api/default-cwd
// Creates ~/raincode-<YYYYMMDD-HHMMSS-xxxx> if it doesn't exist and returns the path.
export async function POST() {
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const suffix = randomBytes(2).toString("hex");
    const dir = join(homedir(), `raincode-${ts}-${suffix}`);
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
