import { Router } from 'express';
import ExcelJS from 'exceljs';
import { and, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  academicYears,
  attendanceRecords,
  attendanceSessions,
  calendarOverrides,
  classes,
  collegeSettings,
  departments,
  holidays,
  profiles,
  semesters,
  subjects,
} from '../../db/schema.ts';
import { type AuthRequest, getStaffScope, requireAuth, requireRole } from '../../middleware/auth.ts';
import { formatISTTimestamp, isValidUuid } from '../crypto.ts';
import { writeAuditLog } from '../audit.ts';
import { syncAutomaticDailySessions } from '../attendanceScheduler.ts';
import {
  isSessionDateBlocked,
  NO_ATTENDANCE_DATA_MESSAGE,
  roundPercentage2,
} from '../attendanceCalculator.ts';

export const reportRouter = Router();

reportRouter.use(requireAuth, requireRole('super_admin', 'staff'));

async function buildReportQueryFilters(req: AuthRequest) {
  const user = req.authProfile!;
  const reportType = (req.query.reportType as string) || 'daily';
  const date = (req.query.date as string) || '';
  const month = (req.query.month as string) || ''; // YYYY-MM
  const departmentId = (req.query.departmentId as string) || '';
  const classId = (req.query.classId as string) || '';
  const subjectId = (req.query.subjectId as string) || '';
  const semesterId = (req.query.semesterId as string) || '';
  const search = ((req.query.search as string) || '').trim();

  const conditions: SQL[] = [ne(attendanceSessions.status, 'cancelled')];

  if (user.role === 'staff') {
    const scope = await getStaffScope(user.id);
    if (scope.departmentIds.length === 0) {
      return { empty: true as const, reportType, conditions };
    }
    conditions.push(inArray(attendanceRecords.departmentId, scope.departmentIds));
    if (scope.classIds.length > 0) {
      conditions.push(inArray(attendanceRecords.classId, scope.classIds));
    }
    if (scope.subjectIds.length > 0) {
      conditions.push(
        or(
          inArray(attendanceRecords.subjectId, scope.subjectIds),
          isNull(attendanceRecords.subjectId)
        )!
      );
    }
  }

  if (date) {
    conditions.push(eq(attendanceRecords.attendanceDate, date));
  } else if (month && /^\d{4}-\d{2}$/.test(month)) {
    conditions.push(gte(attendanceRecords.attendanceDate, `${month}-01`));
    conditions.push(lte(attendanceRecords.attendanceDate, `${month}-31`));
  }

  if (isValidUuid(departmentId)) conditions.push(eq(attendanceRecords.departmentId, departmentId));
  if (isValidUuid(classId)) conditions.push(eq(attendanceRecords.classId, classId));
  if (isValidUuid(subjectId)) conditions.push(eq(attendanceRecords.subjectId, subjectId));
  if (isValidUuid(semesterId)) conditions.push(eq(attendanceSessions.semesterId, semesterId));
  if (search) {
    conditions.push(
      or(
        ilike(profiles.fullName, `%${search}%`),
        ilike(profiles.rollNumber, `%${search}%`)
      )!
    );
  }

  return { empty: false as const, reportType, conditions };
}

reportRouter.get('/attendance', async (req: AuthRequest, res) => {
  try {
    await syncAutomaticDailySessions();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const filterInfo = await buildReportQueryFilters(req);
    if (filterInfo.empty) {
      return res.json({
        items: [],
        summary: {
          totalRecords: 0,
          presentCount: 0,
          absentCount: 0,
          percentage: 0,
          hasData: false,
          message: NO_ATTENDANCE_DATA_MESSAGE,
        },
        pagination: { page, limit, total: 0, totalPages: 1 },
      });
    }

    const whereClause = filterInfo.conditions.length > 0 ? and(...filterInfo.conditions) : undefined;

    const [holidayRows, overrideRows, allMatchingRows] = await Promise.all([
      db.select().from(holidays),
      db.select().from(calendarOverrides),
      db
        .select({
          id: attendanceRecords.id,
          attendanceDate: attendanceRecords.attendanceDate,
          status: attendanceRecords.status,
        })
        .from(attendanceRecords)
        .innerJoin(profiles, eq(attendanceRecords.studentId, profiles.id))
        .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
        .where(whereClause),
    ]);

    const nonHolidayRows = allMatchingRows.filter(
      (r) => !isSessionDateBlocked(r.attendanceDate, holidayRows, overrideRows)
    );
    const total = nonHolidayRows.length;
    const presentCount = nonHolidayRows.filter(
      (r) => r.status === 'present' || r.status === 'excused'
    ).length;
    const absentCount = nonHolidayRows.filter((r) => r.status === 'absent').length;

    const rawItems = await db
      .select({
        id: attendanceRecords.id,
        studentName: profiles.fullName,
        rollNumber: profiles.rollNumber,
        email: profiles.email,
        departmentCode: departments.code,
        yearLabel: academicYears.label,
        semesterLabel: semesters.label,
        className: classes.displayName,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        periodSlot: attendanceSessions.periodSlot,
        sessionCode: attendanceSessions.sessionCode,
        attendanceDate: attendanceRecords.attendanceDate,
        markedAt: attendanceRecords.markedAt,
        status: attendanceRecords.status,
        verificationMethod: attendanceRecords.verificationMethod,
        verificationResult: attendanceRecords.verificationResult,
        faceConfidence: attendanceRecords.faceConfidence,
        livenessPassed: attendanceRecords.livenessPassed,
      })
      .from(attendanceRecords)
      .innerJoin(profiles, eq(attendanceRecords.studentId, profiles.id))
      .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
      .innerJoin(departments, eq(attendanceRecords.departmentId, departments.id))
      .innerJoin(classes, eq(attendanceRecords.classId, classes.id))
      .innerJoin(academicYears, eq(attendanceSessions.academicYearId, academicYears.id))
      .innerJoin(semesters, eq(attendanceSessions.semesterId, semesters.id))
      .leftJoin(subjects, eq(attendanceRecords.subjectId, subjects.id))
      .where(whereClause)
      .orderBy(desc(attendanceRecords.attendanceDate), desc(attendanceRecords.markedAt))
      .limit(limit)
      .offset(offset);

    const items = rawItems.filter(
      (r) => !isSessionDateBlocked(r.attendanceDate, holidayRows, overrideRows)
    );

    const hasData = total > 0;
    res.json({
      reportType: filterInfo.reportType,
      items: items.map((r) => ({
        ...r,
        subjectCode: r.subjectCode ?? 'DAILY',
        subjectName:
          r.subjectName ??
          (r.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call'),
        markedAtIST: formatISTTimestamp(new Date(r.markedAt)),
      })),
      summary: {
        totalRecords: total,
        presentCount,
        absentCount,
        percentage: roundPercentage2(presentCount, total),
        hasData,
        message: hasData ? null : NO_ATTENDANCE_DATA_MESSAGE,
      },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error('Report query error:', err);
    res.status(500).json({ error: 'Failed to generate attendance report.' });
  }
});

reportRouter.get('/export/excel', async (req: AuthRequest, res) => {
  try {
    await syncAutomaticDailySessions();
    const user = req.authProfile!;
    const filterInfo = await buildReportQueryFilters(req);
    const [settings] = await db.select().from(collegeSettings).limit(1);
    const collegeName =
      settings?.collegeName || 'Swarna Bharathi Institute of Science and Technology';

    const whereClause = filterInfo.conditions.length > 0 ? and(...filterInfo.conditions) : undefined;
    const [holidayRows, overrideRows, rawRows] = await Promise.all([
      db.select().from(holidays),
      db.select().from(calendarOverrides),
      filterInfo.empty
        ? Promise.resolve([])
        : db
            .select({
              rollNumber: profiles.rollNumber,
              studentName: profiles.fullName,
              departmentCode: departments.code,
              yearLabel: academicYears.label,
              semesterLabel: semesters.label,
              className: classes.displayName,
              subjectCode: subjects.code,
              subjectName: subjects.name,
              periodSlot: attendanceSessions.periodSlot,
              sessionCode: attendanceSessions.sessionCode,
              attendanceDate: attendanceRecords.attendanceDate,
              markedAt: attendanceRecords.markedAt,
              status: attendanceRecords.status,
              verificationMethod: attendanceRecords.verificationMethod,
              faceConfidence: attendanceRecords.faceConfidence,
            })
            .from(attendanceRecords)
            .innerJoin(profiles, eq(attendanceRecords.studentId, profiles.id))
            .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
            .innerJoin(departments, eq(attendanceRecords.departmentId, departments.id))
            .innerJoin(classes, eq(attendanceRecords.classId, classes.id))
            .innerJoin(academicYears, eq(attendanceSessions.academicYearId, academicYears.id))
            .innerJoin(semesters, eq(attendanceSessions.semesterId, semesters.id))
            .leftJoin(subjects, eq(attendanceRecords.subjectId, subjects.id))
            .where(whereClause)
            .orderBy(desc(attendanceRecords.attendanceDate), desc(attendanceRecords.markedAt))
            .limit(5000),
    ]);

    const rows = rawRows.filter(
      (r) => !isSessionDateBlocked(r.attendanceDate, holidayRows, overrideRows)
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = collegeName;
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Attendance Report');
    sheet.mergeCells('A1:K1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = collegeName;
    titleCell.font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

    sheet.mergeCells('A2:K2');
    const subCell = sheet.getCell('A2');
    subCell.value = `Smart Attendance Management System — Report Type: ${filterInfo.reportType.toUpperCase()} | Generated: ${formatISTTimestamp()}`;
    subCell.font = { name: 'Calibri', size: 10, color: { argb: 'FF475569' } };
    subCell.alignment = { horizontal: 'center', vertical: 'middle' };

    sheet.addRow([]);

    const headers = [
      'Roll Number',
      'Student Name',
      'Department',
      'Academic Year',
      'Semester',
      'Class / Section',
      'Subject',
      'Session Code',
      'Date (IST)',
      'Timestamp (IST)',
      'Status / Method',
    ];
    const headerRow = sheet.addRow(headers);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
    });

    for (const r of rows) {
      const subCode = r.subjectCode ?? 'DAILY';
      const subName =
        r.subjectName ??
        (r.periodSlot === 'afternoon' ? 'Afternoon Roll Call' : 'Morning Roll Call');
      sheet.addRow([
        r.rollNumber || '-',
        r.studentName,
        r.departmentCode,
        r.yearLabel,
        r.semesterLabel,
        r.className,
        `${subCode} - ${subName}`,
        r.sessionCode,
        r.attendanceDate,
        formatISTTimestamp(new Date(r.markedAt)),
        `${r.status.toUpperCase()} (${r.verificationMethod})`,
      ]);
    }

    sheet.columns.forEach((col) => {
      col.width = 22;
    });

    await writeAuditLog({
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'EXPORT_EXCEL_REPORT',
      entityType: 'report',
      details: { reportType: filterInfo.reportType, rowCount: rows.length },
      ipAddress: req.clientIp,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="SBIST-Attendance-${filterInfo.reportType}.xlsx"`
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ error: 'Failed to export Excel workbook.' });
  }
});
