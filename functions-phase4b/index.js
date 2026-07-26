'use strict';

const { setGlobalOptions } = require('firebase-functions/v2');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  DEFAULT_TIME_ZONE,
  dayKeyInTimeZone,
  evaluateWatchdog,
} = require('./watchdog-policy');

initializeApp();
setGlobalOptions({
  region: 'europe-west1',
  maxInstances: 1,
  timeoutSeconds: 60,
  memory: '256MiB',
});

const db = getFirestore();
const MAX_DUE_PER_RUN = 100;

function clean(value) {
  return String(value ?? '').trim();
}

async function enforceOneDueActivity(activityRef, nowMs) {
  return db.runTransaction(async (tx) => {
    const activitySnap = await tx.get(activityRef);
    if (!activitySnap.exists) return { changed: false, reason: 'activity_deleted' };

    const activity = activitySnap.data() || {};
    const userId = clean(activity.userId || activityRef.id);
    if (!userId) {
      tx.set(activityRef, {
        watchdogDueMs: null,
        watchdogLastAction: 'invalid_user',
        watchdogHandledAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { changed: false, reason: 'invalid_user' };
    }

    const dayKey = dayKeyInTimeZone(activity.timeZone || DEFAULT_TIME_ZONE, nowMs);
    const dayRef = db.collection('agentDays').doc(`${dayKey}_${userId}`);
    const daySnap = await tx.get(dayRef);
    const dayRow = daySnap.exists ? (daySnap.data() || {}) : null;
    const verdict = evaluateWatchdog({ activity, dayRow, nowMs });

    if (!verdict.due) return { changed: false, reason: verdict.reason };

    if (verdict.shouldUnavailable && daySnap.exists) {
      tx.set(dayRef, {
        status: 'unavailable',
        lastStatusChange: nowMs,
        inactivityAutoUnavailableAt: Timestamp.fromMillis(nowMs),
        inactivitySource: 'server_watchdog',
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    if (verdict.clearDue) {
      tx.set(activityRef, {
        watchdogDueMs: null,
        watchdogHandledActivityMs: Number(activity.lastActivityMs || 0),
        watchdogHandledAt: FieldValue.serverTimestamp(),
        watchdogLastAction: verdict.shouldUnavailable ? 'unavailable' : verdict.reason,
      }, { merge: true });
    }

    return {
      changed: Boolean(verdict.shouldUnavailable),
      reason: verdict.reason,
      userId,
      dayKey,
    };
  });
}

exports.enforceInactivity = onSchedule({
  schedule: '* * * * *',
  timeZone: 'Etc/UTC',
}, async () => {
  const nowMs = Date.now();
  const dueSnapshot = await db.collection('userActivity')
    .where('watchdogDueMs', '<=', nowMs)
    .orderBy('watchdogDueMs', 'asc')
    .limit(MAX_DUE_PER_RUN)
    .get();

  if (dueSnapshot.empty) {
    logger.debug('Inactivity watchdog: no due activity rows.');
    return;
  }

  let changed = 0;
  let skipped = 0;
  const reasons = {};

  for (const activityDoc of dueSnapshot.docs) {
    try {
      const result = await enforceOneDueActivity(activityDoc.ref, nowMs);
      if (result.changed) changed += 1;
      else skipped += 1;
      reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    } catch (error) {
      skipped += 1;
      reasons.error = (reasons.error || 0) + 1;
      logger.error('Inactivity watchdog row failed', {
        userId: activityDoc.id,
        message: String(error?.message || error),
      });
    }
  }

  logger.info('Inactivity watchdog completed', {
    due: dueSnapshot.size,
    changed,
    skipped,
    reasons,
  });
});
