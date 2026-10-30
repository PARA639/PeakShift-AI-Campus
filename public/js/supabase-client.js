/**
 * PeakShift Enterprise - Supabase Security & Prediction Telemetry Bridge
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Replace with your exact project URL from Supabase Settings -> API
const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_T-aFe5lyi7U6xmN0yvCMxg_4PaeZHrY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } }
});

// SHA-256 Signature for Data Integrity
async function generateIntegrityHash(payload) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(payload));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return 'LOCAL_HASH_' + Date.now();
}

/**
 * Stores XGBoost & Isolation Forest prediction outcomes to Supabase
 */
export async function storePredictionOutcome(record) {
  try {
    const hashPayload = {
      actual_kw: record.actual_kw,
      p50_kw: record.p50_kw,
      anomaly_score: record.anomaly_score,
      timestamp: Date.now()
    };
    const signatureHash = await generateIntegrityHash(hashPayload);

    const payload = {
      operator_id: record.operator_id || 'System_Operator',
      actual_kw: record.actual_kw,
      p10_kw: record.p10_kw,
      p50_kw: record.p50_kw,
      p90_kw: record.p90_kw,
      anomaly_score: record.anomaly_score,
      anomaly_status: record.anomaly_status || 'NOMINAL',
      voltage_v: record.voltage || 415.0,
      frequency_hz: record.frequency || 50.0,
      signature_hash: signatureHash
    };

    const { data, error } = await supabase
      .from('prediction_outcomes')
      .insert([payload]);

    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    // Graceful offline fallback to localStorage
    console.warn('Supabase store fallback:', err.message);
    const offlineLedger = JSON.parse(localStorage.getItem('peakshift_prediction_offline') || '[]');
    offlineLedger.push({ ...record, stored_at: new Date().toISOString() });
    if (offlineLedger.length > 50) offlineLedger.shift();
    localStorage.setItem('peakshift_prediction_offline', JSON.stringify(offlineLedger));
    return { success: false, fallback: true };
  }
}

/**
 * Logs human approval decision records
 */
export async function logAuditToDatabase(entry) {
  try {
    const { data, error } = await supabase
      .from('dispatch_audit_ledger')
      .insert([entry]);
    if (error) throw error;
    return { success: true, data };
  } catch (err) {
    return { success: false, fallback: true, error: err.message };
  }
}
