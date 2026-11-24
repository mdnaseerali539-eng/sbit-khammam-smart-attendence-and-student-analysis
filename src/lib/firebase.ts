import { initializeApp, getApp, getApps, type FirebaseOptions } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
} from 'firebase/auth';
import firebaseAppletConfig from '../../firebase-applet-config.json';

export const firebaseConfig: FirebaseOptions = {
  apiKey: firebaseAppletConfig.apiKey,
  authDomain: firebaseAppletConfig.authDomain,
  projectId: firebaseAppletConfig.projectId,
  storageBucket: firebaseAppletConfig.storageBucket,
  messagingSenderId: firebaseAppletConfig.messagingSenderId,
  appId: firebaseAppletConfig.appId,
  ...(firebaseAppletConfig.measurementId
    ? { measurementId: firebaseAppletConfig.measurementId }
    : {}),
};

const requiredKeys: Array<keyof FirebaseOptions> = [
  'apiKey',
  'authDomain',
  'projectId',
  'appId',
];

for (const key of requiredKeys) {
  if (!firebaseConfig[key]) {
    throw new Error(`Missing required Firebase configuration field "${key}" in firebase-applet-config.json.`);
  }
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

if (typeof window !== 'undefined') {
  auth.useDeviceLanguage();
}

export function createGoogleAuthProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');
  provider.setCustomParameters({
    prompt: 'select_account',
  });
  return provider;
}

export const googleAuthProvider = createGoogleAuthProvider();
export { browserPopupRedirectResolver };
