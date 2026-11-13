// Demo launch-context identifiers for the athenaOne embedded prototype.
//
// The hardcoded mock patient profile that used to live here has been removed:
// the patient profile API (`GET /api/patient/:patientId`) now returns the
// launched patient's real demographics / contact / insurance from athenahealth
// (see athena-embed/server.js + lib/athena-claims.js). No mock patient data is
// served anywhere in this prototype.
//
// These two opaque identifiers are NOT patient data. They are the demo
// launch-context values the athenaMessaging bridge simulates when the app is
// opened directly in a browser (outside an athenaOne SMART launch), and they are
// echoed by GET /api/config. Outside a real session the profile API responds
// honestly with 401/409 rather than mock data.
export const DEMO_PATIENT_ID = 'P-100242';
export const DEMO_ENCOUNTER_ID = 'E-558843';
