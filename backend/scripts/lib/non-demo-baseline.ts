// The fingerprint the demo reseed checks other users against. It lives in
// src/lib/userFingerprint.ts, because account deletion in the app uses it too;
// this keeps the scripts' and tests' import path.
export * from '../../src/lib/userFingerprint'
