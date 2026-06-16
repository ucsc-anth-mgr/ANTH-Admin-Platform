// ============================================================
// Scheduler.gs — Platform scheduled-job dispatcher
// ============================================================
// The time-based mirror of EventBus. Modules register recurring
// jobs (e.g. a daily digest); a single installed clock trigger per
// frequency runs every registered job for that frequency, isolating
// each job's failures. A module never creates its own trigger — it
// adds a job to the registry and the platform's one trigger runs it.
//
// WHY ONE TRIGGER PER FREQUENCY (not one per job): Apps Script caps
// the number of triggers and they are an operational surface (each
// must be installed once in the editor, runs as a user, fails
// silently if it breaks). Funnelling every daily job through a single
// trigger keeps that surface minimal and mirrors how EventBus funnels
// every listener through one emit path.
//
// WHERE JOBS ARE REGISTERED: getScheduledJobs() in Code.gs — an
// append-only map mirroring getEventListeners(). New modules add their
// jobs there and nowhere else. Scheduler reads that map lazily on run
// (NOT at file-load), so .gs evaluation order does not matter.
//
// FAILURE CONTRACT: a job that throws is caught, logged, and recorded
// as one audit entry — then the runner continues to the next job. A
// broken job can never break the others. (Same principle as EventBus.)
//
// INSTALLING THE TRIGGERS: run installScheduledTriggers() ONCE from the
// editor (like setUp()). It is idempotent — it removes any existing
// Scheduler triggers first, then installs one per frequency, so it is
// safe to re-run after adding a new frequency.
// ============================================================

const Scheduler = (() => {

  // Supported frequencies. Add a new key here AND a branch in
  // installScheduledTriggers() to introduce another cadence.
  const FREQUENCIES = ['daily'];

  // Execution-scoped cache, mirroring EventBus._listenerCache.
  let _jobCache = null;

  /**
   * Returns the job map { frequency: [{ name, fn }, ...] }, built once
   * per execution from getScheduledJobs() in Code.gs. Tolerates a
   * missing or malformed registry by returning {}.
   */
  function _jobs() {
    if (_jobCache) return _jobCache;
    let map = {};
    try {
      if (typeof getScheduledJobs === 'function') {
        const raw = getScheduledJobs() || {};
        Object.keys(raw).forEach(freq => {
          const entries = Array.isArray(raw[freq]) ? raw[freq] : [raw[freq]];
          map[freq] = entries
            .filter(e => e && typeof e.fn === 'function')
            .map(e => ({ name: String(e.name || e.fn.name || 'anonymous'), fn: e.fn }));
        });
      }
    } catch (err) {
      Logger.log('Scheduler: failed to build job map: ' + err);
      map = {};
    }
    _jobCache = map;
    return _jobCache;
  }

  /**
   * Runs every job registered for the given frequency, in order,
   * isolating each one's failures. Returns a summary; never throws on
   * a job error. Called by the installed trigger functions below.
   *
   * @param {string} frequency - e.g. 'daily'
   * @returns {{ frequency: string, jobsRun: number, jobsFailed: number }}
   */
  function run(frequency) {
    const freq = String(frequency || '').trim();
    if (!freq) {
      Logger.log('Scheduler.run called with empty frequency; ignoring.');
      return { frequency: '', jobsRun: 0, jobsFailed: 0 };
    }

    const jobs = _jobs()[freq] || [];
    const ctx = { frequency: freq, runAt: new Date() };
    let run = 0, failed = 0;

    jobs.forEach(job => {
      try {
        job.fn(ctx);
        run++;
      } catch (err) {
        failed++;
        Logger.log('Scheduler job "' + job.name + '" failed on "' + freq + '": ' + err);
        AuditLog.write({
          user:   'scheduler',
          module: 'scheduler',
          action: freq,
          status: 'error',
          notes:  'job "' + job.name + '" threw: ' + (err && err.message ? err.message : err),
        });
      }
    });

    // One success audit line per run, so runs are visible in the trail.
    AuditLog.write({
      user: 'scheduler', module: 'scheduler', action: freq, status: 'success',
      notes: 'ran ' + run + ' job(s), ' + failed + ' failed',
    });

    return { frequency: freq, jobsRun: run, jobsFailed: failed };
  }

  /** Frequencies that currently have at least one registered job. */
  function registeredFrequencies() {
    const map = _jobs();
    return Object.keys(map).filter(k => map[k] && map[k].length);
  }

  /** Clears the execution-scoped job cache (test/diagnostic use). */
  function clearCache() { _jobCache = null; }

  return {
    FREQUENCIES: FREQUENCIES,
    run: run,
    registeredFrequencies: registeredFrequencies,
    clearCache: clearCache,
  };

})();


// ============================================================
// Trigger entry points + installer (top-level: triggers can only
// call top-level functions, and the installer is run from the editor)
// ============================================================

/**
 * The trigger handler for daily jobs. Installed by
 * installScheduledTriggers(); do not call directly except to test.
 */
function runDailyJobs() {
  return Scheduler.run('daily');
}

/**
 * Installs one time-based trigger per supported frequency. Run ONCE
 * from the editor (like setUp). Idempotent: removes existing Scheduler
 * triggers first, so re-running after adding a frequency is safe.
 *
 * Daily runs are scheduled for the early-morning hour below (script
 * timezone). Change DAILY_HOUR to retarget.
 */
function installScheduledTriggers() {
  const DAILY_HOUR = 6; // 6 AM, script timezone

  // Map frequency -> its trigger handler function name.
  const handlers = { daily: 'runDailyJobs' };

  // Remove any existing triggers that point at our handlers, so this is
  // idempotent and never stacks duplicates.
  const handlerNames = Object.keys(handlers).map(f => handlers[f]);
  ScriptApp.getProjectTriggers().forEach(t => {
    if (handlerNames.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Install fresh.
  ScriptApp.newTrigger('runDailyJobs').timeBased().everyDays(1).atHour(DAILY_HOUR).create();

  Logger.log('Scheduler: installed daily trigger (runDailyJobs) at ~' + DAILY_HOUR + ':00 '
             + Session.getScriptTimeZone() + '.');
  Logger.log('Registered daily jobs: ' + (Scheduler.registeredFrequencies().indexOf('daily') !== -1
             ? JSON.stringify(getScheduledJobs().daily.map(j => j.name)) : '(none yet)'));
}

/**
 * Diagnostic: run the daily jobs right now from the editor and log the
 * summary, without waiting for the trigger. Safe — same path the
 * trigger uses.
 */
function testRunDailyJobs() {
  Logger.log(JSON.stringify(runDailyJobs()));
}