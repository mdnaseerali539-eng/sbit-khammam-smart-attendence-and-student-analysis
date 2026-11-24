import { useCallback, useEffect, useState } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from './lib/firebase';
import { apiFetch, getAuthToken, setAuthToken } from './lib/api';
import { AcademicYear, AuthMeResponse, CollegeSettings, Department, Semester } from './types';
import { LoginView } from './components/LoginView';
import { QrRegistrationView } from './components/QrRegistrationView';
import { QrAttendanceCheckInView } from './components/QrAttendanceCheckInView';
import { StudentPortal } from './components/StudentPortal';
import { StaffPortal } from './components/StaffPortal';
import { AdminPortal } from './components/AdminPortal';
import { HelpChatbot } from './components/HelpChatbot';

export default function App() {
  const [publicInfo, setPublicInfo] = useState<{
    settings: CollegeSettings | null;
    departments: Department[];
    academicYears: AcademicYear[];
    semesters: Semester[];
  }>({
    settings: null,
    departments: [],
    academicYears: [],
    semesters: [],
  });

  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loadingMe, setLoadingMe] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [portalBannerMsg, setPortalBannerMsg] = useState<string | null>(null);

  const pathname = window.location.pathname.toLowerCase();
  const searchParams = new URLSearchParams(window.location.search);
  const initialQrToken = searchParams.get('registerQr') || '';
  const initialAttendQrToken = searchParams.get('attendQr') || '';
  const initialSetupToken = searchParams.get('setupToken') || '';

  const [showQrRegister, setShowQrRegister] = useState(
    Boolean(initialQrToken) || pathname === '/register' || pathname === '/qr-register'
  );
  const [showQrAttend, setShowQrAttend] = useState(
    Boolean(initialAttendQrToken) || pathname === '/attend' || pathname === '/check-in'
  );

  useEffect(() => {
    apiFetch<typeof publicInfo>('/api/college/public-info', { skipAuth: true })
      .then((res) => setPublicInfo(res))
      .catch(() => {});
  }, []);

  const fetchMe = useCallback(async () => {
    if (!getAuthToken()) {
      setMe(null);
      return;
    }
    setLoadingMe(true);
    setAuthError(null);
    try {
      const res = await apiFetch<AuthMeResponse>('/api/auth/me');
      setMe(res);
    } catch (err) {
      setAuthToken(null);
      setMe(null);
      setAuthError(err instanceof Error ? err.message : 'Session validation failed.');
    } finally {
      setLoadingMe(false);
    }
  }, []);

  const handleLogout = useCallback(async () => {
    setAuthToken(null);
    setMe(null);
    setPortalBannerMsg(null);
    try {
      await signOut(auth);
    } catch {
      // Ignore if not signed in via Firebase
    }
  }, []);

  let view: React.ReactNode;

  if (showQrRegister) {
    view = (
      <QrRegistrationView
        initialToken={initialQrToken}
        collegeSettings={publicInfo.settings}
        departments={publicInfo.departments}
        academicYears={publicInfo.academicYears}
        semesters={publicInfo.semesters}
        onBackToLogin={() => {
          setShowQrRegister(false);
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  } else if (showQrAttend && !me) {
    view = (
      <QrAttendanceCheckInView
        initialToken={initialAttendQrToken}
        collegeSettings={publicInfo.settings}
        onAuthenticated={(msg) => {
          if (msg) setPortalBannerMsg(msg);
          setShowQrAttend(false);
          fetchMe();
        }}
        onBackToLogin={() => {
          setShowQrAttend(false);
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  } else if (loadingMe) {
    view = (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 text-sm text-slate-700">
          Verifying institutional account and loading portal...
        </div>
      </div>
    );
  } else if (!me) {
    view = (
      <div>
        {authError && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2.5 text-center text-xs font-medium text-red-800">
            {authError}
          </div>
        )}
        <LoginView
          collegeSettings={publicInfo.settings}
          initialSetupToken={initialSetupToken}
          onAuthenticated={fetchMe}
          onClearAuthError={() => setAuthError(null)}
          onOpenQrRegistration={() => setShowQrRegister(true)}
          onOpenQrAttendance={() => setShowQrAttend(true)}
        />
      </div>
    );
  } else if (me.profile.role === 'super_admin') {
    view = <AdminPortal me={me} onLogout={handleLogout} />;
  } else if (me.profile.role === 'staff') {
    view = (
      <StaffPortal
        me={me}
        departments={publicInfo.departments}
        semesters={publicInfo.semesters}
        onLogout={handleLogout}
      />
    );
  } else {
    view = <StudentPortal me={me} initialBannerMsg={portalBannerMsg} onLogout={handleLogout} />;
  }

  return (
    <>
      {view}
      <HelpChatbot />
    </>
  );
}
