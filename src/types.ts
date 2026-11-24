export type PortalRole = 'super_admin' | 'staff' | 'student';

export interface CollegeSettings {
  id: string;
  collegeName: string;
  logoUrl: string | null;
  locationVerificationEnabled: boolean;
  collegeLatitude: number;
  collegeLongitude: number;
  geofenceRadiusMeters: number;
  attendanceFrequency: 'once_per_day' | 'morning_afternoon' | 'every_class_period';
  qrDefaultExpiryHours: number;
  faceMatchThreshold: number;
  livenessRequired: boolean;
  autoDailySessionsEnabled: boolean;
  morningStartTime: string;
  morningEndTime: string;
  afternoonStartTime: string;
  afternoonEndTime: string;
  workingWeekdays: number[];
}

export interface Department {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface AcademicYear {
  id: string;
  yearNumber: number;
  label: string;
  academicSession: string;
  isActive: boolean;
}

export interface Semester {
  id: string;
  semesterNumber: number;
  label: string;
  academicYearId: string;
  isActive: boolean;
}

export interface AuthProfile {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  rollNumber: string | null;
  employeeId: string | null;
  role: PortalRole;
  permissions: string[];
  status: string;
  emailVerified: boolean;
  hasPassword: boolean;
}

export interface StudentEnrollmentInfo {
  id: string;
  rollNumber: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  academicYearId: string;
  yearLabel: string;
  semesterId: string;
  semesterLabel: string;
  semesterNumber?: number;
  classId: string;
  className: string;
  isActive: boolean;
  regulation?: string;
  academicStanding?: string;
  creditsEarned?: number;
  activeBacklogs?: number;
  latestResultStatus?: string;
}

export interface BiometricStatusInfo {
  enrolled: boolean;
  sampleCount: number;
  consentTimestamp: string | null;
  retentionPolicyVersion: string | null;
}

export interface StaffAssignmentInfo {
  id: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  classId: string | null;
  className: string | null;
  subjectId: string | null;
  subjectCode: string | null;
  subjectName: string | null;
  canCreateSessions: boolean;
}

export interface AuthMeResponse {
  profile: AuthProfile;
  enrollment: StudentEnrollmentInfo | null;
  biometricStatus: BiometricStatusInfo;
  assignments: StaffAssignmentInfo[];
  collegeSettings: CollegeSettings | null;
}
