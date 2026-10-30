import { smartMeterDataset } from './dataset.js';
import { demandForecaster, anomalyDetector } from './ai-engine.js';
import { simulator } from './simulator.js';
import { logAuditToDatabase, storePredictionOutcome } from './supabase-client.js';

class EnterpriseEngine {
  constructor() {
    this.currentView = 'dashboard';
    this.selectedDate = '2026-06-24';
    this.simParams = { pumpPct: 80, evPct: 50, thermalPct: 25 };
    
    // Auth Session
    this.authTokenKey = 'peakshift_auth_session_token';
    this.operator = {
      name: 'Operations Dispatcher',
      role: 'Facilities / Electrical Engineer',
      age: 29,
      designation: 'Power Systems Specialist',
      photo: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300'
    };

    // Live continuous streaming state
    this.streamTimer = null;
    this.streamSec = 0;
    this.streamHistory = [];
    this.maxStreamPoints = 50;
    this.isStreamRunning = true;
    this.supabaseSyncCount = 0;

    this.bindAuthEvents();
    this.checkInitialAuth();
  }

  bindAuthEvents() {
    const authForm = document.getElementById('auth-form');
    if (authForm) {
      authForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('login-username').value.trim();
        const pass = document.getElementById('login-password').value.trim();
        const errBox = document.getElementById('auth-error-msg');

        if ((user === 'admin' && pass === 'peakshift2026') || (user === 'operator' && pass === 'operator123')) {
          sessionStorage.setItem(this.authTokenKey, JSON.stringify({ user, loggedInAt: new Date().toISOString() }));
          errBox.classList.add('hidden');
          this.unlockWorkspace();
        } else {
          errBox.textContent = 'Invalid credentials. Access Denied.';
          errBox.classList.remove('hidden');
        }
      });
    }

    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.onclick = () => this.lockWorkspace();
  }

  checkInitialAuth() {
    if (sessionStorage.getItem(this.authTokenKey)) {
      this.unlockWorkspace();
    } else {
      this.lockWorkspace();
    }
  }

  unlockWorkspace() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-workspace-container').classList.remove('hidden');
    this.initApp();
  }

  lockWorkspace() {
    if (this.streamTimer) clearInterval(this.streamTimer);
    sessionStorage.removeItem(this.authTokenKey);
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-workspace-container').classList.add('hidden');
  }

  async initApp() {
    await smartMeterDataset.load();
    this.recalculateShiftProfiles();
    this.renderHeader();
    this.renderView();
  }

  // Recalculates Net Power Grid and Optimal Grid Demand by minimizing solar power
  recalculateShiftProfiles() {
    this.day = smartMeterDataset.getDayProfile(this.selectedDate);
    const rawSim = simulator.simulate(this.day, this.simParams);

    // Minimize solar from raw demand to derive actual Net Grid requirements
    this.adjustedIntervals = rawSim.shiftedIntervals.map(pt => {
      const solarKw = Number(pt.simulated_solar_kw || 0);
      const rawCampus = Number(pt.campus_demand_kw || 0);
      const rawShifted = Number(pt.shifted_demand_kw || 0);

      // Net Grid = Campus Load minus Solar generation (floor at zero)
      const netGridBaseline = Number(Math.max(0, rawCampus - solarKw).toFixed(2));
      const optimalGridShifted = Number(Math.max(0, rawShifted - solarKw).toFixed(2));
      const deltaShiftKw = Number((netGridBaseline - optimalGridShifted).toFixed(2));

      return {
        ...pt,
        solar_minimized_kw: solarKw,
        net_grid_baseline_kw: netGridBaseline,
        optimal_grid_shifted_kw: optimalGridShifted,
        curtailed_kw: deltaShiftKw
      };
    });

    const netBaselineMax = Math.max(...this.adjustedIntervals.map(i => i.net_grid_baseline_kw));
    const netShiftedMax = Math.max(...this.adjustedIntervals.map(i => i.optimal_grid_shifted_kw));
    const netReduction = Number((netBaselineMax - netShiftedMax).toFixed(1));
    const pctReduction = netBaselineMax > 0 ? Number(((netReduction / netBaselineMax) * 100).toFixed(1)) : 0;
    const totalSolar = this.adjustedIntervals.reduce((acc, curr) => acc + curr.solar_minimized_kw, 0);

    this.netMetrics = {
      net_baseline_peak: netBaselineMax,
      optimal_shifted_peak: netShiftedMax,
      peak_reduction_kw: netReduction,
      reduction_percentage: pctReduction,
      total_solar_kwh: Math.round(totalSolar),
      total_shifted_kwh: rawSim.metrics.total_shifted_kwh
    };
  }

  renderHeader() {
    const dateSel = document.getElementById('global-date-select');
    if (dateSel && dateSel.options.length === 0) {
      dateSel.innerHTML = smartMeterDataset.availableDates.map(d => 
        `<option value="${d}" ${d === this.selectedDate ? 'selected' : ''}>${d}</option>`
      ).join('');
      dateSel.onchange = (e) => {
        this.selectedDate = e.target.value;
        this.recalculateShiftProfiles();
        this.renderView();
      };
    }
  }

  renderView() {
    const main = document.getElementById('main-workspace');
    if (!main) return;

    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }

    if (this.currentView === 'dashboard') {
      this.renderDashboard(main);
    } else if (this.currentView === 'ml') {
      this.renderModelEvolution(main);
    } else if (this.currentView === 'analysis') {
      this.renderAnalysis(main);
    } else if (this.currentView === 'approvals') {
      this.renderApprovals(main);
    } else if (this.currentView === 'profile') {
      this.renderProfile(main);
    }
  }

  // =========================================================================
  // DASHBOARD VIEW (Recalculated Net Grid & Bottom CSV Download)
  // =========================================================================
  renderDashboard(container) {
    const m = this.netMetrics;
    const intervals = this.adjustedIntervals;
    const possibleReductionKw = Number((m.net_baseline_peak * 0.22).toFixed(1));

    container.innerHTML = `
      <div class="space-y-6">
        <!-- 1. Top Recalculated KPI Cards -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 font-mono">
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-red-500">
            <div class="text-xs text-slate-400">NET GRID PEAK (RAW)</div>
            <div class="text-2xl font-bold text-white mt-1">${m.net_baseline_peak} kW</div>
            <div class="text-[11px] text-red-400 mt-1">Spike minus Solar Feed</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-emerald-500">
            <div class="text-xs text-slate-400">OPTIMAL POWER GRID</div>
            <div class="text-2xl font-bold text-emerald-400 mt-1">${m.optimal_shifted_peak} kW</div>
            <div class="text-[11px] text-emerald-400 mt-1">-${m.peak_reduction_kw} kW (-${m.reduction_percentage}%)</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-yellow-500">
            <div class="text-xs text-slate-400">MINIMIZED SOLAR OFFSET</div>
            <div class="text-2xl font-bold text-yellow-400 mt-1">${m.total_solar_kwh} kWh</div>
            <div class="text-[11px] text-yellow-300 mt-1">Self-Consumed On-Site</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-cyan-500">
            <div class="text-xs text-slate-400">POSSIBLE REDUCTION</div>
            <div class="text-2xl font-bold text-cyan-400 mt-1">${possibleReductionKw} kW</div>
            <div class="text-[11px] text-slate-400 mt-1">Flex Capacity Remaining</div>
          </div>
        </div>

        <!-- 2. Interactive SVG Curve (Net Demand vs Optimal Shift) -->
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <div class="flex justify-between items-center mb-4">
            <div>
              <h3 class="text-sm font-semibold text-white font-mono">Recalculated Net Grid vs Optimal Demand (Solar Subtracted)</h3>
              <p class="text-xs text-slate-400">Curves represent direct grid import after on-site solar generation minimization.</p>
            </div>
            <div class="flex gap-4 text-xs font-mono">
              <span class="text-red-400">● Net Grid Baseline</span>
              <span class="text-emerald-400">● Optimal Shifted</span>
              <span class="text-yellow-400">● Solar Minimized</span>
            </div>
          </div>
          <div class="relative">
            <div id="chart-tooltip" class="absolute hidden bg-slate-950 border border-slate-700 text-xs font-mono p-2 rounded shadow-xl pointer-events-none z-20"></div>
            <svg id="demand-svg" viewBox="0 0 900 280" class="w-full h-64 overflow-visible cursor-crosshair font-mono"></svg>
          </div>
        </div>

        <!-- 3. APPROVALS IN ALERT BANNER FORMAT -->
        <div class="bg-slate-900 border-2 border-amber-500/40 rounded-xl p-5 shadow-2xl relative overflow-hidden space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
            <div class="flex items-center gap-3">
              <span class="relative flex h-3.5 w-3.5">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-3.5 w-3.5 bg-amber-500"></span>
              </span>
              <div>
                <h3 class="text-sm font-bold text-amber-400 font-mono tracking-wide uppercase flex items-center gap-2">
                  <span>⚠</span> DISPATCH APPROVAL ALERTS (2 PENDING AUTHORIZATIONS)
                </h3>
                <p class="text-xs text-slate-400 mt-0.5">High-priority grid load relief proposals awaiting immediate human sign-off.</p>
              </div>
            </div>
            <span class="text-[11px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30 px-3 py-1 rounded font-bold uppercase tracking-wider">
              Action Required
            </span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
            <!-- Alert 01 -->
            <div class="bg-[#121622] border border-amber-500/30 rounded-xl p-4 flex flex-col justify-between hover:border-amber-500/60 transition shadow-inner">
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-[10px] font-bold text-amber-400 bg-amber-950/60 border border-amber-700/50 px-2 py-0.5 rounded uppercase">
                    ALERT #01 • IMMEDIATE
                  </span>
                  <span class="text-[10px] text-cyan-400 font-mono bg-cyan-950/50 px-2 py-0.5 rounded border border-cyan-800/40">
                    Water Pumping Feeder
                  </span>
                </div>
                <h4 class="text-white font-bold text-sm tracking-tight">Deferred Pump Shedding (17:00–20:00)</h4>
                <p class="text-slate-400 text-[11px] leading-relaxed font-sans">
                  Peak demand threshold breach imminent. Shift active water lift pumps to daytime solar generation window (11:00–14:00).
                </p>
                <div class="p-2.5 bg-slate-950/80 rounded border border-slate-800/80 text-[11px] space-y-1">
                  <div class="flex justify-between text-slate-300">
                    <span>Relief Capacity:</span>
                    <strong class="text-emerald-400">~35 kW Reduction</strong>
                  </div>
                  <div class="flex justify-between text-slate-300">
                    <span>Safety Margin:</span>
                    <strong class="text-cyan-400">18h Storage Tank Buffer</strong>
                  </div>
                </div>
              </div>
              <div class="flex gap-2 mt-4 pt-3 border-t border-slate-800">
                <button class="dash-approve-btn flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-2.5 rounded-lg font-bold tracking-wider transition shadow-lg shadow-emerald-900/30 uppercase" data-task="PUMP_SHIFT">
                  Accept
                </button>
                <button class="dash-reject-btn flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2.5 rounded-lg font-bold tracking-wider transition uppercase">
                  Decline
                </button>
              </div>
            </div>

            <!-- Alert 02 -->
            <div class="bg-[#121622] border border-amber-500/30 rounded-xl p-4 flex flex-col justify-between hover:border-amber-500/60 transition shadow-inner">
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-[10px] font-bold text-amber-400 bg-amber-950/60 border border-amber-700/50 px-2 py-0.5 rounded uppercase">
                    ALERT #02 • WARNING
                  </span>
                  <span class="text-[10px] text-yellow-400 font-mono bg-yellow-950/50 px-2 py-0.5 rounded border border-yellow-800/40">
                    EV Fast Charging Plaza
                  </span>
                </div>
                <h4 class="text-white font-bold text-sm tracking-tight">EV Hub Dynamic Load Throttling</h4>
                <p class="text-slate-400 text-[11px] leading-relaxed font-sans">
                  Throttle non-emergency fast-charging bays by 50% during the peak tariff window; defer remaining balance overnight.
                </p>
                <div class="p-2.5 bg-slate-950/80 rounded border border-slate-800/80 text-[11px] space-y-1">
                  <div class="flex justify-between text-slate-300">
                    <span>Relief Capacity:</span>
                    <strong class="text-emerald-400">~45 kW Reduction</strong>
                  </div>
                  <div class="flex justify-between text-slate-300">
                    <span>Rebound Lock:</span>
                    <strong class="text-emerald-400">Enforced (No Post-Spike)</strong>
                  </div>
                </div>
              </div>
              <div class="flex gap-2 mt-4 pt-3 border-t border-slate-800">
                <button class="dash-approve-btn flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-2.5 rounded-lg font-bold tracking-wider transition shadow-lg shadow-emerald-900/30 uppercase" data-task="EV_THROTTLE">
                  Accept
                </button>
                <button class="dash-reject-btn flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2.5 rounded-lg font-bold tracking-wider transition uppercase">
                  Decline
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. BOTTOM ACTION: DOWNLOAD RECOMMENDED DISPATCH CSV -->
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <h4 class="text-white font-mono font-bold text-sm flex items-center gap-2">
              <span class="text-emerald-400">📁</span> Recommended Dispatch Telemetry Ledger
            </h4>
            <p class="text-xs text-slate-400 mt-0.5">
              Exports full 24-hr recalculated hourly load, minimized solar generation, and recommended shedding commands into CSV.
            </p>
          </div>
          <button id="btn-download-csv" class="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-bold tracking-wider transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 uppercase">
            <span>📥</span> Download Recommended Data (.CSV)
          </button>
        </div>
      </div>
    `;

    this.drawDashboardChart();
    this.bindDashboardProposalActions(container);
    this.bindCsvDownloadAction();
  }

  // Generates and downloads the complete CSV record
  bindCsvDownloadAction() {
    const downloadBtn = document.getElementById('btn-download-csv');
    if (!downloadBtn) return;

    downloadBtn.onclick = () => {
      const headers = [
        "Date",
        "Timestamp",
        "Raw_Campus_Demand_kW",
        "Minimized_Solar_Gen_kW",
        "Net_Power_Grid_Baseline_kW",
        "Optimal_Power_Grid_Shifted_kW",
        "Delta_Relief_kW",
        "Recommended_Action",
        "Feeder_Target"
      ];

      const csvRows = [headers.join(",")];

      this.adjustedIntervals.forEach((row) => {
        let action = "NORMAL_DISPATCH";
        let feeder = "GRID_TIED";
        const hour = parseInt(row.timestamp.split(":")[0], 10);

        if (hour >= 11 && hour <= 14) {
          action = "ABSORB_SOLAR_PRE_CHARGE";
          feeder = "WATER_PUMP_AND_BESS";
        } else if (hour >= 17 && hour <= 20) {
          action = "SHED_AND_THROTTLE_PEAK";
          feeder = "EV_CHARGING_PLAZA_AND_PUMP";
        }

        const dataLine = [
          this.selectedDate,
          row.timestamp,
          row.campus_demand_kw,
          row.solar_minimized_kw,
          row.net_grid_baseline_kw,
          row.optimal_grid_shifted_kw,
          row.curtailed_kw,
          action,
          feeder
        ];

        csvRows.push(dataLine.join(","));
      });

      const csvContent = "data:text/csv;charset=utf-8," + encodeURIComponent(csvRows.join("\n"));
      const link = document.createElement("a");
      link.setAttribute("href", csvContent);
      link.setAttribute("download", `PeakShift_Recommended_Dispatch_${this.selectedDate}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
  }

  bindDashboardProposalActions(container) {
    container.querySelectorAll('.dash-approve-btn').forEach(btn => {
      btn.onclick = async () => {
        const task = btn.getAttribute('data-task');
        await logAuditToDatabase({
          operator: this.operator.name,
          designation: this.operator.designation,
          action: 'DISPATCH_ACCEPTED',
          task_id: task,
          timestamp: new Date().toISOString()
        });
        btn.textContent = 'Accepted ✔';
        btn.classList.remove('bg-emerald-600', 'hover:bg-emerald-500');
        btn.classList.add('bg-slate-800', 'text-emerald-400', 'cursor-not-allowed');
        btn.disabled = true;
        alert(`Accepted proposal: ${task}. Recorded in audit ledger.`);
      };
    });

    container.querySelectorAll('.dash-reject-btn').forEach(btn => {
      btn.onclick = () => {
        btn.textContent = 'Declined ✖';
        btn.classList.add('text-red-400', 'cursor-not-allowed');
        btn.disabled = true;
      };
    });
  }

  drawDashboardChart() {
    const svg = document.getElementById('demand-svg');
    const tooltip = document.getElementById('chart-tooltip');
    if (!svg) return;

    const intervals = this.adjustedIntervals;
    const maxVal = Math.max(...intervals.map(i => Math.max(i.net_grid_baseline_kw, i.optimal_grid_shifted_kw, i.solar_minimized_kw))) * 1.15;

    const pointsOrig = intervals.map((pt, i) => `${(i / 23) * 880 + 10},${250 - (pt.net_grid_baseline_kw / maxVal) * 220}`).join(' ');
    const pointsShift = intervals.map((pt, i) => `${(i / 23) * 880 + 10},${250 - (pt.optimal_grid_shifted_kw / maxVal) * 220}`).join(' ');
    const pointsSolar = intervals.map((pt, i) => `${(i / 23) * 880 + 10},${250 - (pt.solar_minimized_kw / maxVal) * 220}`).join(' ');

    svg.innerHTML = `
      <polyline fill="none" stroke="#eab308" stroke-width="2" stroke-dasharray="3,3" points="${pointsSolar}" />
      <polyline fill="none" stroke="#ef4444" stroke-width="2.5" points="${pointsOrig}" />
      <polyline fill="none" stroke="#10b981" stroke-width="2.5" points="${pointsShift}" />
      <rect id="hit-zone" x="0" y="0" width="900" height="280" fill="transparent" />
    `;

    svg.onmousemove = (e) => {
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 900;
      const idx = Math.min(23, Math.max(0, Math.round(((x - 10) / 880) * 23)));
      const pt = intervals[idx];

      tooltip.classList.remove('hidden');
      tooltip.style.left = `${Math.min(rect.width - 190, Math.max(10, e.clientX - rect.left))}px`;
      tooltip.style.top = `10px`;
      tooltip.innerHTML = `
        <div class="text-slate-300 font-bold">${pt.timestamp}</div>
        <div class="text-red-400">Net Baseline: ${pt.net_grid_baseline_kw} kW</div>
        <div class="text-emerald-400">Optimal Shift: ${pt.optimal_grid_shifted_kw} kW</div>
        <div class="text-yellow-400">Solar Offset: -${pt.solar_minimized_kw} kW</div>
      `;
    };

    svg.onmouseleave = () => tooltip.classList.add('hidden');
  }

  // =========================================================================
  // MODEL EVOLUTION VIEW
  // =========================================================================
  renderModelEvolution(container) {
    container.innerHTML = `
      <div class="space-y-6">
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full bg-emerald-400 animate-ping"></span>
              <h2 class="text-base font-bold text-white font-mono">Model Evolution Engine</h2>
            </div>
            <p class="text-xs text-slate-400 mt-1">Live Quantile Gradient Boosting (P10–P90 bands) + Isolation Forest Stream scoring.</p>
          </div>
          <div class="flex items-center gap-3 font-mono text-xs">
            <span id="supabase-sync-badge" class="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-emerald-400 text-[10px]">
              🔒 Supabase Sync Active (${this.supabaseSyncCount})
            </span>
            <button id="btn-toggle-stream" class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition">
              ${this.isStreamRunning ? '⏸ Pause Stream' : '▶ Resume Stream'}
            </button>
            <button id="btn-clear-stream" class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition">
              Clear Buffer
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 font-mono">
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-cyan-500">
            <div class="text-xs text-slate-400">MEASURED STREAM LOAD</div>
            <div id="ml-live-kw" class="text-2xl font-bold text-cyan-400 mt-1">-- kW</div>
            <div class="text-[11px] text-slate-400 mt-1">Live Sampling Ticker</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-emerald-500">
            <div class="text-xs text-slate-400">XGBOOST P50 MEDIAN</div>
            <div id="ml-p50-kw" class="text-2xl font-bold text-emerald-400 mt-1">-- kW</div>
            <div class="text-[11px] text-emerald-300 mt-1">Expected Path Trajectory</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-purple-500">
            <div class="text-xs text-slate-400">QUANTILE UNCERTAINTY (P10-P90)</div>
            <div id="ml-spread-kw" class="text-2xl font-bold text-purple-400 mt-1">-- kW</div>
            <div class="text-[11px] text-purple-300 mt-1">Confidence Envelope Band</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-amber-500">
            <div class="text-xs text-slate-400">ISOLATION FOREST SCORE</div>
            <div id="ml-anomaly-score" class="text-2xl font-bold text-amber-400 mt-1">--</div>
            <div id="ml-anomaly-status" class="text-[11px] text-emerald-400 mt-1 font-bold">NOMINAL</div>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <div class="flex justify-between items-center mb-4">
            <div>
              <h3 class="text-sm font-semibold text-white font-mono">1. Live Continuous Demand vs Quantile Band</h3>
              <p class="text-xs text-slate-400">Continuous time step progression with shaded P10-P90 variance area.</p>
            </div>
            <div class="flex gap-4 text-xs font-mono">
              <span class="text-cyan-400">● Actual Measured</span>
              <span class="text-emerald-400">● P50 Median Forecast</span>
              <span class="text-purple-400 opacity-60">■ P10–P90 Band</span>
            </div>
          </div>
          <svg id="ml-continuous-svg" viewBox="0 0 900 240" class="w-full h-64 overflow-visible font-mono"></svg>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <div class="flex justify-between items-center mb-4">
            <div>
              <h3 class="text-sm font-semibold text-white font-mono">2. Real-Time Isolation Forest Anomaly Metric</h3>
              <p class="text-xs text-slate-400">Continuously evaluating tree depth. Red line = Deviation alert (>0.55).</p>
            </div>
            <span class="text-xs font-mono text-slate-400">Threshold: 0.55</span>
          </div>
          <svg id="ml-anomaly-svg" viewBox="0 0 900 160" class="w-full h-40 overflow-visible font-mono"></svg>
        </div>
      </div>
    `;

    document.getElementById('btn-toggle-stream').onclick = () => {
      this.isStreamRunning = !this.isStreamRunning;
      document.getElementById('btn-toggle-stream').textContent = this.isStreamRunning ? '⏸ Pause Stream' : '▶ Resume Stream';
    };

    document.getElementById('btn-clear-stream').onclick = () => {
      this.streamHistory = [];
      this.drawContinuousCharts();
    };

    if (this.streamHistory.length === 0) {
      const base = this.adjustedIntervals[18]?.net_grid_baseline_kw || 600;
      for (let i = 0; i < 25; i++) {
        this.streamSec += 1;
        const step = demandForecaster.computeStreamStep(this.streamSec, base);
        const anom = anomalyDetector.evaluateTelemetry(step.actual_kw, 414 + (Math.random()-0.5)*15, 50 + (Math.random()-0.5)*0.3);
        this.streamHistory.push({ ...step, ...anom, t: this.streamSec });
      }
    }

    this.drawContinuousCharts();
    this.startContinuousStream();
  }

  startContinuousStream() {
    this.streamTimer = setInterval(async () => {
      if (!this.isStreamRunning) return;

      this.streamSec += 1;
      const baseLoad = this.adjustedIntervals[18]?.net_grid_baseline_kw || 620;
      
      const step = demandForecaster.computeStreamStep(this.streamSec, baseLoad);
      const voltage = 415 + (Math.random() - 0.5) * 18;
      const freq = 50.0 + (Math.random() - 0.5) * 0.4;
      const anom = anomalyDetector.evaluateTelemetry(step.actual_kw, voltage, freq);

      const streamRecord = { ...step, ...anom, t: this.streamSec };
      this.streamHistory.push(streamRecord);
      if (this.streamHistory.length > this.maxStreamPoints) {
        this.streamHistory.shift();
      }

      if (this.streamSec % 3 === 0) {
        await storePredictionOutcome({
          operator_id: this.operator.name,
          actual_kw: streamRecord.actual_kw,
          p10_kw: streamRecord.p10_kw,
          p50_kw: streamRecord.p50_kw,
          p90_kw: streamRecord.p90_kw,
          anomaly_score: streamRecord.anomaly_score,
          anomaly_status: streamRecord.status,
          voltage,
          frequency: freq
        });
        this.supabaseSyncCount += 1;
        const syncBadge = document.getElementById('supabase-sync-badge');
        if (syncBadge) syncBadge.textContent = `🔒 Supabase Sync Active (${this.supabaseSyncCount})`;
      }

      const liveKwEl = document.getElementById('ml-live-kw');
      const p50El = document.getElementById('ml-p50-kw');
      const spreadEl = document.getElementById('ml-spread-kw');
      const scoreEl = document.getElementById('ml-anomaly-score');
      const statusEl = document.getElementById('ml-anomaly-status');

      if (liveKwEl) liveKwEl.textContent = `${step.actual_kw} kW`;
      if (p50El) p50El.textContent = `${step.p50_kw} kW`;
      if (spreadEl) spreadEl.textContent = `± ${(step.p90_kw - step.p10_kw).toFixed(1)} kW`;
      if (scoreEl) scoreEl.textContent = anom.anomaly_score;
      if (statusEl) {
        statusEl.textContent = anom.status;
        statusEl.className = anom.is_anomaly ? 'text-[11px] text-red-400 font-bold' : 'text-[11px] text-emerald-400 font-bold';
      }

      this.drawContinuousCharts();
    }, 1000);
  }

  drawContinuousCharts() {
    const cSvg = document.getElementById('ml-continuous-svg');
    const aSvg = document.getElementById('ml-anomaly-svg');
    if (!cSvg || !aSvg || this.streamHistory.length < 2) return;

    const maxKw = Math.max(...this.streamHistory.map(d => Math.max(d.actual_kw, d.p90_kw))) * 1.08;
    const minKw = Math.min(...this.streamHistory.map(d => Math.min(d.actual_kw, d.p10_kw))) * 0.92;

    const getX = (i) => (i / (this.maxStreamPoints - 1)) * 880 + 10;
    const getY = (val) => 220 - ((val - minKw) / (maxKw - minKw || 1)) * 190;

    let upPath = '';
    let dnPath = '';
    let p50Path = '';
    let actPath = '';

    this.streamHistory.forEach((pt, i) => {
      const x = getX(i);
      const yP10 = getY(pt.p10_kw);
      const yP50 = getY(pt.p50_kw);
      const yP90 = getY(pt.p90_kw);
      const yAct = getY(pt.actual_kw);

      upPath += `${i === 0 ? 'M' : 'L'} ${x} ${yP90} `;
      dnPath = `L ${x} ${yP10} ` + dnPath;
      p50Path += `${i === 0 ? 'M' : 'L'} ${x} ${y50Path ? yP50 : yP50} `;
      actPath += `${i === 0 ? 'M' : 'L'} ${x} ${yAct} `;
    });

    cSvg.innerHTML = `
      <line x1="10" y1="30" x2="890" y2="30" stroke="#1e293b" stroke-width="1" />
      <line x1="10" y1="120" x2="890" y2="120" stroke="#1e293b" stroke-width="1" />
      <line x1="10" y1="210" x2="890" y2="210" stroke="#1e293b" stroke-width="1" />
      <path d="${upPath} ${dnPath} Z" fill="rgba(168, 85, 247, 0.15)" stroke="none" />
      <path d="${p50Path}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" />
      <path d="${actPath}" fill="none" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round" />
    `;

    let anomPath = '';
    const getAnomY = (score) => 140 - (score / 1.0) * 120;
    const threshY = getAnomY(0.55);

    this.streamHistory.forEach((pt, i) => {
      const x = getX(i);
      const y = getAnomY(pt.anomaly_score);
      anomPath += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
    });

    aSvg.innerHTML = `
      <line x1="10" y1="${threshY}" x2="890" y2="${threshY}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4,4" />
      <path d="${anomPath}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" />
    `;
  }

  // =========================================================================
  // ANALYSIS VIEW
  // =========================================================================
  renderAnalysis(container) {
    const m = this.netMetrics;
    const intervals = this.adjustedIntervals;

    container.innerHTML = `
      <div class="space-y-6">
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h2 class="text-lg font-bold text-white font-mono">Net Load Shift Target & Variance Analysis</h2>
            <p class="text-xs text-slate-400 mt-1">Solar generation subtracted to isolate direct net grid relief metrics.</p>
          </div>
          <div class="flex gap-4 text-xs font-mono">
            <span class="text-red-400">● Net Grid Baseline</span>
            <span class="text-emerald-400">● Achieved Shift</span>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 font-mono">
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-emerald-500">
            <div class="text-xs text-slate-400">ACHIEVED SHIFT TARGET</div>
            <div class="text-2xl font-bold text-emerald-400 mt-1">${m.reduction_percentage}% Cut</div>
            <div class="text-[11px] text-slate-400 mt-1">Net Grid Peak Band</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-red-500">
            <div class="text-xs text-slate-400">NET PEAK REDUCTION</div>
            <div class="text-2xl font-bold text-white mt-1">-${m.peak_reduction_kw} kW</div>
            <div class="text-[11px] text-emerald-400 mt-1">From ${m.net_baseline_peak} to ${m.optimal_shifted_peak} kW</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-cyan-500">
            <div class="text-xs text-slate-400">TOTAL ENERGY SHIFTED</div>
            <div class="text-2xl font-bold text-cyan-400 mt-1">${m.total_shifted_kwh} kWh</div>
            <div class="text-[11px] text-slate-400 mt-1">Conserved Energy Transfer</div>
          </div>
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl border-l-4 border-l-yellow-500">
            <div class="text-xs text-slate-400">SOLAR OFFSET CONSUMED</div>
            <div class="text-2xl font-bold text-yellow-400 mt-1">${m.total_solar_kwh} kWh</div>
            <div class="text-[11px] text-yellow-300 mt-1">Direct Midday Offset</div>
          </div>
        </div>

        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <div class="flex justify-between items-center mb-4">
            <div>
              <h3 class="text-sm font-semibold text-white font-mono">24-Hour Net Grid Shift Curve</h3>
              <p class="text-xs text-slate-400">Hover for Net Baseline vs Optimal Grid values at each hour.</p>
            </div>
            <div id="analysis-hover-readout" class="text-xs font-mono text-emerald-400 bg-slate-950 px-3 py-1 rounded border border-slate-800">
              Hover over graph
            </div>
          </div>
          <div class="relative">
            <svg id="analysis-load-svg" viewBox="0 0 900 250" class="w-full h-64 overflow-visible font-mono cursor-crosshair"></svg>
          </div>
        </div>
      </div>
    `;

    this.drawAnalysisGraph(intervals);
  }

  drawAnalysisGraph(intervals) {
    const loadSvg = document.getElementById('analysis-load-svg');
    const readout = document.getElementById('analysis-hover-readout');
    if (!loadSvg) return;

    const maxVal = Math.max(...intervals.map(i => Math.max(i.net_grid_baseline_kw, i.optimal_grid_shifted_kw))) * 1.15;
    const getX = (idx) => (idx / 23) * 860 + 20;
    const getY = (val) => 220 - (val / maxVal) * 190;

    let origPoly = '';
    let shiftPoly = '';

    intervals.forEach((pt, i) => {
      const x = getX(i);
      origPoly += `${x},${getY(pt.net_grid_baseline_kw)} `;
      shiftPoly += `${x},${getY(pt.optimal_grid_shifted_kw)} `;
    });

    loadSvg.innerHTML = `
      <rect x="${getX(17)}" y="20" width="${getX(20) - getX(17)}" height="200" fill="rgba(239, 68, 68, 0.08)" stroke="rgba(239, 68, 68, 0.25)" stroke-dasharray="4,4" />
      <line x1="20" y1="30" x2="880" y2="30" stroke="#1e293b" stroke-width="1" />
      <line x1="20" y1="125" x2="880" y2="125" stroke="#1e293b" stroke-width="1" />
      <line x1="20" y1="220" x2="880" y2="220" stroke="#1e293b" stroke-width="1" />

      <polyline fill="none" stroke="#ef4444" stroke-width="2.5" points="${origPoly.trim()}" />
      <polyline fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" points="${shiftPoly.trim()}" />

      ${intervals.map((pt, i) => i % 3 === 0 ? `<text x="${getX(i)}" y="240" fill="#94a3b8" font-size="10" text-anchor="middle">${pt.timestamp}</text>` : '').join('')}
      
      <line id="analysis-crosshair" x1="0" y1="20" x2="0" y2="220" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3,3" class="hidden" />
      <rect id="analysis-hit" x="20" y="20" width="860" height="200" fill="transparent" />
    `;

    const hit = document.getElementById('analysis-hit');
    const crosshair = document.getElementById('analysis-crosshair');
    if (hit && crosshair) {
      hit.onmousemove = (e) => {
        const rect = loadSvg.getBoundingClientRect();
        const mouseX = ((e.clientX - rect.left) / rect.width) * 900;
        const idx = Math.min(23, Math.max(0, Math.round(((mouseX - 20) / 860) * 23)));
        const pt = intervals[idx];
        const cx = getX(idx);

        crosshair.setAttribute('x1', cx);
        crosshair.setAttribute('x2', cx);
        crosshair.classList.remove('hidden');

        readout.innerHTML = `Time: <strong>${pt.timestamp}</strong> | Net Base: <span class="text-red-400">${pt.net_grid_baseline_kw} kW</span> | Optimal: <span class="text-emerald-400">${pt.optimal_grid_shifted_kw} kW</span>`;
      };

      hit.onmouseleave = () => {
        crosshair.classList.add('hidden');
        readout.textContent = 'Hover over graph';
      };
    }
  }

  // =========================================================================
  // APPROVALS VIEW
  // =========================================================================
  renderApprovals(container) {
    container.innerHTML = `
      <div class="space-y-6">
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex justify-between items-center">
          <div>
            <h2 class="text-base font-semibold text-white">Manual Sign-Off & Action Gateway</h2>
            <p class="text-xs text-slate-400 mt-1">Recommendations require explicit operator authorization before physical execution.</p>
          </div>
          <button id="btn-back-dash" class="text-xs text-slate-400 hover:text-white font-mono">← Back to Dashboard</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl flex flex-col justify-between">
            <div>
              <span class="text-xs font-mono text-emerald-400 font-bold">PROPOSAL #01</span>
              <h3 class="text-white font-semibold mt-1">Pumping Station Reschedule</h3>
              <p class="text-xs text-slate-400 mt-2">Shift 17:00–20:00 active pumping cycles to solar window.</p>
            </div>
            <div class="flex gap-2 mt-4 pt-3 border-t border-slate-800">
              <button class="approve-btn flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-2 rounded font-medium transition" data-task="PUMP_SHIFT">Accept</button>
              <button class="reject-btn flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2 rounded font-medium transition">Decline</button>
            </div>
          </div>

          <div class="bg-slate-900 border border-slate-800 p-4 rounded-xl flex flex-col justify-between">
            <div>
              <span class="text-xs font-mono text-emerald-400 font-bold">PROPOSAL #02</span>
              <h3 class="text-white font-semibold mt-1">EV Hub Managed Throttling</h3>
              <p class="text-xs text-slate-400 mt-2">Throttle 17:00–20:00 EV fast chargers; defer balance overnight.</p>
            </div>
            <div class="flex gap-2 mt-4 pt-3 border-t border-slate-800">
              <button class="approve-btn flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-2 rounded font-medium transition" data-task="EV_THROTTLE">Accept</button>
              <button class="reject-btn flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs py-2 rounded font-medium transition">Decline</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('btn-back-dash').onclick = () => {
      this.currentView = 'dashboard';
      this.renderView();
    };

    container.querySelectorAll('.approve-btn').forEach(btn => {
      btn.onclick = async () => {
        const task = btn.getAttribute('data-task');
        await logAuditToDatabase({
          operator: this.operator.name,
          designation: this.operator.designation,
          action: 'DISPATCH_ACCEPTED',
          task_id: task,
          timestamp: new Date().toISOString()
        });
        btn.textContent = 'Accepted ✔';
        btn.classList.add('opacity-70', 'cursor-not-allowed');
        btn.disabled = true;
        alert(`Accepted: ${task}. Recorded into audit ledger.`);
      };
    });

    container.querySelectorAll('.reject-btn').forEach(btn => {
      btn.onclick = () => {
        btn.textContent = 'Declined ✖';
        btn.classList.add('text-red-400', 'cursor-not-allowed');
        btn.disabled = true;
      };
    });
  }

  // =========================================================================
  // PROFILE VIEW
  // =========================================================================
  renderProfile(container) {
    container.innerHTML = `
      <div class="max-w-xl mx-auto bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-6">
        <h2 class="text-lg font-bold text-white border-b border-slate-800 pb-3">Operator Profile</h2>
        <div class="flex items-center gap-6">
          <div class="relative">
            <img id="prof-img" src="${this.operator.photo}" class="w-28 h-28 rounded-full object-cover border-2 border-emerald-500">
            <input type="file" id="photo-upload" class="hidden" accept="image/*">
            <button onclick="document.getElementById('photo-upload').click()" class="absolute bottom-0 right-0 bg-emerald-600 text-white p-1.5 rounded-full text-xs">📷</button>
          </div>
          <div class="flex-1 space-y-3 font-mono text-xs">
            <div>
              <label class="text-slate-400">Name</label>
              <input type="text" id="in-name" value="${this.operator.name}" class="w-full bg-slate-950 border border-slate-800 rounded p-2 text-white">
            </div>
            <div>
              <label class="text-slate-400">Age</label>
              <input type="number" id="in-age" value="${this.operator.age}" class="w-full bg-slate-950 border border-slate-800 rounded p-2 text-white">
            </div>
            <div>
              <label class="text-slate-400">Designation</label>
              <input type="text" id="in-desig" value="${this.operator.designation}" class="w-full bg-slate-950 border border-slate-800 rounded p-2 text-white">
            </div>
            <button id="save-prof" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2 rounded transition">Save Details</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('photo-upload').onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const r = new FileReader();
        r.onload = (ev) => {
          this.operator.photo = ev.target.result;
          document.getElementById('prof-img').src = ev.target.result;
        };
        r.readAsDataURL(file);
      }
    };

    document.getElementById('save-prof').onclick = () => {
      this.operator.name = document.getElementById('in-name').value;
      this.operator.age = document.getElementById('in-age').value;
      this.operator.designation = document.getElementById('in-desig').value;
      alert('Profile updated.');
    };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new EnterpriseEngine();
  document.getElementById('nav-dash').onclick = () => { app.currentView = 'dashboard'; app.renderView(); };
  document.getElementById('nav-ml').onclick = () => { app.currentView = 'ml'; app.renderView(); };
  document.getElementById('nav-analysis').onclick = () => { app.currentView = 'analysis'; app.renderView(); };
  document.getElementById('nav-appr').onclick = () => { app.currentView = 'approvals'; app.renderView(); };
  document.getElementById('nav-prof').onclick = () => { app.currentView = 'profile'; app.renderView(); };
});
