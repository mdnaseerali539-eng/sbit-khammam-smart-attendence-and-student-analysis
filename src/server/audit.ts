import { db } from '../db/index.ts';
import { auditLogs } from '../db/schema.ts';

export interface AuditEntry {
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorId: entry.actorId ?? null,
      actorEmail: entry.actorEmail ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      details: entry.details ?? {},
      ipAddress: entry.ipAddress ?? null,
    });
  } catch (err) {
    console.error('Audit log insert failed:', err);
  }
}
