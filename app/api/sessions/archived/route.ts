import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { deleteSessionById, SessionNotFoundError } from "@/lib/session-delete";

/**
 * DELETE /api/sessions/archived — permanently delete every soft-archived
 * session (Settings → Archived → Delete all). Fresh-lists archived sessions so
 * the batch always reflects disk, then deletes each through the same
 * deleteSessionById path as the per-session DELETE route.
 *
 * Heavy runtime only: deleteSessionById needs the RPC registry. `/api/sessions`
 * is a LIGHT_EXACT match but `/api/sessions/archived` is a distinct path that
 * falls through to heavy (see electron/runtime-host.js).
 */
export async function DELETE() {
  try {
    const sessions = await listAllSessions({ force: true, archivedOnly: true });
    let deleted = 0;
    for (const session of sessions) {
      try {
        await deleteSessionById(session.id);
        deleted++;
      } catch (error) {
        // A session archived in the list then removed before its turn is not a
        // failure of this batch — skip it and keep going. Anything else must
        // surface so a partial delete is never reported as clean.
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
    }
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
