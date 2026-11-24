import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  attendanceSessions,
  calendarOverrides,
  classes,
  collegeSettings,
  departments,
  holidays,
} from '../db/schema.ts';
import { getISTDateString, getISTTimeString } from './crypto.ts';

export const DEFAULT_MORNING_START = '09:00';
export const DEFAULT_MORNING_END = '09:40';
export const DEFAULT_AFTERNOON_START = '13:30';
export const DEFAULT_AFTERNOON_END = '13:40';
export const DEFAULT_WORKING_WEEKDAYS = [1, 2, 3, 4, 5, 6]; // Monday to Saturday

export interface HolidayLike {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  reason: string | null;
}

export interface CalendarOverrideLike {
  id: string;
  overrideDate: string;
  overrideType: string; // 'working_day' | 'closed_day'
  title: string;
  reason: string | null;
}

export interface ScheduleSettingsLike {
  autoDailySessionsEnabled?: boolean | null;
  morningStartTime?: string | null;
  morningEndTime?: string | null;
  afternoonStartTime?: string | null;
  afternoonEndTime?: string | null;
  workingWeekdays?: number[] | null;
}

export interface DayScheduleEvaluation {
  dateIST: string;
  weekday: number;
  isHoliday: boolean;
  isWorkingDay: boolean;
  dayStatus: 'holiday' | 'closed_day' | 'special_working_day' | 'working_day' | 'non_working_day';
  holidayTitle: string | null;
  holidayReason: string | null;
  overrideTitle: string | null;
  overrideReason: string | null;
  bannerMessage: string | null;
}

export type SlotLifecycleStatus = 'scheduled' | 'active' | 'closed' | 'cancelled';

export interface DailySlotSummary {
  slot: 'morning' | 'afternoon';
  label: string;
  startTime: string;
  endTime: string;
  startTime12h: string;
  endTime12h: string;
  status: SlotLifecycleStatus;
  canMark: boolean;
  alreadyMarked?: boolean;
  sessionId?: string | null;
  sessionCode?: string | null;
  presentCount?: number;
  totalSessions?: number;
  message: string;
}

export function getISTWeekday(dateStr: string): number {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return 1;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
}

export function formatTime12h(hhmm: string): string {
  const parts = hhmm.split(':').map(Number);
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
    return hhmm;
  }
  const [h24, m] = parts;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function getNormalizedScheduleSettings(settings?: ScheduleSettingsLike | null) {
  const weekdays =
    Array.isArray(settings?.workingWeekdays) && settings.workingWeekdays.length > 0
      ? settings.workingWeekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : DEFAULT_WORKING_WEEKDAYS;

  return {
    autoDailySessionsEnabled: settings?.autoDailySessionsEnabled ?? true,
    morningStartTime: settings?.morningStartTime || DEFAULT_MORNING_START,
    morningEndTime: settings?.morningEndTime || DEFAULT_MORNING_END,
    afternoonStartTime: settings?.afternoonStartTime || DEFAULT_AFTERNOON_START,
    afternoonEndTime: settings?.afternoonEndTime || DEFAULT_AFTERNOON_END,
    workingWeekdays: weekdays.length > 0 ? weekdays : DEFAULT_WORKING_WEEKDAYS,
  };
}

export function evaluateDayScheduleStatus(
  dateIST: string,
  settings: ScheduleSettingsLike | null | undefined,
  holidayRows: HolidayLike[],
  overrideRows: CalendarOverrideLike[]
): DayScheduleEvaluation {
  const norm = getNormalizedScheduleSettings(settings);
  const weekday = getISTWeekday(dateIST);

  const holidayMatch = holidayRows.find((h) => h.startDate <= dateIST && h.endDate >= dateIST);
  if (holidayMatch) {
    return {
      dateIST,
      weekday,
      isHoliday: true,
      isWorkingDay: false,
      dayStatus: 'holiday',
      holidayTitle: holidayMatch.title,
      holidayReason: holidayMatch.reason ?? null,
      overrideTitle: null,
      overrideReason: null,
      bannerMessage: `Today is a holiday: ${holidayMatch.title}. Attendance sessions are unavailable.`,
    };
  }

  const overrideMatch = overrideRows.find((o) => o.overrideDate === dateIST);
  if (overrideMatch) {
    if (overrideMatch.overrideType === 'closed_day') {
      return {
        dateIST,
        weekday,
        isHoliday: false,
        isWorkingDay: false,
        dayStatus: 'closed_day',
        holidayTitle: null,
        holidayReason: null,
        overrideTitle: overrideMatch.title,
        overrideReason: overrideMatch.reason ?? null,
        bannerMessage: `College closed today (${overrideMatch.title}). Attendance sessions are unavailable.`,
      };
    }
    if (overrideMatch.overrideType === 'working_day') {
      return {
        dateIST,
        weekday,
        isHoliday: false,
        isWorkingDay: true,
        dayStatus: 'special_working_day',
        holidayTitle: null,
        holidayReason: null,
        overrideTitle: overrideMatch.title,
        overrideReason: overrideMatch.reason ?? null,
        bannerMessage: null,
      };
    }
  }

  const isScheduledWeekday = norm.workingWeekdays.includes(weekday);
  if (isScheduledWeekday) {
    return {
      dateIST,
      weekday,
      isHoliday: false,
      isWorkingDay: true,
      dayStatus: 'working_day',
      holidayTitle: null,
      holidayReason: null,
      overrideTitle: null,
      overrideReason: null,
      bannerMessage: null,
    };
  }

  return {
    dateIST,
    weekday,
    isHoliday: false,
    isWorkingDay: false,
    dayStatus: 'non_working_day',
    holidayTitle: null,
    holidayReason: 'Configured non-working weekday',
    overrideTitle: null,
    overrideReason: null,
    bannerMessage: 'Today is a non-working day. Attendance sessions are unavailable.',
  };
}

export function computeSlotStatusForTime(
  currentTimeHHMM: string,
  startTime: string,
  endTime: string,
  dayEval: DayScheduleEvaluation
): SlotLifecycleStatus {
  if (dayEval.isHoliday || !dayEval.isWorkingDay) {
    return 'cancelled';
  }
  if (currentTimeHHMM < startTime) {
    return 'scheduled';
  }
  if (currentTimeHHMM >= startTime && currentTimeHHMM < endTime) {
    return 'active';
  }
  return 'closed';
}

export function getStudentSlotMessage(params: {
  slot: 'morning' | 'afternoon';
  status: SlotLifecycleStatus;
  startTime: string;
  dayEval: DayScheduleEvaluation;
  alreadyMarked?: boolean;
}): string {
  if (params.alreadyMarked) {
    return 'Attendance has already been marked for this session.';
  }
  if (params.dayEval.isHoliday && params.dayEval.holidayTitle) {
    return `Today is a holiday: ${params.dayEval.holidayTitle}. Attendance sessions are unavailable.`;
  }
  if (!params.dayEval.isWorkingDay) {
    return params.dayEval.bannerMessage || 'Today is a non-working day. Attendance sessions are unavailable.';
  }
  if (params.status === 'cancelled') {
    return 'No active attendance session is available for your class.';
  }

  const slotLabel = params.slot === 'morning' ? 'Morning' : 'Afternoon';
  if (params.status === 'scheduled') {
    return `${slotLabel} attendance starts at ${formatTime12h(params.startTime)}.`;
  }
  if (params.status === 'closed') {
    return `${slotLabel} attendance session is closed.`;
  }
  return `${slotLabel} attendance session is open now.`;
}

function buildCancellationReason(dayEval: DayScheduleEvaluation): string {
  if (dayEval.isHoliday && dayEval.holidayTitle) {
    return `HOLIDAY: ${dayEval.holidayTitle}`;
  }
  if (dayEval.dayStatus === 'closed_day' && dayEval.overrideTitle) {
    return `CLOSED_DAY: ${dayEval.overrideTitle}`;
  }
  return 'NON_WORKING_DAY';
}

function isAutoSystemCancelReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    reason.startsWith('HOLIDAY:') ||
    reason.startsWith('CLOSED_DAY:') ||
    reason === 'NON_WORKING_DAY'
  );
}

let activeSyncPromise: Promise<SyncDailySessionsResult> | null = null;

export interface SyncDailySessionsResult {
  todayIST: string;
  nowHHMM: string;
  dayEval: DayScheduleEvaluation;
  morningStatus: SlotLifecycleStatus;
  afternoonStatus: SlotLifecycleStatus;
  createdCount: number;
  updatedCount: number;
  cancelledCount: number;
}

async function runSyncAutomaticDailySessions(now: Date): Promise<SyncDailySessionsResult> {
  const todayIST = getISTDateString(now);
  const nowHHMM = getISTTimeString(now);

  const [settingsRow] = await db.select().from(collegeSettings).limit(1);
  const norm = getNormalizedScheduleSettings(settingsRow);
  const [holidayRows, overrideRows, activeDepts, activeClasses] = await Promise.all([
    db.select().from(holidays),
    db.select().from(calendarOverrides),
    db.select().from(departments).where(eq(departments.isActive, true)),
    db.select().from(classes).where(eq(classes.isActive, true)),
  ]);

  const activeDeptIds = new Set(activeDepts.map((d) => d.id));
  const eligibleClasses = activeClasses.filter((c) => activeDeptIds.has(c.departmentId));

  const todayEval = evaluateDayScheduleStatus(todayIST, settingsRow, holidayRows, overrideRows);
  const morningStatus = norm.autoDailySessionsEnabled
    ? computeSlotStatusForTime(nowHHMM, norm.morningStartTime, norm.morningEndTime, todayEval)
    : 'cancelled';
  const afternoonStatus = norm.autoDailySessionsEnabled
    ? computeSlotStatusForTime(nowHHMM, norm.afternoonStartTime, norm.afternoonEndTime, todayEval)
    : 'cancelled';

  let createdCount = 0;
  let updatedCount = 0;
  let cancelledCount = 0;

  // 1. Settle any past-date automatic sessions left scheduled/active across server restarts
  const unclosedPastAuto = await db
    .select({
      id: attendanceSessions.id,
      sessionDate: attendanceSessions.sessionDate,
      status: attendanceSessions.status,
    })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.isAutoScheduled, true),
        lt(attendanceSessions.sessionDate, todayIST),
        inArray(attendanceSessions.status, ['scheduled', 'active'])
      )
    );

  if (unclosedPastAuto.length > 0) {
    const evalCache = new Map<string, DayScheduleEvaluation>();
    const idsToCancel = new Map<string, string[]>();
    const idsToClose: string[] = [];

    for (const s of unclosedPastAuto) {
      let ev = evalCache.get(s.sessionDate);
      if (!ev) {
        ev = evaluateDayScheduleStatus(s.sessionDate, settingsRow, holidayRows, overrideRows);
        evalCache.set(s.sessionDate, ev);
      }
      if (!ev.isWorkingDay) {
        const reason = buildCancellationReason(ev);
        const list = idsToCancel.get(reason) ?? [];
        list.push(s.id);
        idsToCancel.set(reason, list);
      } else {
        idsToClose.push(s.id);
      }
    }

    for (const [reason, ids] of idsToCancel.entries()) {
      await db
        .update(attendanceSessions)
        .set({ status: 'cancelled', cancelledReason: reason, updatedAt: new Date() })
        .where(inArray(attendanceSessions.id, ids));
      cancelledCount += ids.length;
    }

    if (idsToClose.length > 0) {
      await db
        .update(attendanceSessions)
        .set({ status: 'closed', updatedAt: new Date() })
        .where(inArray(attendanceSessions.id, idsToClose));
      updatedCount += idsToClose.length;
    }
  }

  // 2. Inspect today's existing auto-scheduled sessions
  const todayExistingAuto = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.sessionDate, todayIST),
        eq(attendanceSessions.isAutoScheduled, true)
      )
    );

  const existingByKey = new Map<string, (typeof todayExistingAuto)[number]>();
  for (const row of todayExistingAuto) {
    if (row.autoScheduleKey) {
      existingByKey.set(row.autoScheduleKey, row);
    }
  }

  if (!todayEval.isWorkingDay || !norm.autoDailySessionsEnabled) {
    const reason = !todayEval.isWorkingDay
      ? buildCancellationReason(todayEval)
      : 'AUTO_SCHEDULE_DISABLED';

    // Cancel any scheduled or active sessions for today (both auto and manual on holiday/closed day)
    const todayOpenSessions = await db
      .select({ id: attendanceSessions.id })
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.sessionDate, todayIST),
          inArray(attendanceSessions.status, ['scheduled', 'active'])
        )
      );

    if (todayOpenSessions.length > 0) {
      const ids = todayOpenSessions.map((s) => s.id);
      await db
        .update(attendanceSessions)
        .set({ status: 'cancelled', cancelledReason: reason, updatedAt: new Date() })
        .where(inArray(attendanceSessions.id, ids));
      cancelledCount += ids.length;
    }

    return {
      todayIST,
      nowHHMM,
      dayEval: todayEval,
      morningStatus,
      afternoonStatus,
      createdCount,
      updatedCount,
      cancelledCount,
    };
  }

  // 3. Working day: ensure Morning and Afternoon sessions exist for every active class across all 7 departments
  const slots: Array<{
    slot: 'morning' | 'afternoon';
    sessionType: 'auto_morning' | 'auto_afternoon';
    startTime: string;
    endTime: string;
    targetStatus: SlotLifecycleStatus;
  }> = [
    {
      slot: 'morning',
      sessionType: 'auto_morning',
      startTime: norm.morningStartTime,
      endTime: norm.morningEndTime,
      targetStatus: morningStatus,
    },
    {
      slot: 'afternoon',
      sessionType: 'auto_afternoon',
      startTime: norm.afternoonStartTime,
      endTime: norm.afternoonEndTime,
      targetStatus: afternoonStatus,
    },
  ];

  const toInsert: Array<typeof attendanceSessions.$inferInsert> = [];
  const toUpdateIdsByStatusAndSlot = new Map<
    string,
    { status: SlotLifecycleStatus; startTime: string; endTime: string; ids: string[] }
  >();

  const compactDate = todayIST.replace(/-/g, '');

  for (const cls of eligibleClasses) {
    for (const s of slots) {
      const key = `${cls.id}:${todayIST}:${s.slot}`;
      const existing = existingByKey.get(key);

      if (!existing) {
        toInsert.push({
          sessionCode: `AUTO-${compactDate}-${s.slot === 'morning' ? 'AM' : 'PM'}-${cls.id.slice(0, 8).toUpperCase()}`,
          departmentId: cls.departmentId,
          classId: cls.id,
          academicYearId: cls.academicYearId,
          semesterId: cls.semesterId,
          subjectId: null,
          sessionDate: todayIST,
          startTime: s.startTime,
          endTime: s.endTime,
          periodSlot: s.slot,
          sessionType: s.sessionType,
          isAutoScheduled: true,
          autoScheduleKey: key,
          status: s.targetStatus,
          cancelledReason: null,
        });
      } else {
        // Respect manual admin cancellation (cancelled without system holiday/non-working tag)
        const manuallyCancelled =
          existing.status === 'cancelled' && !isAutoSystemCancelReason(existing.cancelledReason);
        if (manuallyCancelled) continue;

        const needsUpdate =
          existing.status !== s.targetStatus ||
          existing.startTime !== s.startTime ||
          existing.endTime !== s.endTime ||
          existing.cancelledReason !== null;

        if (needsUpdate) {
          const bucketKey = `${s.slot}:${s.targetStatus}:${s.startTime}:${s.endTime}`;
          const bucket = toUpdateIdsByStatusAndSlot.get(bucketKey) ?? {
            status: s.targetStatus,
            startTime: s.startTime,
            endTime: s.endTime,
            ids: [],
          };
          bucket.ids.push(existing.id);
          toUpdateIdsByStatusAndSlot.set(bucketKey, bucket);
        }
      }
    }
  }

  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200);
      const inserted = await db
        .insert(attendanceSessions)
        .values(chunk)
        .onConflictDoNothing({ target: attendanceSessions.autoScheduleKey })
        .returning({ id: attendanceSessions.id });
      createdCount += inserted.length;
    }
  }

  for (const bucket of toUpdateIdsByStatusAndSlot.values()) {
    await db
      .update(attendanceSessions)
      .set({
        status: bucket.status,
        startTime: bucket.startTime,
        endTime: bucket.endTime,
        cancelledReason: null,
        updatedAt: new Date(),
      })
      .where(inArray(attendanceSessions.id, bucket.ids));
    updatedCount += bucket.ids.length;
  }

  return {
    todayIST,
    nowHHMM,
    dayEval: todayEval,
    morningStatus,
    afternoonStatus,
    createdCount,
    updatedCount,
    cancelledCount,
  };
}

export async function syncAutomaticDailySessions(
  now?: Date
): Promise<SyncDailySessionsResult> {
  if (now) {
    return runSyncAutomaticDailySessions(now);
  }
  if (activeSyncPromise) {
    return activeSyncPromise;
  }
  activeSyncPromise = runSyncAutomaticDailySessions(new Date()).finally(() => {
    activeSyncPromise = null;
  });
  return activeSyncPromise;
}

export async function getDayScheduleContext(dateIST: string) {
  const [settingsRow] = await db.select().from(collegeSettings).limit(1);
  const [holidayRows, overrideRows] = await Promise.all([
    db.select().from(holidays),
    db.select().from(calendarOverrides),
  ]);
  return {
    settings: getNormalizedScheduleSettings(settingsRow),
    dayEval: evaluateDayScheduleStatus(dateIST, settingsRow, holidayRows, overrideRows),
    holidays: holidayRows,
    overrides: overrideRows,
  };
}

export async function validateSessionAttendanceWindow(params: {
  sessionId: string;
  studentClassId: string;
  studentDepartmentId: string;
  now?: Date;
}): Promise<
  | { allowed: true; session: typeof attendanceSessions.$inferSelect; dayEval: DayScheduleEvaluation }
  | { allowed: false; httpStatus: number; error: string; code: string; dayEval?: DayScheduleEvaluation }
> {
  const now = params.now ?? new Date();
  const syncRes = await syncAutomaticDailySessions(now);

  // If today itself is a holiday, block immediately with required holiday message
  if (syncRes.dayEval.isHoliday) {
    return {
      allowed: false,
      httpStatus: 403,
      code: 'HOLIDAY_BLOCKED',
      error: `Today is a holiday: ${syncRes.dayEval.holidayTitle}. Attendance sessions are unavailable.`,
      dayEval: syncRes.dayEval,
    };
  }

  const [session] = await db
    .select()
    .from(attendanceSessions)
    .where(eq(attendanceSessions.id, params.sessionId))
    .limit(1);

  if (!session) {
    return {
      allowed: false,
      httpStatus: 404,
      code: 'NO_ACTIVE_SESSION',
      error: 'No active attendance session is available for your class.',
    };
  }

  if (
    session.departmentId !== params.studentDepartmentId ||
    session.classId !== params.studentClassId
  ) {
    return {
      allowed: false,
      httpStatus: 403,
      code: 'CLASS_MISMATCH',
      error: 'No active attendance session is available for your class.',
    };
  }

  // Evaluate the session date specifically (in case sessionDate differs from todayIST)
  const { dayEval: sessionDayEval } =
    session.sessionDate === syncRes.todayIST
      ? { dayEval: syncRes.dayEval }
      : await getDayScheduleContext(session.sessionDate);

  if (sessionDayEval.isHoliday) {
    return {
      allowed: false,
      httpStatus: 403,
      code: 'HOLIDAY_BLOCKED',
      error: `Today is a holiday: ${sessionDayEval.holidayTitle}. Attendance sessions are unavailable.`,
      dayEval: sessionDayEval,
    };
  }

  if (!sessionDayEval.isWorkingDay) {
    return {
      allowed: false,
      httpStatus: 403,
      code: 'NON_WORKING_DAY',
      error:
        sessionDayEval.bannerMessage ||
        'Today is a non-working day. Attendance sessions are unavailable.',
      dayEval: sessionDayEval,
    };
  }

  if (session.periodSlot === 'morning' || session.periodSlot === 'afternoon') {
    const slot = session.periodSlot;
    let effectiveStatus: SlotLifecycleStatus = session.status as SlotLifecycleStatus;

    if (session.sessionDate === syncRes.todayIST) {
      if (syncRes.nowHHMM < session.startTime) effectiveStatus = 'scheduled';
      else if (syncRes.nowHHMM >= session.endTime) effectiveStatus = 'closed';
    } else if (session.sessionDate < syncRes.todayIST) {
      effectiveStatus = 'closed';
    } else {
      effectiveStatus = 'scheduled';
    }

    if (session.status === 'cancelled') {
      return {
        allowed: false,
        httpStatus: 409,
        code: 'SESSION_CANCELLED',
        error: 'No active attendance session is available for your class.',
        dayEval: sessionDayEval,
      };
    }

    if (effectiveStatus === 'scheduled') {
      return {
        allowed: false,
        httpStatus: 403,
        code: 'SESSION_NOT_STARTED',
        error: getStudentSlotMessage({
          slot,
          status: 'scheduled',
          startTime: session.startTime,
          dayEval: sessionDayEval,
        }),
        dayEval: sessionDayEval,
      };
    }

    if (effectiveStatus === 'closed') {
      return {
        allowed: false,
        httpStatus: 409,
        code: 'SESSION_CLOSED',
        error: getStudentSlotMessage({
          slot,
          status: 'closed',
          startTime: session.startTime,
          dayEval: sessionDayEval,
        }),
        dayEval: sessionDayEval,
      };
    }
  }

  if (session.status !== 'active') {
    return {
      allowed: false,
      httpStatus: 404,
      code: 'NO_ACTIVE_SESSION',
      error: 'No active attendance session is available for your class.',
      dayEval: sessionDayEval,
    };
  }

  return { allowed: true, session, dayEval: sessionDayEval };
}

let schedulerInterval: NodeJS.Timeout | null = null;

export function startAttendanceScheduler(intervalMs = 30_000): void {
  if (schedulerInterval) return;
  syncAutomaticDailySessions().catch((err) => {
    console.error('Initial daily attendance sync failed:', err);
  });
  schedulerInterval = setInterval(() => {
    syncAutomaticDailySessions().catch((err) => {
      console.error('Scheduled daily attendance sync failed:', err);
    });
  }, intervalMs);
  schedulerInterval.unref();
}

export function stopAttendanceScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
