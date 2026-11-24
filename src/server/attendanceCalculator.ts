import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  academicYears,
  attendanceRecords,
  attendanceSessions,
  calendarOverrides,
  classes,
  collegeSettings,
  departments,
  holidays,
  semesters,
  studentAcademicHistory,
  studentEnrollments,
  subjects,
} from '../db/schema.ts';
import {
  type CalendarOverrideLike,
  type DayScheduleEvaluation,
  evaluateDayScheduleStatus,
  type HolidayLike,
} from './attendanceScheduler.ts';
import { getISTDateString, getISTTimeString } from './crypto.ts';

export const NO_ATTENDANCE_DATA_MESSAGE = 'No attendance data available';

export function roundPercentage2(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

export interface AttendanceSummaryMetrics {
  attendancePercentage: number;
  hasData: boolean;
  message: string | null;
  totalSessions: number;
  presentSessions: number;
  absentSessions: number;
  workingDays: number;
  presentDays: number;
  absentDays: number;
}

export interface SubjectAttendanceMetrics {
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  present: number;
  absent: number;
  total: number;
  percentage: number;
  hasData: boolean;
  message: string | null;
}

export interface StudentEvaluationInput {
  studentId: string;
  departmentId: string;
  classId: string;
  semesterId: string;
  academicYearId: string;
  joinedDateIST: string | null;
  approvedAt: Date | string | null;
  enrolledAt: Date | string;
  lastPromotedAt: Date | string | null;
  currentSemesterId?: string;
}

export interface SessionForCalculation {
  id: string;
  departmentId: string;
  classId: string;
  academicYearId: string;
  semesterId: string;
  subjectId: string | null;
  subjectCode: string | null;
  subjectName: string | null;
  sessionDate: string;
  startTime: string;
  endTime: string;
  periodSlot: string;
  isAutoScheduled: boolean;
  status: string;
}

export interface RecordForCalculation {
  studentId: string;
  sessionId: string;
  semesterId: string | null;
  attendanceDate: string;
  status: string;
  subjectId: string | null;
}

export interface BlockedDatesContext {
  todayIST: string;
  holidays: HolidayLike[];
  overrides: CalendarOverrideLike[];
}

export function isSessionDateBlocked(
  sessionDate: string,
  holidayRows: HolidayLike[],
  overrideRows: CalendarOverrideLike[]
): boolean {
  if (holidayRows.some((h) => h.startDate <= sessionDate && h.endDate >= sessionDate)) {
    return true;
  }
  const ov = overrideRows.find((o) => o.overrideDate === sessionDate);
  if (ov && ov.overrideType === 'closed_day') {
    return true;
  }
  return false;
}

export function isStudentEligibleForClosedSession(params: {
  session: Pick<SessionForCalculation, 'id' | 'sessionDate' | 'endTime' | 'isAutoScheduled'>;
  hasRecordForSession: boolean;
  effectiveStartDateIST: string;
  enrollmentCreatedDateIST: string;
  enrollmentCreatedTimeIST: string;
  hasExplicitJoinedDate: boolean;
  promotedOutDateIST: string | null;
}): boolean {
  if (params.hasRecordForSession) {
    return true;
  }
  if (params.promotedOutDateIST && params.session.sessionDate >= params.promotedOutDateIST) {
    return false;
  }
  if (params.session.sessionDate < params.effectiveStartDateIST) {
    return false;
  }
  if (
    params.session.isAutoScheduled &&
    !params.hasExplicitJoinedDate &&
    params.session.sessionDate === params.enrollmentCreatedDateIST &&
    params.session.endTime <= params.enrollmentCreatedTimeIST
  ) {
    return false;
  }
  return true;
}

export function computeSummaryFromSessionsAndRecords(params: {
  studentId: string;
  targetDepartmentId: string;
  targetClassId: string;
  targetSemesterId: string;
  closedSessionsInScope: SessionForCalculation[];
  studentRecordsInScope: RecordForCalculation[];
  joinedDateIST: string | null;
  approvedAt: Date | string | null;
  enrolledAt: Date | string;
  lastPromotedAt: Date | string | null;
  isCurrentSemester: boolean;
  promotedOutDateIST: string | null;
  todayIST: string;
  holidayRows: HolidayLike[];
  overrideRows: CalendarOverrideLike[];
}): {
  summary: AttendanceSummaryMetrics;
  subjectWise: SubjectAttendanceMetrics[];
  calendarDays: Array<{
    date: string;
    status: 'present' | 'absent' | 'partial';
    sessions: number;
    present: number;
  }>;
} {
  const recBySessionId = new Map<string, RecordForCalculation>();
  let earliestRecordDate: string | null = null;

  for (const r of params.studentRecordsInScope) {
    recBySessionId.set(r.sessionId, r);
    if (!earliestRecordDate || r.attendanceDate < earliestRecordDate) {
      earliestRecordDate = r.attendanceDate;
    }
  }

  const anchorDate = params.isCurrentSemester
    ? new Date(params.lastPromotedAt ?? params.approvedAt ?? params.enrolledAt)
    : new Date(params.approvedAt ?? params.enrolledAt);

  const createdDateObj = new Date(params.approvedAt ?? params.enrolledAt);
  const enrollmentCreatedDateIST = getISTDateString(createdDateObj);
  const enrollmentCreatedTimeIST = getISTTimeString(createdDateObj);

  const rawStartIST = params.joinedDateIST || getISTDateString(anchorDate);
  const effectiveStartDateIST =
    !params.joinedDateIST && earliestRecordDate && earliestRecordDate < rawStartIST
      ? earliestRecordDate
      : rawStartIST;

  const workingDaysSet = new Set<string>();
  const presentDaysSet = new Set<string>();
  let totalSessions = 0;
  let presentSessions = 0;

  const subjectMap = new Map<
    string,
    { subjectId: string; subjectCode: string; subjectName: string; present: number; total: number }
  >();
  const calendarMap = new Map<
    string,
    { date: string; status: 'present' | 'absent' | 'partial'; sessions: number; present: number }
  >();

  for (const s of params.closedSessionsInScope) {
    if (
      s.departmentId !== params.targetDepartmentId ||
      s.classId !== params.targetClassId ||
      s.semesterId !== params.targetSemesterId
    ) {
      continue;
    }
    if (s.status !== 'closed') continue;
    if (s.sessionDate > params.todayIST) continue;
    if (isSessionDateBlocked(s.sessionDate, params.holidayRows, params.overrideRows)) {
      continue;
    }

    const rec = recBySessionId.get(s.id);
    const eligible = isStudentEligibleForClosedSession({
      session: s,
      hasRecordForSession: Boolean(rec),
      effectiveStartDateIST,
      enrollmentCreatedDateIST,
      enrollmentCreatedTimeIST,
      hasExplicitJoinedDate: Boolean(params.joinedDateIST),
      promotedOutDateIST: params.promotedOutDateIST,
    });
    if (!eligible) continue;

    const isPresent = rec?.status === 'present' || rec?.status === 'excused';

    totalSessions += 1;
    if (isPresent) {
      presentSessions += 1;
      presentDaysSet.add(s.sessionDate);
    }
    workingDaysSet.add(s.sessionDate);

    // Count subject-wise ONLY if session has an assigned subject (subjectId !== null)
    if (s.subjectId) {
      const sub = subjectMap.get(s.subjectId) ?? {
        subjectId: s.subjectId,
        subjectCode: s.subjectCode || 'SUBJECT',
        subjectName: s.subjectName || 'Subject Session',
        present: 0,
        total: 0,
      };
      sub.total += 1;
      if (isPresent) sub.present += 1;
      subjectMap.set(s.subjectId, sub);
    }

    const cal = calendarMap.get(s.sessionDate) ?? {
      date: s.sessionDate,
      status: 'absent',
      sessions: 0,
      present: 0,
    };
    cal.sessions += 1;
    if (isPresent) cal.present += 1;
    cal.status = cal.present === cal.sessions ? 'present' : cal.present > 0 ? 'partial' : 'absent';
    calendarMap.set(s.sessionDate, cal);
  }

  const absentSessions = Math.max(0, totalSessions - presentSessions);
  const workingDays = workingDaysSet.size;
  const presentDays = presentDaysSet.size;
  const absentDays = Math.max(0, workingDays - presentDays);
  const hasData = totalSessions > 0;
  const attendancePercentage = roundPercentage2(presentSessions, totalSessions);

  const summary: AttendanceSummaryMetrics = {
    attendancePercentage,
    hasData,
    message: hasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
    totalSessions,
    presentSessions,
    absentSessions,
    workingDays,
    presentDays,
    absentDays,
  };

  const subjectWise: SubjectAttendanceMetrics[] = Array.from(subjectMap.values()).map((sub) => {
    const subHasData = sub.total > 0;
    return {
      subjectId: sub.subjectId,
      subjectCode: sub.subjectCode,
      subjectName: sub.subjectName,
      present: sub.present,
      absent: Math.max(0, sub.total - sub.present),
      total: sub.total,
      percentage: roundPercentage2(sub.present, sub.total),
      hasData: subHasData,
      message: subHasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
    };
  });

  return {
    summary,
    subjectWise,
    calendarDays: Array.from(calendarMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * Bulk-computes attendance summaries for an array of student enrollments in a single pass
 * (used by JNTUH Progression, Staff Assigned Students, Admin Department & Overall Metrics).
 */
export async function computeBulkSemesterAttendance(params: {
  targets: StudentEvaluationInput[];
  now?: Date;
}): Promise<Map<string, AttendanceSummaryMetrics>> {
  const result = new Map<string, AttendanceSummaryMetrics>();
  if (params.targets.length === 0) return result;

  const now = params.now ?? new Date();
  const todayIST = getISTDateString(now);

  const classIds = Array.from(new Set(params.targets.map((t) => t.classId)));
  const semesterIds = Array.from(new Set(params.targets.map((t) => t.semesterId)));
  const studentIds = Array.from(new Set(params.targets.map((t) => t.studentId)));

  const [holidayRows, overrideRows, closedSessions] = await Promise.all([
    db.select().from(holidays),
    db.select().from(calendarOverrides),
    db
      .select({
        id: attendanceSessions.id,
        departmentId: attendanceSessions.departmentId,
        classId: attendanceSessions.classId,
        academicYearId: attendanceSessions.academicYearId,
        semesterId: attendanceSessions.semesterId,
        subjectId: attendanceSessions.subjectId,
        sessionDate: attendanceSessions.sessionDate,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
        periodSlot: attendanceSessions.periodSlot,
        isAutoScheduled: attendanceSessions.isAutoScheduled,
        status: attendanceSessions.status,
      })
      .from(attendanceSessions)
      .where(
        and(
          inArray(attendanceSessions.classId, classIds),
          inArray(attendanceSessions.semesterId, semesterIds),
          eq(attendanceSessions.status, 'closed')
        )
      ),
  ]);

  const validClosedSessions: SessionForCalculation[] = closedSessions
    .filter(
      (s) =>
        s.sessionDate <= todayIST &&
        !isSessionDateBlocked(s.sessionDate, holidayRows, overrideRows)
    )
    .map((s) => ({
      ...s,
      subjectCode: null,
      subjectName: null,
    }));

  const closedByClassSem = new Map<string, SessionForCalculation[]>();
  const closedSessionIds: string[] = [];
  for (const s of validClosedSessions) {
    closedSessionIds.push(s.id);
    const key = `${s.departmentId}:${s.classId}:${s.semesterId}`;
    const arr = closedByClassSem.get(key) ?? [];
    arr.push(s);
    closedByClassSem.set(key, arr);
  }

  const recordsByStudent = new Map<string, RecordForCalculation[]>();
  if (closedSessionIds.length > 0 && studentIds.length > 0) {
    for (let i = 0; i < studentIds.length; i += 500) {
      const stuChunk = studentIds.slice(i, i + 500);
      const recs = await db
        .select({
          studentId: attendanceRecords.studentId,
          sessionId: attendanceRecords.sessionId,
          semesterId: attendanceRecords.semesterId,
          attendanceDate: attendanceRecords.attendanceDate,
          status: attendanceRecords.status,
          subjectId: attendanceRecords.subjectId,
        })
        .from(attendanceRecords)
        .where(
          and(
            inArray(attendanceRecords.studentId, stuChunk),
            inArray(attendanceRecords.sessionId, closedSessionIds)
          )
        );
      for (const r of recs) {
        const arr = recordsByStudent.get(r.studentId) ?? [];
        arr.push(r);
        recordsByStudent.set(r.studentId, arr);
      }
    }
  }

  for (const target of params.targets) {
    const key = `${target.departmentId}:${target.classId}:${target.semesterId}`;
    const classSessions = closedByClassSem.get(key) ?? [];
    const stuRecords = recordsByStudent.get(target.studentId) ?? [];
    const { summary } = computeSummaryFromSessionsAndRecords({
      studentId: target.studentId,
      targetDepartmentId: target.departmentId,
      targetClassId: target.classId,
      targetSemesterId: target.semesterId,
      closedSessionsInScope: classSessions,
      studentRecordsInScope: stuRecords,
      joinedDateIST: target.joinedDateIST,
      approvedAt: target.approvedAt,
      enrolledAt: target.enrolledAt,
      lastPromotedAt: target.lastPromotedAt,
      isCurrentSemester:
        !target.currentSemesterId || target.currentSemesterId === target.semesterId,
      promotedOutDateIST: null,
      todayIST,
      holidayRows,
      overrideRows,
    });
    result.set(target.studentId, summary);
  }

  return result;
}

/**
 * Computes overall cumulative + current semester + subject-wise + historical semester attendance
 * for a single student cleanly without mixing semesters or departments.
 */
export async function computeStudentFullAttendanceProfile(params: {
  studentId: string;
  selectedSemesterId?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const todayIST = getISTDateString(now);

  const [enrollment] = await db
    .select({
      id: studentEnrollments.id,
      rollNumber: studentEnrollments.rollNumber,
      departmentId: studentEnrollments.departmentId,
      departmentCode: departments.code,
      departmentName: departments.name,
      academicYearId: studentEnrollments.academicYearId,
      yearLabel: academicYears.label,
      semesterId: studentEnrollments.semesterId,
      semesterLabel: semesters.label,
      semesterNumber: semesters.semesterNumber,
      classId: studentEnrollments.classId,
      className: classes.displayName,
      isActive: studentEnrollments.isActive,
      regulation: studentEnrollments.regulation,
      academicStanding: studentEnrollments.academicStanding,
      creditsEarned: studentEnrollments.creditsEarned,
      activeBacklogs: studentEnrollments.activeBacklogs,
      latestResultStatus: studentEnrollments.latestResultStatus,
      joinedDateIST: studentEnrollments.joinedDateIST,
      approvedAt: studentEnrollments.approvedAt,
      enrolledAt: studentEnrollments.enrolledAt,
      lastPromotedAt: studentEnrollments.lastPromotedAt,
    })
    .from(studentEnrollments)
    .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
    .innerJoin(academicYears, eq(studentEnrollments.academicYearId, academicYears.id))
    .innerJoin(semesters, eq(studentEnrollments.semesterId, semesters.id))
    .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
    .where(eq(studentEnrollments.studentId, params.studentId))
    .limit(1);

  if (!enrollment) {
    return null;
  }

  const [historyRows, allStudentRecords, holidayRows, overrideRows, settingsRow] = await Promise.all([
    db
      .select({
        id: studentAcademicHistory.id,
        semesterId: studentAcademicHistory.semesterId,
        semesterNumber: semesters.semesterNumber,
        semesterLabel: semesters.label,
        academicYearId: studentAcademicHistory.academicYearId,
        yearLabel: academicYears.label,
        classId: studentAcademicHistory.classId,
        className: classes.displayName,
        departmentId: studentAcademicHistory.departmentId,
        regulation: studentAcademicHistory.regulation,
        creditsEarned: studentAcademicHistory.creditsEarned,
        activeBacklogs: studentAcademicHistory.activeBacklogs,
        resultStatus: studentAcademicHistory.resultStatus,
        attendancePercentage: studentAcademicHistory.attendancePercentage,
        status: studentAcademicHistory.status,
        recordedAt: studentAcademicHistory.recordedAt,
      })
      .from(studentAcademicHistory)
      .innerJoin(semesters, eq(studentAcademicHistory.semesterId, semesters.id))
      .innerJoin(academicYears, eq(studentAcademicHistory.academicYearId, academicYears.id))
      .innerJoin(classes, eq(studentAcademicHistory.classId, classes.id))
      .where(eq(studentAcademicHistory.studentId, params.studentId))
      .orderBy(asc(semesters.semesterNumber)),
    db
      .select({
        id: attendanceRecords.id,
        sessionId: attendanceRecords.sessionId,
        attendanceDate: attendanceRecords.attendanceDate,
        markedAt: attendanceRecords.markedAt,
        status: attendanceRecords.status,
        verificationMethod: attendanceRecords.verificationMethod,
        verificationResult: attendanceRecords.verificationResult,
        faceConfidence: attendanceRecords.faceConfidence,
        livenessPassed: attendanceRecords.livenessPassed,
        subjectId: attendanceRecords.subjectId,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        sessionCode: attendanceSessions.sessionCode,
        sessionDepartmentId: attendanceSessions.departmentId,
        sessionSemesterId: attendanceSessions.semesterId,
        sessionYearId: attendanceSessions.academicYearId,
        sessionClassId: attendanceSessions.classId,
        periodSlot: attendanceSessions.periodSlot,
        semesterLabel: semesters.label,
        semesterNumber: semesters.semesterNumber,
        yearLabel: academicYears.label,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
      })
      .from(attendanceRecords)
      .leftJoin(subjects, eq(attendanceRecords.subjectId, subjects.id))
      .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
      .innerJoin(semesters, eq(attendanceSessions.semesterId, semesters.id))
      .innerJoin(academicYears, eq(attendanceSessions.academicYearId, academicYears.id))
      .where(eq(attendanceRecords.studentId, params.studentId)),
    db.select().from(holidays),
    db.select().from(calendarOverrides),
    db.select().from(collegeSettings).limit(1),
  ]);

  const semesterMetaMap = new Map<
    string,
    {
      semesterId: string;
      semesterNumber: number;
      semesterLabel: string;
      yearLabel: string;
      departmentId: string;
      classId: string;
      isCurrent: boolean;
      promotedOutDateIST: string | null;
    }
  >();

  semesterMetaMap.set(enrollment.semesterId, {
    semesterId: enrollment.semesterId,
    semesterNumber: enrollment.semesterNumber,
    semesterLabel: enrollment.semesterLabel,
    yearLabel: enrollment.yearLabel,
    departmentId: enrollment.departmentId,
    classId: enrollment.classId,
    isCurrent: true,
    promotedOutDateIST: null,
  });

  for (const h of historyRows) {
    if (!semesterMetaMap.has(h.semesterId)) {
      semesterMetaMap.set(h.semesterId, {
        semesterId: h.semesterId,
        semesterNumber: h.semesterNumber,
        semesterLabel: h.semesterLabel,
        yearLabel: h.yearLabel,
        departmentId: h.departmentId,
        classId: h.classId,
        isCurrent: false,
        promotedOutDateIST: getISTDateString(new Date(h.recordedAt)),
      });
    }
  }

  for (const r of allStudentRecords) {
    if (!semesterMetaMap.has(r.sessionSemesterId)) {
      semesterMetaMap.set(r.sessionSemesterId, {
        semesterId: r.sessionSemesterId,
        semesterNumber: r.semesterNumber,
        semesterLabel: r.semesterLabel,
        yearLabel: r.yearLabel,
        departmentId: r.sessionDepartmentId,
        classId: r.sessionClassId,
        isCurrent: r.sessionSemesterId === enrollment.semesterId,
        promotedOutDateIST:
          r.sessionSemesterId !== enrollment.semesterId && enrollment.lastPromotedAt
            ? getISTDateString(new Date(enrollment.lastPromotedAt))
            : null,
      });
    }
  }

  const allSemMetas = Array.from(semesterMetaMap.values());
  const allClassIds = Array.from(new Set(allSemMetas.map((m) => m.classId)));
  const allSemIds = Array.from(new Set(allSemMetas.map((m) => m.semesterId)));

  const allClosedSessions =
    allClassIds.length > 0 && allSemIds.length > 0
      ? await db
          .select({
            id: attendanceSessions.id,
            departmentId: attendanceSessions.departmentId,
            classId: attendanceSessions.classId,
            academicYearId: attendanceSessions.academicYearId,
            semesterId: attendanceSessions.semesterId,
            subjectId: attendanceSessions.subjectId,
            subjectCode: subjects.code,
            subjectName: subjects.name,
            sessionDate: attendanceSessions.sessionDate,
            startTime: attendanceSessions.startTime,
            endTime: attendanceSessions.endTime,
            periodSlot: attendanceSessions.periodSlot,
            isAutoScheduled: attendanceSessions.isAutoScheduled,
            status: attendanceSessions.status,
          })
          .from(attendanceSessions)
          .leftJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
          .where(
            and(
              inArray(attendanceSessions.classId, allClassIds),
              inArray(attendanceSessions.semesterId, allSemIds),
              eq(attendanceSessions.status, 'closed')
            )
          )
      : [];

  // Compute per-semester summary cleanly
  const perSemStats = new Map<
    string,
    ReturnType<typeof computeSummaryFromSessionsAndRecords>
  >();

  let overallTotalSessions = 0;
  let overallPresentSessions = 0;
  const overallWorkingDays = new Set<string>();
  const overallPresentDays = new Set<string>();

  for (const meta of allSemMetas) {
    const semSessions = allClosedSessions.filter(
      (s) =>
        s.classId === meta.classId &&
        s.semesterId === meta.semesterId &&
        s.departmentId === meta.departmentId
    );
    const semRecs: RecordForCalculation[] = allStudentRecords
      .filter((r) => r.sessionSemesterId === meta.semesterId)
      .map((r) => ({
        studentId: params.studentId,
        sessionId: r.sessionId,
        semesterId: r.sessionSemesterId,
        attendanceDate: r.attendanceDate,
        status: r.status,
        subjectId: r.subjectId,
      }));

    const computed = computeSummaryFromSessionsAndRecords({
      studentId: params.studentId,
      targetDepartmentId: meta.departmentId,
      targetClassId: meta.classId,
      targetSemesterId: meta.semesterId,
      closedSessionsInScope: semSessions,
      studentRecordsInScope: semRecs,
      joinedDateIST: enrollment.joinedDateIST,
      approvedAt: enrollment.approvedAt,
      enrolledAt: enrollment.enrolledAt,
      lastPromotedAt: enrollment.lastPromotedAt,
      isCurrentSemester: meta.isCurrent,
      promotedOutDateIST: meta.promotedOutDateIST,
      todayIST,
      holidayRows,
      overrideRows,
    });

    perSemStats.set(meta.semesterId, computed);

    overallTotalSessions += computed.summary.totalSessions;
    overallPresentSessions += computed.summary.presentSessions;
    for (const cal of computed.calendarDays) {
      overallWorkingDays.add(cal.date);
      if (cal.present > 0) overallPresentDays.add(cal.date);
    }
  }

  const overallHasData = overallTotalSessions > 0;
  const overallSummary: AttendanceSummaryMetrics = {
    attendancePercentage: roundPercentage2(overallPresentSessions, overallTotalSessions),
    hasData: overallHasData,
    message: overallHasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
    totalSessions: overallTotalSessions,
    presentSessions: overallPresentSessions,
    absentSessions: Math.max(0, overallTotalSessions - overallPresentSessions),
    workingDays: overallWorkingDays.size,
    presentDays: overallPresentDays.size,
    absentDays: Math.max(0, overallWorkingDays.size - overallPresentDays.size),
  };

  const selectedMeta =
    (params.selectedSemesterId && semesterMetaMap.get(params.selectedSemesterId)) ||
    semesterMetaMap.get(enrollment.semesterId)!;

  const selectedComputed = perSemStats.get(selectedMeta.semesterId)!;
  const currentComputed = perSemStats.get(enrollment.semesterId)!;

  // Also include subject-wise summary for any active subjects in current semester that have 0 completed sessions yet
  const deptSubjMap = new Map(selectedComputed.subjectWise.map((s) => [s.subjectId, s]));
  if (selectedMeta.isCurrent) {
    const classSubjects = await db
      .select({ id: subjects.id, code: subjects.code, name: subjects.name })
      .from(subjects)
      .where(
        and(
          eq(subjects.departmentId, enrollment.departmentId),
          eq(subjects.semesterId, enrollment.semesterId),
          eq(subjects.isActive, true)
        )
      )
      .orderBy(asc(subjects.code));

    for (const sub of classSubjects) {
      if (!deptSubjMap.has(sub.id)) {
        deptSubjMap.set(sub.id, {
          subjectId: sub.id,
          subjectCode: sub.code,
          subjectName: sub.name,
          present: 0,
          absent: 0,
          total: 0,
          percentage: 0,
          hasData: false,
          message: NO_ATTENDANCE_DATA_MESSAGE,
        });
      }
    }
  }

  const selectedRecords = allStudentRecords
    .filter((r) => r.sessionSemesterId === selectedMeta.semesterId)
    .sort((a, b) => new Date(b.markedAt).getTime() - new Date(a.markedAt).getTime());

  const todayDayEval: DayScheduleEvaluation = evaluateDayScheduleStatus(
    todayIST,
    settingsRow[0],
    holidayRows,
    overrideRows
  );

  return {
    todayIST,
    todayDayEval,
    enrollment,
    selectedMeta,
    availableSemesters: allSemMetas.sort((a, b) => b.semesterNumber - a.semesterNumber),
    historyRows,
    holidayRows,
    overrideRows,
    settings: settingsRow[0] ?? null,
    summary: selectedComputed.summary,
    currentSemesterSummary: currentComputed.summary,
    overallSummary,
    subjectWise: Array.from(deptSubjMap.values()),
    calendar: selectedComputed.calendarDays,
    selectedRecords,
  };
}
