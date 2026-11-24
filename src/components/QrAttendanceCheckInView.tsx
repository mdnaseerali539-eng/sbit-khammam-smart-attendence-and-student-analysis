import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarOff,
  Camera,
  CheckCircle2,
  Clock,
  QrCode,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch, ApiError, setAuthToken } from '../lib/api';
import { analyzeVideoFrame, ensureFaceModelsLoaded, FrameAnalysisResult } from '../lib/faceEngine';
import { CollegeSettings } from '../types';

interface QrAttendanceCheckInViewProps {
  initialToken: string;
  collegeSettings: CollegeSettings | null;
  onAuthenticated: (bannerMsg?: string) => void;
  onBackToLogin: () => void;
}

interface LookupSlotInfo {
  slot: 'morning' | 'afternoon';
  startTime12h: string;
  endTime12h: string;
  status: 'scheduled' | 'active' | 'closed' | 'cancelled';
  alreadyMarked: boolean;
  message: string;
}

interface LookupResponse {
  student: {
    fullName: string;
    rollNumber: string;
    departmentCode: string | null;
    className: string | null;
    hasBiometrics: boolean;
  };
  todaySchedule?: {
    dayEval: {
      dateIST: string;
      dayStatus: string;
      isWorkingDay: boolean;
      isHoliday: boolean;
      holidayTitle: string | null;
      holidayReason: string | null;
      overrideTitle: string | null;
      overrideReason: string | null;
    };
    morning: LookupSlotInfo;
    afternoon: LookupSlotInfo;
  };
  activeSessions: Array<{
    id: string;
    sessionCode: string;
    subjectCode: string;
    subjectName: string;
    sessionDate: string;
    startTime: string;
    endTime: string;
    periodSlot: string;
    alreadyMarked: boolean;
  }>;
  collegeSettings: {
    locationVerificationEnabled: boolean;
    livenessRequired: boolean;
  };
}

export const QrAttendanceCheckInView: React.FC<QrAttendanceCheckInViewProps> = ({
  initialToken,
  collegeSettings,
  onAuthenticated,
  onBackToLogin,
}) => {
  const [qrToken, setQrToken] = useState(initialToken || 'SBIST-ATTEND-CAMPUS');
  const [qrInfo, setQrInfo] = useState<{
    label: string;
    departmentId: string | null;
    sessionId: string | null;
  } | null>(null);
  const [boundSession, setBoundSession] = useState<{
    id: string;
    sessionCode: string;
    subjectCode: string;
    subjectName: string;
    className: string;
    sessionDate: string;
    startTime: string;
    endTime: string;
    status: string;
  } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [checkingQr, setCheckingQr] = useState(false);

  const [rollNumber, setRollNumber] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupData, setLookupData] = useState<LookupResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');

  // Camera & liveness states
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const earHistoryRef = useRef<number[]>([]);

  const [modelsReady, setModelsReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<FrameAnalysisResult | null>(null);
  const [blinkDetected, setBlinkDetected] = useState(false);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState('Checking campus location...');
  const [locationError, setLocationError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    if (!qrToken.trim()) return;
    let cancelled = false;
    setCheckingQr(true);
    setQrError(null);
    apiFetch<{
      qr: { label: string; departmentId: string | null; sessionId: string | null };
      boundSession: typeof boundSession;
    }>(`/api/qr/attendance/${encodeURIComponent(qrToken.trim())}`, { skipAuth: true })
      .then((res) => {
        if (cancelled) return;
        setQrInfo(res.qr);
        setBoundSession(res.boundSession);
      })
      .catch((err) => {
        if (cancelled) return;
        setQrInfo(null);
        setBoundSession(null);
        setQrError(err instanceof Error ? err.message : 'Invalid attendance QR code.');
      })
      .finally(() => {
        if (!cancelled) setCheckingQr(false);
      });
    return () => {
      cancelled = true;
    };
  }, [qrToken]);

  const cameraActive = Boolean(lookupData?.student.hasBiometrics);
  const locationRequired =
    Boolean(selectedSessionId) &&
    (lookupData?.collegeSettings.locationVerificationEnabled ??
      collegeSettings?.locationVerificationEnabled ??
      true);
  const livenessRequired =
    lookupData?.collegeSettings.livenessRequired ?? collegeSettings?.livenessRequired ?? true;

  // Request geolocation when a session is active and location verification is enabled
  useEffect(() => {
    if (!cameraActive || !locationRequired) {
      setLocationError(null);
      setLocationStatus(
        selectedSessionId ? 'Campus location check optional' : 'No active session selected'
      );
      return;
    }
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser.');
      return;
    }
    setLocationStatus('Requesting campus location...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        setLocationStatus(
          `GPS captured (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`
        );
        setLocationError(null);
      },
      (err) => {
        setLocationError(`Location permission unavailable (${err.message}).`);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }, [cameraActive, locationRequired, selectedSessionId]);

  // Start camera & face models when biometrics are confirmed enrolled
  useEffect(() => {
    if (!cameraActive) return;
    let cancelled = false;

    async function initCamera() {
      try {
        await ensureFaceModelsLoaded();
        if (cancelled) return;
        setModelsReady(true);

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setCameraReady(true);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unable to start camera';
        setCameraError(`Camera initialization failed: ${msg}. Please allow camera permission.`);
      }
    }

    initCamera();

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setCameraReady(false);
    };
  }, [cameraActive]);

  // Continuous live frame analysis loop
  useEffect(() => {
    if (!cameraActive || !cameraReady || !modelsReady || verifying) return;
    let busy = false;

    const id = window.setInterval(async () => {
      if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
      busy = true;
      try {
        const res = await analyzeVideoFrame(videoRef.current, false);
        setAnalysis(res);

        if (res.faceCount === 1 && res.ear !== null) {
          earHistoryRef.current.push(res.ear);
          if (earHistoryRef.current.length > 25) earHistoryRef.current.shift();
          const maxEar = Math.max(...earHistoryRef.current);
          const minEar = Math.min(...earHistoryRef.current);
          if (maxEar - minEar >= 0.045 || minEar < 0.23) {
            setBlinkDetected(true);
          }
        }
      } catch {
        // Ignore transient frame read issues
      } finally {
        busy = false;
      }
    }, 260);

    timerRef.current = id;
    return () => window.clearInterval(id);
  }, [cameraActive, cameraReady, modelsReady, verifying]);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    setLookupError(null);
    setVerifyError(null);
    setBlinkDetected(false);
    earHistoryRef.current = [];
    setLookingUp(true);
    try {
      const res = await apiFetch<LookupResponse>('/api/qr/attendance/lookup', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({
          qrToken: qrToken.trim(),
          rollNumber: rollNumber.trim(),
        }),
      });
      setLookupData(res);
      const firstUnmarked = res.activeSessions.find((s) => !s.alreadyMarked) || res.activeSessions[0];
      setSelectedSessionId(firstUnmarked?.id || '');
    } catch (err) {
      setLookupData(null);
      setLookupError(err instanceof Error ? err.message : 'Unable to find hall ticket number.');
    } finally {
      setLookingUp(false);
    }
  }

  async function handleVerifyFaceAndOpenDashboard() {
    if (!videoRef.current || !lookupData || verifying) return;
    setVerifyError(null);

    if (locationRequired && !coords) {
      setVerifyError('Campus GPS coordinates are required before verifying attendance.');
      return;
    }

    if (livenessRequired && !blinkDetected) {
      setVerifyError('Please blink naturally once so the liveness check detects eye motion.');
      return;
    }

    setVerifying(true);
    try {
      const frame1 = await analyzeVideoFrame(videoRef.current, true);
      if (frame1.faceCount !== 1 || !frame1.descriptor) {
        setVerifyError(frame1.guidanceMessage);
        return;
      }
      if (!frame1.lightingOk || !frame1.centeringOk || !frame1.sizeOk) {
        setVerifyError(frame1.guidanceMessage);
        return;
      }

      await new Promise((r) => setTimeout(r, 350));
      const frame2 = await analyzeVideoFrame(videoRef.current, true);
      if (frame2.faceCount !== 1 || !frame2.descriptor) {
        setVerifyError(frame2.guidanceMessage);
        return;
      }

      let sqDiff = 0;
      for (let i = 0; i < 128; i++) {
        const d = frame1.descriptor[i] - frame2.descriptor[i];
        sqDiff += d * d;
      }
      const frameVariance = Math.sqrt(sqDiff);

      const res = await apiFetch<{
        token: string;
        marked: boolean;
        alreadyMarked: boolean;
        message: string;
      }>('/api/qr/attendance/verify-and-mark', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({
          qrToken: qrToken.trim(),
          rollNumber: lookupData.student.rollNumber,
          sessionId: selectedSessionId || null,
          descriptor: frame2.descriptor,
          livenessPassed: livenessRequired ? blinkDetected && frameVariance > 0.0001 : true,
          livenessSignals: {
            blinkDetected,
            headTurnDetected: true,
            frameVariance,
          },
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        }),
      });

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setAuthToken(res.token);
      window.history.replaceState({}, '', '/');
      onAuthenticated(res.message);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setVerifyError(err.message);
      } else {
        setVerifyError(err instanceof Error ? err.message : 'Face authentication failed.');
      }
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-8 px-4">
      <div className="mx-auto w-full max-w-2xl bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm space-y-5">
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-200">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src={collegeSettings?.logoUrl || '/src/assets/images/sbist_college_crest_1795533458624.jpg'}
              alt="Swarna Bharathi Institute of Science and Technology Logo"
              referrerPolicy="no-referrer"
              className="h-12 w-12 rounded-lg object-contain border border-slate-200 bg-white p-1 shrink-0"
            />
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight truncate">
                {collegeSettings?.collegeName || 'Swarna Bharathi Institute of Science and Technology'}
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Smart Attendance Management System · QR Hall-Ticket Face Check-In
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onBackToLogin}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Portal Login
          </button>
        </div>

        {/* QR Token Banner */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-800 flex items-center gap-1.5">
              <QrCode className="h-4 w-4 text-blue-700" />
              Attendance Check-In QR Token
            </span>
            <input
              type="text"
              value={qrToken}
              onChange={(e) => {
                setQrToken(e.target.value);
                setLookupData(null);
              }}
              placeholder="SBIST-ATTEND-CAMPUS"
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-mono-tabular w-56"
            />
          </div>
          {checkingQr && <p className="text-xs text-slate-500">Validating attendance QR code...</p>}
          {qrInfo && (
            <p className="text-xs text-emerald-700 font-medium">
              Verified Check-In QR: {qrInfo.label}
              {boundSession
                ? ` · ${boundSession.subjectCode || 'DAILY'} (${boundSession.className}, ${boundSession.startTime}–${boundSession.endTime})`
                : ''}
            </p>
          )}
          {qrError && <p className="text-xs text-red-600 font-medium">{qrError}</p>}
        </div>

        {/* Step 1: Enter Hall Ticket Number */}
        <form onSubmit={handleLookup} className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">
            Step 1: Enter Your Hall Ticket / Roll Number
          </label>
          <div className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              required
              value={rollNumber}
              onChange={(e) => setRollNumber(e.target.value)}
              placeholder="e.g. 24SB1A0501"
              disabled={!qrInfo || lookingUp}
              className="flex-1 rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm font-mono-tabular uppercase focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={!qrInfo || lookingUp || !rollNumber.trim()}
              className="px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              {lookingUp ? 'Checking...' : 'Continue to Face Check-In'}
            </button>
          </div>
          {lookupError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
              {lookupError}
            </div>
          )}
        </form>

        {/* Step 2: Biometric Check / Camera Authentication */}
        {lookupData && (
          <div className="border-t border-slate-200 pt-5 space-y-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div>
                <div className="font-bold text-slate-900 text-sm">{lookupData.student.fullName}</div>
                <div className="text-slate-600 font-mono-tabular">
                  {lookupData.student.rollNumber} · {lookupData.student.departmentCode} ·{' '}
                  {lookupData.student.className}
                </div>
              </div>
              <span
                className={`inline-flex items-center gap-1 font-semibold ${
                  lookupData.student.hasBiometrics ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                {lookupData.student.hasBiometrics ? 'Face Template Ready' : 'Face Not Enrolled Yet'}
              </span>
            </div>

            {lookupData.todaySchedule?.dayEval.isHoliday && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-2.5 text-xs text-amber-950">
                <CalendarOff className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">
                    Today is a holiday: {lookupData.todaySchedule.dayEval.holidayTitle}. Attendance sessions are unavailable.
                  </div>
                  {lookupData.todaySchedule.dayEval.holidayReason && (
                    <div className="text-amber-900 mt-0.5">
                      Reason: {lookupData.todaySchedule.dayEval.holidayReason}
                    </div>
                  )}
                </div>
              </div>
            )}

            {lookupData.todaySchedule && !lookupData.todaySchedule.dayEval.isHoliday && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                {[lookupData.todaySchedule.morning, lookupData.todaySchedule.afternoon].map((slot) => (
                  <div
                    key={slot.slot}
                    className={`rounded-lg border px-3 py-2.5 space-y-1 ${
                      slot.status === 'active'
                        ? 'border-blue-200 bg-blue-50/50'
                        : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold text-slate-900">
                      <span>{slot.slot === 'morning' ? 'Morning Session' : 'Afternoon Session'}</span>
                      <span className="font-mono-tabular text-[11px] text-slate-500 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {slot.startTime12h}–{slot.endTime12h}
                      </span>
                    </div>
                    <div className="text-slate-700">{slot.message}</div>
                  </div>
                ))}
              </div>
            )}

            {!lookupData.student.hasBiometrics ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 space-y-3">
                <p className="font-semibold">One-Time Face Enrollment Required</p>
                <p className="leading-relaxed">
                  Your account is approved, but you haven&apos;t enrolled your live face template yet. Sign
                  in once to your Student Portal to complete the 3-sample Face Enrollment. After that, you
                  can mark attendance and open your dashboard here using only your Hall Ticket Number and
                  Face Verification.
                </p>
                <button
                  type="button"
                  onClick={onBackToLogin}
                  className="px-4 py-2 font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Sign In to Complete One-Time Face Enrollment
                </button>
              </div>
            ) : (
              <>
                {lookupData.activeSessions.length > 0 ? (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-slate-700">
                      Active Class Session
                    </label>
                    <select
                      value={selectedSessionId}
                      onChange={(e) => setSelectedSessionId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white"
                    >
                      {lookupData.activeSessions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.subjectCode || 'DAILY'} · {s.subjectName || 'Daily Session'} ({s.startTime}–{s.endTime} IST)
                          {s.alreadyMarked ? ' — Already Marked' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                    No active attendance session is available for your class. Authenticating your face will
                    still verify your identity and open your Student Dashboard.
                  </div>
                )}

                {selectedSessionId && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-700">
                      Location Check: {locationError ? 'Unavailable' : locationStatus}
                    </span>
                    {locationError && <span className="text-amber-700">{locationError}</span>}
                  </div>
                )}

                <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-slate-900 border border-slate-200">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    className="h-full w-full object-cover scale-x-[-1]"
                  />
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div
                      className={`h-48 w-36 sm:h-56 sm:w-44 rounded-full border-2 transition-colors ${
                        analysis?.faceCount === 1 &&
                        analysis.lightingOk &&
                        analysis.centeringOk &&
                        analysis.sizeOk
                          ? 'border-emerald-400'
                          : 'border-white/70 border-dashed'
                      }`}
                    />
                  </div>
                  {(!modelsReady || !cameraReady) && !cameraError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 text-white text-xs gap-2">
                      <RefreshCw className="h-5 w-5 animate-spin" />
                      <span>
                        {modelsReady
                          ? 'Starting camera stream...'
                          : 'Loading local face recognition models...'}
                      </span>
                    </div>
                  )}
                  {cameraError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 p-4 text-center text-xs text-red-300">
                      {cameraError}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <div className="rounded-lg border border-slate-200 p-2.5">
                    <div className="text-slate-500">1. Face Detection</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {analysis
                        ? analysis.faceCount === 1
                          ? '1 Face Detected'
                          : analysis.faceCount === 0
                            ? 'No Face Visible'
                            : `${analysis.faceCount} Faces (Rejected)`
                        : 'Analyzing...'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2.5">
                    <div className="text-slate-500">2. Lighting & Frame</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {analysis?.lightingOk && analysis.centeringOk && analysis.sizeOk
                        ? 'Optimal Lighting & Frame'
                        : analysis?.guidanceMessage || 'Center face in oval'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-2.5">
                    <div className="text-slate-500">3. Liveness Check</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {livenessRequired
                        ? blinkDetected
                          ? 'Blink Verified'
                          : 'Please Blink Naturally'
                        : 'Optional'}
                    </div>
                  </div>
                </div>

                {verifyError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{verifyError}</span>
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={!cameraReady || !modelsReady || verifying}
                    onClick={handleVerifyFaceAndOpenDashboard}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 disabled:opacity-50"
                  >
                    {verifying ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Authenticating & Opening Dashboard...
                      </>
                    ) : selectedSessionId ? (
                      <>
                        <Camera className="h-4 w-4" />
                        Authenticate Face, Mark Attendance & Open Dashboard
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        Authenticate Face & Open Student Dashboard
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
