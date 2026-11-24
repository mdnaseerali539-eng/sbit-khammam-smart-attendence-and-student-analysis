import React, { useEffect, useState } from 'react';
import { CheckCircle2, ArrowLeft, QrCode } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { AcademicYear, CollegeSettings, Department, Semester } from '../types';

interface QrRegistrationViewProps {
  initialToken: string;
  collegeSettings: CollegeSettings | null;
  departments: Department[];
  academicYears: AcademicYear[];
  semesters: Semester[];
  onBackToLogin: () => void;
}

export const QrRegistrationView: React.FC<QrRegistrationViewProps> = ({
  initialToken,
  collegeSettings,
  departments,
  academicYears,
  semesters,
  onBackToLogin,
}) => {
  const [qrToken, setQrToken] = useState(initialToken || 'SBIST-REGISTER-CAMPUS');
  const [qrInfo, setQrInfo] = useState<{ label: string; departmentId: string | null; academicYearId: string | null; semesterId: string | null } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [checkingQr, setCheckingQr] = useState(false);

  const [fullName, setFullName] = useState('');
  const [rollNumber, setRollNumber] = useState('');
  const [departmentId, setDepartmentId] = useState(departments[0]?.id || '');
  const [academicYearId, setAcademicYearId] = useState(academicYears[0]?.id || '');
  const [semesterId, setSemesterId] = useState(semesters[0]?.id || '');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedResult, setSubmittedResult] = useState<{
    message: string;
    rollNumber: string;
  } | null>(null);

  useEffect(() => {
    if (!departmentId && departments.length > 0) {
      setDepartmentId(departments[0].id);
    }
  }, [departmentId, departments]);

  useEffect(() => {
    if (!academicYearId && academicYears.length > 0) {
      setAcademicYearId(academicYears[0].id);
    }
  }, [academicYearId, academicYears]);

  useEffect(() => {
    if (!semesterId && semesters.length > 0) {
      setSemesterId(semesters[0].id);
    }
  }, [semesterId, semesters]);

  useEffect(() => {
    if (!qrToken.trim()) return;
    let cancelled = false;
    setCheckingQr(true);
    setQrError(null);
    apiFetch<{ qr: { label: string; departmentId: string | null; academicYearId: string | null; semesterId: string | null } }>(
      `/api/qr/${encodeURIComponent(qrToken.trim())}`,
      { skipAuth: true }
    )
      .then((res) => {
        if (cancelled) return;
        setQrInfo(res.qr);
        if (res.qr.departmentId) setDepartmentId(res.qr.departmentId);
        if (res.qr.academicYearId) setAcademicYearId(res.qr.academicYearId);
        if (res.qr.semesterId) setSemesterId(res.qr.semesterId);
      })
      .catch((err) => {
        if (cancelled) return;
        setQrInfo(null);
        setQrError(err instanceof Error ? err.message : 'Invalid QR code.');
      })
      .finally(() => {
        if (!cancelled) setCheckingQr(false);
      });
    return () => {
      cancelled = true;
    };
  }, [qrToken]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!departmentId || !academicYearId || !semesterId) {
      setSubmitError('Academic options are still loading. Please select a department, year, and semester.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ message: string; rollNumber: string }>('/api/qr/register', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({
          qrToken: qrToken.trim(),
          fullName,
          rollNumber,
          departmentId,
          academicYearId,
          semesterId,
          email,
          phone,
        }),
      });
      setSubmittedResult(res);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Registration submission failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-8 px-4">
      <div className="mx-auto w-full max-w-xl bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm">
        <div className="flex items-center gap-3 pb-5 border-b border-slate-200">
          <img
            src={collegeSettings?.logoUrl || '/src/assets/images/sbist_college_crest_1795533458624.jpg'}
            alt="Swarna Bharathi Institute of Science and Technology Logo"
            referrerPolicy="no-referrer"
            className="h-12 w-12 rounded-lg object-contain border border-slate-200 bg-white p-1"
          />
          <div>
            <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight">
              {collegeSettings?.collegeName || 'Swarna Bharathi Institute of Science and Technology'}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Smart Attendance Management System · Student QR Registration
            </p>
          </div>
        </div>

        {submittedResult ? (
          <div className="py-8 space-y-4 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
            <h2 className="text-lg font-semibold text-slate-900">Registration Pending Approval</h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              {submittedResult.message}
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 font-mono-tabular">
              Roll Number: {submittedResult.rollNumber} · Status: Pending Approval
            </div>
            <p className="text-xs text-slate-500">
              Face biometric enrollment will unlock automatically after Super Admin approval.
            </p>
            <button
              type="button"
              onClick={onBackToLogin}
              className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              Return to Login Portal
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Registration QR Token
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <QrCode className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    required
                    value={qrToken}
                    onChange={(e) => setQrToken(e.target.value)}
                    placeholder="SBIST-..."
                    className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              {checkingQr && <p className="text-xs text-slate-500 mt-1">Validating QR code...</p>}
              {qrInfo && (
                <p className="text-xs text-emerald-700 mt-1">
                  Verified QR Batch: {qrInfo.label}
                </p>
              )}
              {qrError && <p className="text-xs text-red-600 mt-1">{qrError}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Karthikeya Sharma"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Roll Number</label>
                <input
                  type="text"
                  required
                  value={rollNumber}
                  onChange={(e) => setRollNumber(e.target.value)}
                  placeholder="e.g. 24SB1A0501"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-tabular uppercase focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Department</label>
                <select
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {departments.length === 0 && (
                    <option value="" disabled>
                      Loading departments...
                    </option>
                  )}
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Academic Year</label>
                <select
                  value={academicYearId}
                  onChange={(e) => setAcademicYearId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {academicYears.length === 0 && (
                    <option value="" disabled>
                      Loading years...
                    </option>
                  )}
                  {academicYears.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Semester</label>
                <select
                  value={semesterId}
                  onChange={(e) => setSemesterId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {semesters.length === 0 && (
                    <option value="" disabled>
                      Loading semesters...
                    </option>
                  )}
                  {semesters.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Gmail Address</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="student@gmail.com"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="9876543210"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <p className="text-xs text-slate-500">
              Note: Email verification does not prove college enrollment. Super Admin approval is mandatory before portal access is activated.
            </p>

            {submitError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {submitError}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={onBackToLogin}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Login
              </button>
              <button
                type="submit"
                disabled={submitting || !qrInfo}
                className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Submit Registration'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
