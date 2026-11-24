import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  academicYears,
  attendanceRecords,
  attendanceSessions,
  classes,
  departments,
  jntuhRegulationRules,
  profiles,
  promotionBatches,
  promotionBatchItems,
  semesters,
  staffAssignments,
  studentAcademicHistory,
  studentEnrollments,
  subjects,
} from '../db/schema.ts';
import { writeAuditLog } from './audit.ts';
import { computeBulkSemesterAttendance } from './attendanceCalculator.ts';

export type JntuhResultStatus =
  | 'passed'
  | 'promoted_with_backlogs'
  | 'failed'
  | 'detained'
  | 'pending';

export type AcademicStanding = 'active' | 'detained' | 'graduated';
export type EligibilityBucket = 'eligible' | 'detained' | 'failed' | 'pending';

export interface JntuhRuleConfig {
  id: string;
  code: string;
  name: string;
  minAttendancePercent: number;
  sem2To3MinCredits: number;
  sem4To5MinCredits: number;
  sem6To7MinCredits: number;
  maxBacklogsForPromotion: number | null;
  requireResultPublished: boolean;
}

export interface StudentProgressionPreviewItem {
  enrollmentId: string;
  studentId: string;
  rollNumber: string;
  fullName: string;
  email: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  classId: string;
  className: string;
  sectionName: string;
  regulation: string;
  academicStanding: AcademicStanding;
  creditsEarned: number;
  totalCreditsAttempted: number;
  activeBacklogs: number;
  latestResultStatus: JntuhResultStatus;
  detentionReason: string | null;
  conductedSessionsCount: number;
  presentSessionsCount: number;
  attendancePercentage: number | null;
  bucket: EligibilityBucket;
  eligibilityReason: string;
}

export function getNextJntuhSemesterNumber(currentSemNumber: number): number | null {
  if (currentSemNumber >= 1 && currentSemNumber <= 7) {
    return currentSemNumber + 1;
  }
  return null;
}

export function getExpectedYearNumberForSemester(semNumber: number): number {
  return Math.ceil(semNumber / 2);
}

export function getRequiredCreditsForTransition(
  fromSemesterNumber: number,
  rule: JntuhRuleConfig
): number {
  if (fromSemesterNumber === 2) return rule.sem2To3MinCredits;
  if (fromSemesterNumber === 4) return rule.sem4To5MinCredits;
  if (fromSemesterNumber === 6) return rule.sem6To7MinCredits;
  return 0;
}

export function evaluateJntuhEligibility(params: {
  fromSemesterNumber: number;
  academicStanding: string;
  latestResultStatus: string;
  creditsEarned: number;
  activeBacklogs: number;
  detentionReason: string | null;
  attendancePercentage: number | null;
  conductedSessionsCount: number;
  rule: JntuhRuleConfig;
}): { bucket: EligibilityBucket; reason: string } {
  const {
    fromSemesterNumber,
    academicStanding,
    latestResultStatus,
    creditsEarned,
    activeBacklogs,
    detentionReason,
    attendancePercentage,
    conductedSessionsCount,
    rule,
  } = params;

  if (fromSemesterNumber >= 8 || academicStanding === 'graduated') {
    return {
      bucket: 'detained',
      reason: 'Final semester (Semester 8) reached — no further semester promotion.',
    };
  }

  if (academicStanding === 'detained' || latestResultStatus === 'detained') {
    return {
      bucket: 'detained',
      reason:
        detentionReason?.trim() ||
        `Marked as detained under ${rule.code} institutional standing.`,
    };
  }

  if (
    conductedSessionsCount > 0 &&
    attendancePercentage !== null &&
    attendancePercentage < rule.minAttendancePercent
  ) {
    return {
      bucket: 'detained',
      reason: `Attendance ${attendancePercentage}% is below ${rule.code} minimum ${rule.minAttendancePercent}% (${conductedSessionsCount} sessions conducted).`,
    };
  }

  if (latestResultStatus === 'failed') {
    return {
      bucket: 'failed',
      reason: 'Semester examination result recorded as Failed — promotion blocked until cleared.',
    };
  }

  if (rule.requireResultPublished && latestResultStatus === 'pending') {
    return {
      bucket: 'pending',
      reason: 'Semester results & academic standing are Pending publication — review before promotion.',
    };
  }

  const requiredCredits = getRequiredCreditsForTransition(fromSemesterNumber, rule);
  if (requiredCredits > 0 && creditsEarned < requiredCredits) {
    return {
      bucket: 'detained',
      reason: `Credit shortage under ${rule.code}: earned ${creditsEarned} credits, minimum ${requiredCredits} required for Sem ${fromSemesterNumber} → Sem ${fromSemesterNumber + 1}.`,
    };
  }

  if (
    rule.maxBacklogsForPromotion !== null &&
    rule.maxBacklogsForPromotion !== undefined &&
    activeBacklogs > rule.maxBacklogsForPromotion
  ) {
    return {
      bucket: 'detained',
      reason: `Active backlogs (${activeBacklogs}) exceed ${rule.code} promotion limit (${rule.maxBacklogsForPromotion}).`,
    };
  }

  const backlogNote =
    latestResultStatus === 'promoted_with_backlogs' || activeBacklogs > 0
      ? `Promoted with ${activeBacklogs} active backlog(s)`
      : 'All results & credits cleared';

  return {
    bucket: 'eligible',
    reason: `Eligible for Sem ${fromSemesterNumber} → Sem ${fromSemesterNumber + 1} under ${rule.code} (${backlogNote}).`,
  };
}

async function resolveRuleMap(): Promise<Map<string, JntuhRuleConfig>> {
  const rules = await db
    .select()
    .from(jntuhRegulationRules)
    .where(eq(jntuhRegulationRules.isActive, true));

  const map = new Map<string, JntuhRuleConfig>();
  for (const r of rules) {
    map.set(r.code, {
      id: r.id,
      code: r.code,
      name: r.name,
      minAttendancePercent: r.minAttendancePercent,
      sem2To3MinCredits: r.sem2To3MinCredits,
      sem4To5MinCredits: r.sem4To5MinCredits,
      sem6To7MinCredits: r.sem6To7MinCredits,
      maxBacklogsForPromotion: r.maxBacklogsForPromotion,
      requireResultPublished: r.requireResultPublished,
    });
  }

  if (!map.has('R22')) {
    map.set('R22', {
      id: 'default-r22',
      code: 'R22',
      name: 'JNTUH B.Tech R22 Regulation',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 40,
      sem6To7MinCredits: 60,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
    });
  }
  return map;
}

export async function previewAcademicProgression(params: {
  fromSemesterId: string;
  departmentId?: string | null;
  regulationOverride?: string | null;
}) {
  const allSemesters = await db
    .select({
      id: semesters.id,
      semesterNumber: semesters.semesterNumber,
      label: semesters.label,
      academicYearId: semesters.academicYearId,
      yearNumber: academicYears.yearNumber,
      yearLabel: academicYears.label,
      academicSession: academicYears.academicSession,
    })
    .from(semesters)
    .innerJoin(academicYears, eq(semesters.academicYearId, academicYears.id))
    .orderBy(asc(semesters.semesterNumber));

  const fromSem = allSemesters.find((s) => s.id === params.fromSemesterId);
  if (!fromSem) {
    throw new Error('Selected source semester was not found.');
  }

  const nextSemNumber = getNextJntuhSemesterNumber(fromSem.semesterNumber);
  const toSem = nextSemNumber
    ? allSemesters.find((s) => s.semesterNumber === nextSemNumber) ?? null
    : null;

  const ruleMap = await resolveRuleMap();
  const defaultRule =
    (params.regulationOverride && ruleMap.get(params.regulationOverride)) ||
    ruleMap.get('R22')!;

  const allDepts = await db
    .select()
    .from(departments)
    .where(eq(departments.isActive, true))
    .orderBy(asc(departments.code));

  const deptList = params.departmentId
    ? allDepts.filter((d) => d.id === params.departmentId)
    : allDepts;

  const enrollmentFilters = [
    eq(studentEnrollments.semesterId, fromSem.id),
    eq(studentEnrollments.isActive, true),
    eq(profiles.status, 'approved'),
  ];
  if (params.departmentId) {
    enrollmentFilters.push(eq(studentEnrollments.departmentId, params.departmentId));
  }

  const rows = await db
    .select({
      enrollmentId: studentEnrollments.id,
      studentId: studentEnrollments.studentId,
      rollNumber: studentEnrollments.rollNumber,
      fullName: profiles.fullName,
      email: profiles.email,
      departmentId: studentEnrollments.departmentId,
      departmentCode: departments.code,
      departmentName: departments.name,
      classId: studentEnrollments.classId,
      className: classes.displayName,
      sectionName: classes.sectionName,
      regulation: studentEnrollments.regulation,
      academicStanding: studentEnrollments.academicStanding,
      creditsEarned: studentEnrollments.creditsEarned,
      totalCreditsAttempted: studentEnrollments.totalCreditsAttempted,
      activeBacklogs: studentEnrollments.activeBacklogs,
      latestResultStatus: studentEnrollments.latestResultStatus,
      detentionReason: studentEnrollments.detentionReason,
      joinedDateIST: studentEnrollments.joinedDateIST,
      approvedAt: studentEnrollments.approvedAt,
      enrolledAt: studentEnrollments.enrolledAt,
      lastPromotedAt: studentEnrollments.lastPromotedAt,
    })
    .from(studentEnrollments)
    .innerJoin(profiles, eq(studentEnrollments.studentId, profiles.id))
    .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
    .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
    .where(and(...enrollmentFilters))
    .orderBy(asc(departments.code), asc(studentEnrollments.rollNumber));

  // Bulk-compute semester attendance percentage via centralized calculator (excludes holidays, cancelled, unclosed, pre-join)
  const attendanceMap = await computeBulkSemesterAttendance({
    targets: rows.map((r) => ({
      studentId: r.studentId,
      departmentId: r.departmentId,
      classId: r.classId,
      semesterId: fromSem.id,
      academicYearId: fromSem.academicYearId,
      joinedDateIST: r.joinedDateIST,
      approvedAt: r.approvedAt,
      enrolledAt: r.enrolledAt,
      lastPromotedAt: r.lastPromotedAt,
      currentSemesterId: fromSem.id,
    })),
  });

  // Target classes & subjects readiness across selected departments
  const targetClasses = toSem
    ? await db
        .select({ id: classes.id, departmentId: classes.departmentId })
        .from(classes)
        .where(eq(classes.semesterId, toSem.id))
    : [];
  const targetSubjects = toSem
    ? await db
        .select({ id: subjects.id, departmentId: subjects.departmentId })
        .from(subjects)
        .where(and(eq(subjects.semesterId, toSem.id), eq(subjects.isActive, true)))
    : [];

  const targetClassDepts = new Set(targetClasses.map((c) => c.departmentId));
  const targetSubjectCountByDept = new Map<string, number>();
  for (const sub of targetSubjects) {
    targetSubjectCountByDept.set(
      sub.departmentId,
      (targetSubjectCountByDept.get(sub.departmentId) ?? 0) + 1
    );
  }

  const deptSummaryMap = new Map<
    string,
    {
      departmentId: string;
      departmentCode: string;
      departmentName: string;
      total: number;
      eligible: number;
      detained: number;
      failed: number;
      pending: number;
      targetClassReady: boolean;
      targetSubjectsCount: number;
    }
  >();

  for (const d of deptList) {
    deptSummaryMap.set(d.id, {
      departmentId: d.id,
      departmentCode: d.code,
      departmentName: d.name,
      total: 0,
      eligible: 0,
      detained: 0,
      failed: 0,
      pending: 0,
      targetClassReady: targetClassDepts.has(d.id),
      targetSubjectsCount: targetSubjectCountByDept.get(d.id) ?? 0,
    });
  }

  const counts = { total: 0, eligible: 0, detained: 0, failed: 0, pending: 0 };
  const students: StudentProgressionPreviewItem[] = [];

  for (const r of rows) {
    const attSummary = attendanceMap.get(r.studentId);
    const conducted = attSummary?.totalSessions ?? 0;
    const present = attSummary?.presentSessions ?? 0;
    const attendancePercentage = conducted > 0 ? (attSummary?.attendancePercentage ?? 0) : null;

    const studentRule =
      (params.regulationOverride && ruleMap.get(params.regulationOverride)) ||
      ruleMap.get(r.regulation) ||
      defaultRule;

    const evaluation = evaluateJntuhEligibility({
      fromSemesterNumber: fromSem.semesterNumber,
      academicStanding: r.academicStanding,
      latestResultStatus: r.latestResultStatus,
      creditsEarned: r.creditsEarned,
      activeBacklogs: r.activeBacklogs,
      detentionReason: r.detentionReason,
      attendancePercentage,
      conductedSessionsCount: conducted,
      rule: studentRule,
    });

    counts.total += 1;
    counts[evaluation.bucket] += 1;

    const ds = deptSummaryMap.get(r.departmentId);
    if (ds) {
      ds.total += 1;
      ds[evaluation.bucket] += 1;
    }

    students.push({
      enrollmentId: r.enrollmentId,
      studentId: r.studentId,
      rollNumber: r.rollNumber,
      fullName: r.fullName,
      email: r.email,
      departmentId: r.departmentId,
      departmentCode: r.departmentCode,
      departmentName: r.departmentName,
      classId: r.classId,
      className: r.className,
      sectionName: r.sectionName,
      regulation: studentRule.code,
      academicStanding: r.academicStanding as AcademicStanding,
      creditsEarned: r.creditsEarned,
      totalCreditsAttempted: r.totalCreditsAttempted,
      activeBacklogs: r.activeBacklogs,
      latestResultStatus: r.latestResultStatus as JntuhResultStatus,
      detentionReason: r.detentionReason,
      conductedSessionsCount: conducted,
      presentSessionsCount: present,
      attendancePercentage,
      bucket: evaluation.bucket,
      eligibilityReason: evaluation.reason,
    });
  }

  return {
    fromSemester: fromSem,
    toSemester: toSem,
    rule: defaultRule,
    allRules: Array.from(ruleMap.values()),
    counts,
    departmentSummaries: Array.from(deptSummaryMap.values()),
    students,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function executeBulkPromotion(params: {
  fromSemesterId: string;
  departmentId?: string | null;
  regulationOverride?: string | null;
  selectedStudentIds?: string[] | null;
  updateStaffAssignments?: boolean;
  confirmationNote?: string | null;
  actorId: string;
  actorEmail: string;
  actorIp?: string | null;
}) {
  const preview = await previewAcademicProgression({
    fromSemesterId: params.fromSemesterId,
    departmentId: params.departmentId,
    regulationOverride: params.regulationOverride,
  });

  if (!preview.toSemester) {
    throw new Error(
      `Semester ${preview.fromSemester.semesterNumber} is the final JNTUH semester and cannot be auto-promoted.`
    );
  }
  if (preview.students.length === 0) {
    throw new Error('No active approved students found in the selected semester/department scope.');
  }

  const selectedSet =
    params.selectedStudentIds && params.selectedStudentIds.length > 0
      ? new Set(params.selectedStudentIds)
      : null;

  const eligibleToPromote = preview.students.filter(
    (s) => s.bucket === 'eligible' && (!selectedSet || selectedSet.has(s.studentId))
  );

  if (eligibleToPromote.length === 0) {
    throw new Error(
      'No eligible students qualify for promotion under JNTUH regulation rules in this selection.'
    );
  }

  const toSem = preview.toSemester;
  const fromSem = preview.fromSemester;
  const now = new Date();
  const batchCode = `JNTUH-S${fromSem.semesterNumber}TO${toSem.semesterNumber}-${Date.now().toString(36).toUpperCase()}`;

  const result = await db.transaction(async (tx) => {
    // Re-verify inside transaction that selected eligible students are STILL in fromSem (prevents duplicate concurrent promotion)
    const eligibleIds = eligibleToPromote.map((s) => s.studentId);
    const liveEnrollments: Array<{
      id: string;
      studentId: string;
      semesterId: string;
      classId: string;
    }> = [];

    for (const idChunk of chunkArray(eligibleIds, 500)) {
      const found = await tx
        .select({
          id: studentEnrollments.id,
          studentId: studentEnrollments.studentId,
          semesterId: studentEnrollments.semesterId,
          classId: studentEnrollments.classId,
        })
        .from(studentEnrollments)
        .where(inArray(studentEnrollments.studentId, idChunk));
      liveEnrollments.push(...found);
    }

    const liveByStudentId = new Map(liveEnrollments.map((e) => [e.studentId, e]));
    const verifiedEligible = eligibleToPromote.filter(
      (s) => liveByStudentId.get(s.studentId)?.semesterId === fromSem.id
    );

    if (verifiedEligible.length === 0) {
      throw new Error(
        'Selected students have already been promoted out of this semester (duplicate promotion prevented).'
      );
    }

    // Ensure target classes exist for every (departmentId, sectionName)
    const existingTargetClasses = await tx
      .select()
      .from(classes)
      .where(eq(classes.semesterId, toSem.id));

    const targetClassMap = new Map<string, string>();
    for (const cls of existingTargetClasses) {
      targetClassMap.set(`${cls.departmentId}:${cls.sectionName}`, cls.id);
    }

    const neededClassKeys = new Map<
      string,
      { departmentId: string; departmentCode: string; sectionName: string }
    >();
    for (const stu of verifiedEligible) {
      const key = `${stu.departmentId}:${stu.sectionName}`;
      if (!targetClassMap.has(key) && !neededClassKeys.has(key)) {
        neededClassKeys.set(key, {
          departmentId: stu.departmentId,
          departmentCode: stu.departmentCode,
          sectionName: stu.sectionName,
        });
      }
    }

    for (const [key, info] of neededClassKeys.entries()) {
      const [createdClass] = await tx
        .insert(classes)
        .values({
          departmentId: info.departmentId,
          academicYearId: toSem.academicYearId,
          semesterId: toSem.id,
          sectionName: info.sectionName,
          displayName: `${info.departmentCode} · Sem ${toSem.semesterNumber}`,
        })
        .onConflictDoNothing()
        .returning();

      if (createdClass) {
        targetClassMap.set(key, createdClass.id);
      } else {
        const [refetched] = await tx
          .select()
          .from(classes)
          .where(
            and(
              eq(classes.departmentId, info.departmentId),
              eq(classes.semesterId, toSem.id),
              eq(classes.sectionName, info.sectionName)
            )
          )
          .limit(1);
        if (refetched) targetClassMap.set(key, refetched.id);
      }
    }

    // Ensure target subjects exist for promoted departments in toSem
    const promotedDeptIds = Array.from(new Set(verifiedEligible.map((s) => s.departmentId)));
    const existingTargetSubjects = await tx
      .select()
      .from(subjects)
      .where(
        and(
          eq(subjects.semesterId, toSem.id),
          inArray(subjects.departmentId, promotedDeptIds)
        )
      );

    const subjectCountByDept = new Map<string, number>();
    const targetSubjectsByDept = new Map<string, Array<{ id: string; code: string }>>();
    for (const sub of existingTargetSubjects) {
      subjectCountByDept.set(sub.departmentId, (subjectCountByDept.get(sub.departmentId) ?? 0) + 1);
      const list = targetSubjectsByDept.get(sub.departmentId) ?? [];
      list.push({ id: sub.id, code: sub.code });
      targetSubjectsByDept.set(sub.departmentId, list);
    }

    for (const stu of verifiedEligible) {
      if ((subjectCountByDept.get(stu.departmentId) ?? 0) === 0) {
        const prefix = stu.departmentCode.replace(/\s+/g, '');
        const [insertedSub] = await tx
          .insert(subjects)
          .values({
            code: `${prefix}-${toSem.semesterNumber}01`,
            name: `Semester ${toSem.semesterNumber} Core Course`,
            departmentId: stu.departmentId,
            semesterId: toSem.id,
            credits: 4,
          })
          .onConflictDoNothing()
          .returning();
        if (insertedSub) {
          subjectCountByDept.set(stu.departmentId, 1);
          targetSubjectsByDept.set(stu.departmentId, [
            { id: insertedSub.id, code: insertedSub.code },
          ]);
        }
      }
    }

    const verifiedSet = new Set(verifiedEligible.map((s) => s.studentId));
    const skippedStudents = preview.students.filter(
      (s) => s.bucket === 'eligible' && !verifiedSet.has(s.studentId)
    );

    const [batch] = await tx
      .insert(promotionBatches)
      .values({
        batchCode,
        fromAcademicYearId: fromSem.academicYearId,
        fromSemesterId: fromSem.id,
        toAcademicYearId: toSem.academicYearId,
        toSemesterId: toSem.id,
        departmentId: params.departmentId || null,
        regulation: preview.rule.code,
        totalReviewed: preview.students.length,
        promotedCount: verifiedEligible.length,
        skippedCount: skippedStudents.length,
        detainedCount: preview.counts.detained,
        failedCount: preview.counts.failed,
        pendingCount: preview.counts.pending,
        staffAssignmentsUpdated: 0,
        status: 'completed',
        promotedBy: params.actorId,
        promotedByEmail: params.actorEmail,
        confirmationNote: params.confirmationNote?.trim() || null,
      })
      .returning();

    // Archive academic history & batch-update enrollments grouped by targetClassId
    const enrollmentIdsByTargetClass = new Map<string, string[]>();
    const historyRows: Array<typeof studentAcademicHistory.$inferInsert> = [];
    const batchItemRows: Array<typeof promotionBatchItems.$inferInsert> = [];

    for (const stu of preview.students) {
      const isPromoted = verifiedSet.has(stu.studentId);
      const targetClassId = isPromoted
        ? targetClassMap.get(`${stu.departmentId}:${stu.sectionName}`) ?? null
        : null;

      if (isPromoted && targetClassId) {
        const list = enrollmentIdsByTargetClass.get(targetClassId) ?? [];
        list.push(stu.enrollmentId);
        enrollmentIdsByTargetClass.set(targetClassId, list);

        historyRows.push({
          studentId: stu.studentId,
          rollNumber: stu.rollNumber,
          departmentId: stu.departmentId,
          academicYearId: fromSem.academicYearId,
          semesterId: fromSem.id,
          classId: stu.classId,
          regulation: stu.regulation,
          creditsEarned: stu.creditsEarned,
          activeBacklogs: stu.activeBacklogs,
          resultStatus: stu.latestResultStatus,
          attendancePercentage: stu.attendancePercentage,
          status: 'promoted',
          promotionBatchId: batch.id,
        });
      }

      batchItemRows.push({
        batchId: batch.id,
        studentId: stu.studentId,
        departmentId: stu.departmentId,
        fromAcademicYearId: fromSem.academicYearId,
        fromSemesterId: fromSem.id,
        fromClassId: stu.classId,
        toAcademicYearId: toSem.academicYearId,
        toSemesterId: toSem.id,
        toClassId: targetClassId,
        previousStanding: stu.academicStanding,
        previousCreditsEarned: stu.creditsEarned,
        previousActiveBacklogs: stu.activeBacklogs,
        previousResultStatus: stu.latestResultStatus,
        outcome: isPromoted
          ? 'promoted'
          : stu.bucket === 'eligible'
            ? 'skipped'
            : stu.bucket,
        reason: isPromoted
          ? stu.eligibilityReason
          : stu.bucket === 'eligible'
            ? 'Excluded or already promoted.'
            : stu.eligibilityReason,
        attendancePercentage: stu.attendancePercentage,
      });
    }

    for (const chunk of chunkArray(historyRows, 500)) {
      await tx.insert(studentAcademicHistory).values(chunk);
    }

    for (const [targetClassId, enrIds] of enrollmentIdsByTargetClass.entries()) {
      for (const idChunk of chunkArray(enrIds, 500)) {
        await tx
          .update(studentEnrollments)
          .set({
            academicYearId: toSem.academicYearId,
            semesterId: toSem.id,
            classId: targetClassId,
            academicStanding: 'active',
            latestResultStatus: 'pending',
            detentionReason: null,
            lastPromotedAt: now,
            lastPromotionBatchId: batch.id,
          })
          .where(inArray(studentEnrollments.id, idChunk));
      }
    }

    for (const chunk of chunkArray(batchItemRows, 500)) {
      await tx.insert(promotionBatchItems).values(chunk);
    }

    // Update authorized staff assignments from promoted source classes to target classes
    let staffAssignmentsUpdated = 0;
    if (params.updateStaffAssignments !== false) {
      const fromClassToTarget = new Map<string, { toClassId: string; departmentId: string }>();
      for (const stu of verifiedEligible) {
        const toClassId = targetClassMap.get(`${stu.departmentId}:${stu.sectionName}`);
        if (toClassId && !fromClassToTarget.has(stu.classId)) {
          fromClassToTarget.set(stu.classId, {
            toClassId,
            departmentId: stu.departmentId,
          });
        }
      }

      const fromClassIds = Array.from(fromClassToTarget.keys());
      if (fromClassIds.length > 0) {
        const sourceAssignments = await tx
          .select()
          .from(staffAssignments)
          .where(
            and(
              inArray(staffAssignments.classId, fromClassIds),
              eq(staffAssignments.isActive, true)
            )
          );

        for (const sa of sourceAssignments) {
          if (!sa.classId) continue;
          const mapping = fromClassToTarget.get(sa.classId);
          if (!mapping) continue;

          let matchedSubjectId: string | null = null;
          if (sa.subjectId) {
            const deptTargetSubs = targetSubjectsByDept.get(mapping.departmentId) ?? [];
            matchedSubjectId = deptTargetSubs[0]?.id ?? null;
          }

          const inserted = await tx
            .insert(staffAssignments)
            .values({
              staffId: sa.staffId,
              departmentId: sa.departmentId,
              classId: mapping.toClassId,
              subjectId: matchedSubjectId,
              canCreateSessions: sa.canCreateSessions,
              isActive: true,
            })
            .onConflictDoNothing()
            .returning({ id: staffAssignments.id });

          if (inserted.length > 0) {
            staffAssignmentsUpdated += 1;
          }
        }

        if (staffAssignmentsUpdated > 0) {
          await tx
            .update(promotionBatches)
            .set({ staffAssignmentsUpdated })
            .where(eq(promotionBatches.id, batch.id));
        }
      }
    }

    return {
      batch: { ...batch, staffAssignmentsUpdated },
      promotedStudents: verifiedEligible.map((s) => ({
        studentId: s.studentId,
        rollNumber: s.rollNumber,
        fullName: s.fullName,
        departmentCode: s.departmentCode,
      })),
    };
  });

  await writeAuditLog({
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    actorRole: 'super_admin',
    action: 'ACADEMIC_PROMOTION_EXECUTED',
    entityType: 'promotion_batch',
    entityId: result.batch.id,
    details: {
      batchCode: result.batch.batchCode,
      fromSemester: fromSem.semesterNumber,
      toSemester: toSem.semesterNumber,
      toAcademicYear: toSem.yearLabel,
      departmentId: params.departmentId || 'ALL_DEPARTMENTS',
      promotedCount: result.batch.promotedCount,
      detainedCount: result.batch.detainedCount,
      failedCount: result.batch.failedCount,
      pendingCount: result.batch.pendingCount,
      skippedCount: result.batch.skippedCount,
      staffAssignmentsUpdated: result.batch.staffAssignmentsUpdated,
      affectedRollNumbers: result.promotedStudents.slice(0, 50).map((s) => s.rollNumber),
    },
    ipAddress: params.actorIp ?? null,
  });

  return result;
}

export async function rollbackPromotionBatch(params: {
  batchId: string;
  reason: string;
  actorId: string;
  actorEmail: string;
  actorIp?: string | null;
}) {
  const cleanReason = params.reason.trim();
  if (cleanReason.length < 3) {
    throw new Error('Please provide a clear rollback reason (min 3 characters).');
  }

  const rolledBack = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(promotionBatches)
      .where(eq(promotionBatches.id, params.batchId))
      .limit(1);

    if (!batch) {
      throw new Error('Promotion batch not found.');
    }
    if (batch.status === 'rolled_back') {
      throw new Error('This promotion batch has already been rolled back.');
    }

    const promotedItems = await tx
      .select()
      .from(promotionBatchItems)
      .where(
        and(
          eq(promotionBatchItems.batchId, batch.id),
          eq(promotionBatchItems.outcome, 'promoted')
        )
      );

    if (promotedItems.length === 0) {
      throw new Error('No promoted students found in this batch to roll back.');
    }

    const studentIds = promotedItems.map((i) => i.studentId);
    const currentEnrollments: Array<{
      id: string;
      studentId: string;
      semesterId: string;
    }> = [];
    for (const idChunk of chunkArray(studentIds, 500)) {
      const found = await tx
        .select({
          id: studentEnrollments.id,
          studentId: studentEnrollments.studentId,
          semesterId: studentEnrollments.semesterId,
        })
        .from(studentEnrollments)
        .where(inArray(studentEnrollments.studentId, idChunk));
      currentEnrollments.push(...found);
    }

    const currentSemByStudent = new Map(
      currentEnrollments.map((e) => [e.studentId, e.semesterId])
    );

    const movedFurther = promotedItems.filter(
      (item) => currentSemByStudent.get(item.studentId) !== batch.toSemesterId
    );
    if (movedFurther.length > 0) {
      throw new Error(
        `Cannot roll back batch: ${movedFurther.length} student(s) have already progressed past the target semester. Roll back newer batches first.`
      );
    }

    // Group restores by identical target tuple so bulk rollback scales to thousands of students
    const restoreGroups = new Map<
      string,
      {
        sample: typeof promotedItems[number];
        studentIds: string[];
      }
    >();
    for (const item of promotedItems) {
      const key = [
        item.fromAcademicYearId,
        item.fromSemesterId,
        item.fromClassId,
        item.previousStanding,
        item.previousCreditsEarned,
        item.previousActiveBacklogs,
        item.previousResultStatus,
      ].join('|');
      const grp = restoreGroups.get(key) ?? { sample: item, studentIds: [] };
      grp.studentIds.push(item.studentId);
      restoreGroups.set(key, grp);
    }

    for (const grp of restoreGroups.values()) {
      for (const idChunk of chunkArray(grp.studentIds, 500)) {
        await tx
          .update(studentEnrollments)
          .set({
            academicYearId: grp.sample.fromAcademicYearId,
            semesterId: grp.sample.fromSemesterId,
            classId: grp.sample.fromClassId,
            academicStanding: grp.sample.previousStanding,
            creditsEarned: grp.sample.previousCreditsEarned,
            activeBacklogs: grp.sample.previousActiveBacklogs,
            latestResultStatus: grp.sample.previousResultStatus,
            lastPromotionBatchId: null,
          })
          .where(inArray(studentEnrollments.studentId, idChunk));
      }
    }

    await tx
      .update(promotionBatchItems)
      .set({ outcome: 'rolled_back' })
      .where(
        and(
          eq(promotionBatchItems.batchId, batch.id),
          eq(promotionBatchItems.outcome, 'promoted')
        )
      );

    await tx
      .update(studentAcademicHistory)
      .set({ status: 'rolled_back' })
      .where(eq(studentAcademicHistory.promotionBatchId, batch.id));

    const [updatedBatch] = await tx
      .update(promotionBatches)
      .set({
        status: 'rolled_back',
        rolledBackBy: params.actorId,
        rolledBackAt: new Date(),
        rollbackReason: cleanReason,
      })
      .where(eq(promotionBatches.id, batch.id))
      .returning();

    return {
      batch: updatedBatch,
      restoredCount: promotedItems.length,
    };
  });

  await writeAuditLog({
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    actorRole: 'super_admin',
    action: 'ACADEMIC_PROMOTION_ROLLED_BACK',
    entityType: 'promotion_batch',
    entityId: rolledBack.batch.id,
    details: {
      batchCode: rolledBack.batch.batchCode,
      restoredCount: rolledBack.restoredCount,
      reason: cleanReason,
    },
    ipAddress: params.actorIp ?? null,
  });

  return rolledBack;
}

export async function listPromotionHistory(limit = 30) {
  const batches = await db
    .select()
    .from(promotionBatches)
    .orderBy(desc(promotionBatches.createdAt))
    .limit(limit);

  const allSemesters = await db
    .select({
      id: semesters.id,
      semesterNumber: semesters.semesterNumber,
      label: semesters.label,
      yearLabel: academicYears.label,
    })
    .from(semesters)
    .innerJoin(academicYears, eq(semesters.academicYearId, academicYears.id));

  const allDepts = await db.select().from(departments);
  const semMap = new Map(allSemesters.map((s) => [s.id, s]));
  const deptMap = new Map(allDepts.map((d) => [d.id, d]));

  return batches.map((b) => ({
    ...b,
    fromSemesterLabel: semMap.get(b.fromSemesterId)?.label ?? 'Unknown',
    fromYearLabel: semMap.get(b.fromSemesterId)?.yearLabel ?? '',
    toSemesterLabel: semMap.get(b.toSemesterId)?.label ?? 'Unknown',
    toYearLabel: semMap.get(b.toSemesterId)?.yearLabel ?? '',
    departmentCode: b.departmentId ? deptMap.get(b.departmentId)?.code ?? 'Dept' : 'All 7 Departments',
  }));
}
