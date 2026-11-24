import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  academicYears,
  classes,
  collegeSettings,
  departments,
  jntuhRegulationRules,
  profiles,
  registrationQrCodes,
  roles,
  semesters,
  subjects,
} from '../db/schema.ts';

export const INITIAL_SUPER_ADMIN_EMAIL = 'mdnaseerali539@gmail.com';

const OFFICIAL_DEPARTMENTS = [
  { code: 'CSM C', name: 'CSM C — Computer Science & Engineering (AI & ML) Sec C' },
  { code: 'CSMB C', name: 'CSMB C — Computer Science & Engineering (AI & ML Batch B) Sec C' },
  { code: 'CSM A', name: 'CSM A — Computer Science & Engineering (AI & ML) Sec A' },
  { code: 'CSE C', name: 'CSE C — Computer Science & Engineering Sec C' },
  { code: 'CSE B', name: 'CSE B — Computer Science & Engineering Sec B' },
  { code: 'CSE A', name: 'CSE A — Computer Science & Engineering Sec A' },
  { code: 'CSD', name: 'CSD — Computer Science & Engineering (Data Science)' },
];

const CORE_SUBJECT_TEMPLATES = [
  { suffix: '101', name: 'Programming for Problem Solving', semesterNumber: 1, credits: 4 },
  { suffix: '201', name: 'Data Structures & Algorithms', semesterNumber: 2, credits: 4 },
  { suffix: '301', name: 'Database Management Systems', semesterNumber: 3, credits: 4 },
  { suffix: '401', name: 'Operating Systems', semesterNumber: 4, credits: 4 },
  { suffix: '501', name: 'Computer Networks', semesterNumber: 5, credits: 3 },
  { suffix: '601', name: 'Machine Learning & Pattern Recognition', semesterNumber: 6, credits: 4 },
  { suffix: '701', name: 'Cloud Computing & Distributed Systems', semesterNumber: 7, credits: 3 },
  { suffix: '801', name: 'Major Project & Seminar', semesterNumber: 8, credits: 6 },
];

let seedPromise: Promise<void> | null = null;

export async function ensureBaselineSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runBaselineSeed().catch((err) => {
      seedPromise = null;
      console.error('Baseline seed failed:', err);
      throw err;
    });
  }
  return seedPromise;
}

async function runBaselineSeed(): Promise<void> {
  // 1. Seed Roles
  const roleDefinitions = [
    {
      name: 'super_admin',
      description: 'College-wide Super Administrator with full governance and security access',
      permissions: [
        'manage_departments',
        'manage_academics',
        'manage_students',
        'approve_registrations',
        'manage_staff',
        'manage_admins',
        'manage_sessions',
        'correct_attendance',
        'manage_qr_codes',
        'manage_settings',
        'view_reports',
        'export_reports',
        'view_audit_logs',
        'manage_biometrics',
        'promote_students',
      ],
    },
    {
      name: 'staff',
      description: 'Faculty / Staff scoped to assigned departments, classes, and subjects',
      permissions: [
        'view_assigned_scope',
        'manage_assigned_sessions',
        'view_assigned_attendance',
        'assist_attendance',
        'request_corrections',
        'export_assigned_reports',
      ],
    },
    {
      name: 'student',
      description: 'Approved student with self-service attendance, camera verification, and history access',
      permissions: ['view_own_profile', 'view_own_attendance', 'enroll_biometrics', 'mark_attendance'],
    },
  ];

  for (const r of roleDefinitions) {
    await db
      .insert(roles)
      .values(r)
      .onConflictDoUpdate({
        target: roles.name,
        set: { description: r.description, permissions: r.permissions },
      });
  }

  const [superAdminRole] = await db
    .select()
    .from(roles)
    .where(eq(roles.name, 'super_admin'));

  // 2. Seed Initial Super Admin profile (no hardcoded password — owner signs in via Google OAuth or claims password securely)
  await db
    .insert(profiles)
    .values({
      roleId: superAdminRole.id,
      fullName: 'Swarna Bharathi Super Admin',
      email: INITIAL_SUPER_ADMIN_EMAIL,
      status: 'approved',
      emailVerified: true,
    })
    .onConflictDoNothing({ target: profiles.email });

  // 3. Seed 7 Official Departments
  for (const dept of OFFICIAL_DEPARTMENTS) {
    await db
      .insert(departments)
      .values(dept)
      .onConflictDoNothing({ target: departments.code });
  }

  // 4. Seed 4 Academic Years
  const yearDefs = [
    { yearNumber: 1, label: '1st Year', academicSession: '2026-2027' },
    { yearNumber: 2, label: '2nd Year', academicSession: '2026-2027' },
    { yearNumber: 3, label: '3rd Year', academicSession: '2026-2027' },
    { yearNumber: 4, label: '4th Year', academicSession: '2026-2027' },
  ];

  for (const y of yearDefs) {
    await db
      .insert(academicYears)
      .values(y)
      .onConflictDoNothing({ target: academicYears.yearNumber });
  }

  const allYears = await db.select().from(academicYears);
  const yearByNum = new Map(allYears.map((y) => [y.yearNumber, y]));

  // 5. Seed 8 Semesters
  for (let sem = 1; sem <= 8; sem++) {
    const yrNum = Math.ceil(sem / 2);
    const yr = yearByNum.get(yrNum);
    if (!yr) continue;
    await db
      .insert(semesters)
      .values({
        semesterNumber: sem,
        label: `Semester ${sem}`,
        academicYearId: yr.id,
      })
      .onConflictDoNothing({ target: semesters.semesterNumber });
  }

  const allDepts = await db.select().from(departments);
  const allSemesters = await db.select().from(semesters);
  const semByNum = new Map(allSemesters.map((s) => [s.semesterNumber, s]));

  // 6. Seed Default Classes & Subjects if empty
  const existingClasses = await db.select({ id: classes.id }).from(classes).limit(1);
  if (existingClasses.length === 0) {
    const classValues: Array<{
      departmentId: string;
      academicYearId: string;
      semesterId: string;
      sectionName: string;
      displayName: string;
    }> = [];

    for (const dept of allDepts) {
      for (const sem of allSemesters) {
        classValues.push({
          departmentId: dept.id,
          academicYearId: sem.academicYearId,
          semesterId: sem.id,
          sectionName: 'Regular',
          displayName: `${dept.code} · Sem ${sem.semesterNumber}`,
        });
      }
    }
    if (classValues.length > 0) {
      await db.insert(classes).values(classValues).onConflictDoNothing();
    }
  }

  const existingSubjects = await db.select({ id: subjects.id }).from(subjects).limit(1);
  if (existingSubjects.length === 0) {
    const subjectValues: Array<{
      code: string;
      name: string;
      departmentId: string;
      semesterId: string;
      credits: number;
    }> = [];

    for (const dept of allDepts) {
      const prefix = dept.code.replace(/\s+/g, '');
      for (const tmpl of CORE_SUBJECT_TEMPLATES) {
        const sem = semByNum.get(tmpl.semesterNumber);
        if (!sem) continue;
        subjectValues.push({
          code: `${prefix}-${tmpl.suffix}`,
          name: tmpl.name,
          departmentId: dept.id,
          semesterId: sem.id,
          credits: tmpl.credits,
        });
      }
    }
    if (subjectValues.length > 0) {
      await db.insert(subjects).values(subjectValues).onConflictDoNothing();
    }
  }

  // 7. Seed College Settings
  const existingSettings = await db.select({ id: collegeSettings.id }).from(collegeSettings).limit(1);
  if (existingSettings.length === 0) {
    await db.insert(collegeSettings).values({
      collegeName: 'Swarna Bharathi Institute of Science and Technology',
      logoUrl: '/src/assets/images/sbist_college_crest_1795533458624.jpg',
      locationVerificationEnabled: true,
      collegeLatitude: 17.2473,
      collegeLongitude: 80.1514,
      geofenceRadiusMeters: 300,
      attendanceFrequency: 'every_class_period',
      qrDefaultExpiryHours: 24,
      faceMatchThreshold: 0.5,
      livenessRequired: true,
      autoDailySessionsEnabled: true,
      morningStartTime: '09:00',
      morningEndTime: '09:40',
      afternoonStartTime: '13:30',
      afternoonEndTime: '13:40',
      workingWeekdays: [1, 2, 3, 4, 5, 6],
    });
  }

  // 8. Seed Permanent Lifetime Campus QR Codes (1. Everyday Attendance Check-In, 2. Student Registration)
  await db
    .insert(registrationQrCodes)
    .values({
      token: 'SBIST-ATTEND-CAMPUS',
      qrPurpose: 'attendance',
      label: 'Lifetime Campus Attendance QR (Hall Ticket + Face Check-In)',
      maxUses: null,
      expiresAt: null,
      isRevoked: false,
    })
    .onConflictDoUpdate({
      target: registrationQrCodes.token,
      set: {
        qrPurpose: 'attendance',
        label: 'Lifetime Campus Attendance QR (Hall Ticket + Face Check-In)',
        maxUses: null,
        expiresAt: null,
        isRevoked: false,
      },
    });

  await db
    .insert(registrationQrCodes)
    .values({
      token: 'SBIST-REGISTER-CAMPUS',
      qrPurpose: 'registration',
      label: 'Lifetime Campus Student Registration QR',
      maxUses: null,
      expiresAt: null,
      isRevoked: false,
    })
    .onConflictDoUpdate({
      target: registrationQrCodes.token,
      set: {
        qrPurpose: 'registration',
        label: 'Lifetime Campus Student Registration QR',
        maxUses: null,
        expiresAt: null,
        isRevoked: false,
      },
    });

  // 9. Seed JNTUH Regulation Rules (R22, R20, R18)
  const jntuhRules = [
    {
      code: 'R22',
      name: 'JNTUH B.Tech R22 Regulation (50% Credit Rule & 65% Min Attendance)',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 40,
      sem6To7MinCredits: 60,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
      isActive: true,
    },
    {
      code: 'R20',
      name: 'JNTUH B.Tech R20 Regulation (60% Credit Rule & 65% Min Attendance)',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 48,
      sem6To7MinCredits: 72,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
      isActive: true,
    },
    {
      code: 'R18',
      name: 'JNTUH B.Tech R18 Regulation (60% Credit Rule & 65% Min Attendance)',
      minAttendancePercent: 65,
      sem2To3MinCredits: 20,
      sem4To5MinCredits: 48,
      sem6To7MinCredits: 72,
      maxBacklogsForPromotion: null,
      requireResultPublished: true,
      isActive: true,
    },
  ];

  for (const rule of jntuhRules) {
    await db
      .insert(jntuhRegulationRules)
      .values(rule)
      .onConflictDoNothing({ target: jntuhRegulationRules.code });
  }
}
