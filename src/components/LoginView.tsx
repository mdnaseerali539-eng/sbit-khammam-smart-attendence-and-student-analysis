import React, { useEffect, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { signInWithPopup } from 'firebase/auth';
import { KeyRound, Loader2, LogIn, QrCode, Shield, UserCheck, GraduationCap, X } from 'lucide-react';
import {
  auth,
  browserPopupRedirectResolver,
  createGoogleAuthProvider,
  firebaseConfig,
} from '../lib/firebase';
import { apiFetch, setAuthToken } from '../lib/api';
import { CollegeSettings, PortalRole } from '../types';

const GOOGLE_POPUP_TIMEOUT_MS = 45_000;

function formatGoogleAuthError(err: unknown): string {
  if (err instanceof FirebaseError) {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
    switch (err.code) {
      case 'auth/unauthorized-domain':
        return `Google Sign-In cannot open on "${host}" because this domain is not listed in Firebase Authentication Authorized Domains for project "${firebaseConfig.projectId}".`;
      case 'auth/popup-blocked':
        return 'Your browser blocked the Google account selection popup. Please allow popups for this site and click Continue with Google again.';
      case 'auth/popup-closed-by-user':
        return 'The Google account selection window was closed before completing sign-in. Click Continue with Google to try again.';
      case 'auth/cancelled-popup-request':
        return 'Sign-in request was interrupted by another sign-in attempt. Please click Continue with Google again.';
      case 'auth/operation-not-allowed':
        return 'Google Sign-In provider is not enabled in Firebase Authentication for this project.';
      case 'auth/network-request-failed':
        return 'Network error while contacting Google Sign-In. Check your connection and try again.';
      case 'auth/internal-error':
        return 'Google Sign-In failed to initialize the account selection popup. Ensure popups are allowed and the current domain is authorized in Firebase.';
      default:
        return err.message || `Google Sign-In failed (${err.code}).`;
    }
  }
  return err instanceof Error ? err.message : 'Google Sign-In failed.';
}

interface LoginViewProps {
  collegeSettings: CollegeSettings | null;
  initialSetupToken: string;
  onAuthenticated: () => void | Promise<void>;
  onClearAuthError?: () => void;
  onOpenQrRegistration: () => void;
  onOpenQrAttendance: () => void;
}

export const LoginView: React.FC<LoginViewProps> = ({
  collegeSettings,
  initialSetupToken,
  onAuthenticated,
  onClearAuthError,
  onOpenQrRegistration,
  onOpenQrAttendance,
}) => {
  const [selectedPortal, setSelectedPortal] = useState<PortalRole>('student');
  const [mode, setMode] = useState<'signin' | 'claim'>(initialSetupToken ? 'claim' : 'signin');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState(initialSetupToken);
  const [newPassword, setNewPassword] = useState('');

  const [googleLoading, setGoogleLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const googleAttemptRef = useRef(0);
  const cancelGooglePopupRef = useRef<(() => void) | null>(null);
  const isBusy = googleLoading || passwordLoading;

  useEffect(() => {
    void auth.authStateReady().catch(() => {});
    return () => {
      googleAttemptRef.current += 1;
      cancelGooglePopupRef.current?.();
      cancelGooglePopupRef.current = null;
    };
  }, []);

  function handleCancelGoogleLogin() {
    googleAttemptRef.current += 1;
    cancelGooglePopupRef.current?.();
    cancelGooglePopupRef.current = null;
    setGoogleLoading(false);
    setError('Google Sign-In was cancelled. Click Continue with Google to open the account selector again.');
  }

  async function handleGoogleLogin() {
    if (isBusy) return;
    onClearAuthError?.();
    setError(null);
    setInfoMsg(null);
    setGoogleLoading(true);

    const attemptId = ++googleAttemptRef.current;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      // Trigger signInWithPopup immediately inside the click gesture with a fresh
      // GoogleAuthProvider (prompt: 'select_account') so popup blockers do not suppress it.
      const provider = createGoogleAuthProvider();
      const popupPromise = signInWithPopup(auth, provider, browserPopupRedirectResolver);

      const racePromise = new Promise<Awaited<typeof popupPromise>>((resolve, reject) => {
        cancelGooglePopupRef.current = () => {
          reject(new Error('__CANCELLED__'));
        };

        timeoutId = setTimeout(() => {
          reject(
            new Error(
              'Google account selection did not respond in time. Please check if a popup was blocked by your browser or embedded view and try again.'
            )
          );
        }, GOOGLE_POPUP_TIMEOUT_MS);

        popupPromise.then(resolve, reject);
      });

      const cred = await racePromise;
      if (attemptId !== googleAttemptRef.current) return;

      const idToken = await cred.user.getIdToken(true);
      if (attemptId !== googleAttemptRef.current) return;

      setAuthToken(idToken);
      await onAuthenticated();
    } catch (err: unknown) {
      if (attemptId !== googleAttemptRef.current) return;
      setAuthToken(null);
      if (err instanceof Error && err.message === '__CANCELLED__') {
        return;
      }
      setError(formatGoogleAuthError(err));
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (attemptId === googleAttemptRef.current) {
        cancelGooglePopupRef.current = null;
        setGoogleLoading(false);
      }
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    if (isBusy) return;
    onClearAuthError?.();
    setError(null);
    setPasswordLoading(true);
    try {
      const res = await apiFetch<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setAuthToken(res.token);
      await onAuthenticated();
    } catch (err: unknown) {
      setAuthToken(null);
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleClaimPassword(e: React.FormEvent) {
    e.preventDefault();
    if (isBusy) return;
    onClearAuthError?.();
    setError(null);
    setInfoMsg(null);
    setPasswordLoading(true);
    try {
      const res = await apiFetch<{ token: string; message: string }>('/api/auth/claim-with-token', {
        method: 'POST',
        body: JSON.stringify({ setupToken, password: newPassword }),
      });
      setAuthToken(res.token);
      setInfoMsg(res.message);
      await onAuthenticated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to claim account password.');
    } finally {
      setPasswordLoading(false);
    }
  }

  const portalInfo = {
    student: {
      title: 'Student Portal',
      desc: 'View attendance history, monthly calendar, face enrollment, and mark classroom attendance.',
      icon: GraduationCap,
    },
    staff: {
      title: 'Staff Portal',
      desc: 'Manage assigned classes, active sessions, daily rosters, and department attendance reports.',
      icon: UserCheck,
    },
    super_admin: {
      title: 'Super Admin Portal',
      desc: 'Full college governance, student approvals, staff assignments, geofence, QR codes, and audits.',
      icon: Shield,
    },
  }[selectedPortal];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between py-8 px-4">
      <div className="mx-auto w-full max-w-5xl">
        {/* Institutional Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-slate-200">
          <div className="flex items-center gap-3.5">
            <img
              src={collegeSettings?.logoUrl || '/src/assets/images/sbist_college_crest_1795533458624.jpg'}
              alt="Swarna Bharathi Institute of Science and Technology Logo"
              referrerPolicy="no-referrer"
              className="h-14 w-14 rounded-xl object-contain border border-slate-200 bg-white p-1 shrink-0"
            />
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
                {collegeSettings?.collegeName || 'Swarna Bharathi Institute of Science and Technology'}
              </h1>
              <p className="text-xs sm:text-sm text-slate-500">
                Smart Attendance Management System · Official Academic Portal
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenQrAttendance}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 whitespace-nowrap"
            >
              <QrCode className="h-4 w-4" />
              Face Check-In (Hall Ticket)
            </button>
            <button
              type="button"
              onClick={onOpenQrRegistration}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
            >
              <QrCode className="h-4 w-4 text-blue-700" />
              Student QR Registration
            </button>
          </div>
        </div>

        {/* Main Split Grid */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Institutional Info & Portal Selection */}
          <div className="lg:col-span-5 flex flex-col justify-between bg-slate-900 text-white rounded-xl p-6 sm:p-8">
            <div className="space-y-6">
              <div>
                <p className="text-xs font-medium text-slate-300">Select Your Portal</p>
                <div className="mt-3 grid grid-cols-3 gap-1.5 bg-slate-800 p-1 rounded-lg">
                  {(['student', 'staff', 'super_admin'] as PortalRole[]).map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setSelectedPortal(role)}
                      className={`px-2.5 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        selectedPortal === role
                          ? 'bg-white text-slate-900'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {role === 'super_admin' ? 'Super Admin' : role === 'staff' ? 'Staff' : 'Student'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-blue-300">
                  <portalInfo.icon className="h-5 w-5" />
                  <span className="text-sm font-semibold">{portalInfo.title}</span>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">{portalInfo.desc}</p>
              </div>

              {selectedPortal === 'super_admin' && (
                <div className="rounded-lg border border-slate-700 bg-slate-800/70 p-4 text-xs text-slate-300 space-y-1.5">
                  <p className="font-semibold text-white">Authorized Super Admin Access</p>
                  <p>
                    The initial Super Admin account (<span className="font-mono-tabular text-white">mdnaseerali539@gmail.com</span>)
                    authenticates securely via Google Sign-In and may set a portal password inside
                    Security Settings. Additional administrators can only be created by an authorized Super Admin.
                  </p>
                </div>
              )}

              <div className="border-t border-slate-800 pt-5 space-y-2 text-xs text-slate-400">
                <p className="font-medium text-slate-200">Supported Academic Departments</p>
                <p>CSM C · CSMB C · CSM A · CSE C · CSE B · CSE A · CSD</p>
              </div>
            </div>

            <div className="pt-6 text-xs text-slate-400">
              All timestamps recorded in Indian Standard Time (IST).
            </div>
          </div>

          {/* Right Authentication Card */}
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-center">
            <div className="flex items-center justify-between border-b border-slate-200 pb-4 mb-6">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {mode === 'signin' ? `Sign in to ${portalInfo.title}` : 'Activate Account & Set Password'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {mode === 'signin'
                    ? 'Use Google Sign-In or your institutional credentials'
                    : 'Enter the one-time setup token provided upon Super Admin approval'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode(mode === 'signin' ? 'claim' : 'signin');
                }}
                className="text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap"
              >
                {mode === 'signin' ? 'Have a setup token?' : 'Back to Sign In'}
              </button>
            </div>

            {mode === 'signin' ? (
              <div className="space-y-5">
                <div className="space-y-2.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleGoogleLogin}
                    className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-medium text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-60"
                  >
                    {googleLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-blue-700" />
                        <span>Waiting for Google account selection...</span>
                      </>
                    ) : (
                      <>
                        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            fill="#4285F4"
                            d="M23.745 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-8.97z"
                          />
                          <path
                            fill="#34A853"
                            d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                          />
                          <path
                            fill="#FBBC05"
                            d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                          />
                          <path
                            fill="#EA4335"
                            d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                          />
                        </svg>
                        <span>Continue with Google (Recommended)</span>
                      </>
                    )}
                  </button>

                  {googleLoading && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs text-blue-800">
                      <span>Select your Google account in the popup window. If no window appeared, check popup permissions.</span>
                      <button
                        type="button"
                        onClick={handleCancelGoogleLogin}
                        className="inline-flex items-center gap-1 font-medium text-blue-900 hover:underline shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </button>
                    </div>
                  )}

                  {error && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700"
                    >
                      {error}
                    </div>
                  )}
                </div>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-slate-200" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-white px-3 text-slate-400">or sign in with email & password</span>
                  </div>
                </div>

                <form onSubmit={handlePasswordLogin} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Registered Email Address
                    </label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={
                        selectedPortal === 'super_admin'
                          ? 'mdnaseerali539@gmail.com'
                          : 'name@gmail.com'
                      }
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Password</label>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your portal password"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isBusy}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                  >
                    <LogIn className="h-4 w-4" />
                    {passwordLoading ? 'Signing in...' : 'Sign In'}
                  </button>
                </form>
              </div>
            ) : (
              <form onSubmit={handleClaimPassword} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    One-Time Account Setup Token
                  </label>
                  <input
                    type="text"
                    required
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    placeholder="Paste setup token from admin approval"
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono-tabular focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Choose New Password (min 8 characters)
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Create a strong password"
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>

                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
                    {error}
                  </div>
                )}
                {infoMsg && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs text-emerald-700">
                    {infoMsg}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isBusy}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
                >
                  <KeyRound className="h-4 w-4" />
                  {passwordLoading ? 'Activating Account...' : 'Set Password & Enter Portal'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      <footer className="mx-auto w-full max-w-5xl mt-8 pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>Swarna Bharathi Institute of Science and Technology</span>
        <span>Smart Attendance Management System</span>
      </footer>
    </div>
  );
};
