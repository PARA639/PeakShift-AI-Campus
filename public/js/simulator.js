export class LoadShiftSimulator {
  simulate(dayProfile, params) {
    const intervals = dayProfile.intervals;
    const peakHours = [17, 18, 19, 20];
    const solarHours = [10, 11, 12, 13, 14, 15]; // Solar generation window
    const nightHours = [22, 23, 1, 2, 3];

    let shiftedKwh = 0;
    const shiftedDemand = intervals.map(i => i.campus_demand_kw);

    const pumpFrac = (params.pumpPct / 100) * 0.45;
    const evFrac = (params.evPct / 100) * 0.35;
    const thermalFrac = (params.thermalPct / 100) * 0.20;

    peakHours.forEach(h => {
      const cut = shiftedDemand[h] * ((pumpFrac + evFrac + thermalFrac) / 3);
      shiftedDemand[h] -= cut;
      shiftedKwh += cut;
    });

    // 65% of shifted load is routed into daytime solar hours
    const solarAdd = (shiftedKwh * 0.65) / solarHours.length;
    const nightAdd = (shiftedKwh * 0.35) / nightHours.length;

    solarHours.forEach(h => { shiftedDemand[h] += solarAdd; });
    nightHours.forEach(h => { shiftedDemand[h] += nightAdd; });

    // Solar curve simulation (rated 500 kWp plant)
    const solarProfile = intervals.map(intv => {
      let solarKw = 0;
      if (intv.hour >= 6 && intv.hour <= 18) {
        solarKw = Number((500 * Math.pow(Math.sin(((intv.hour - 6) / 12) * Math.PI), 1.3) * 0.96).toFixed(1));
      }
      return solarKw;
    });

    const shiftedIntervals = intervals.map((intv, idx) => ({
      ...intv,
      simulated_solar_kw: solarProfile[idx],
      shifted_demand_kw: Number(shiftedDemand[idx].toFixed(1)),
      solar_absorbed_kw: Number(Math.min(solarProfile[idx], shiftedDemand[idx]).toFixed(1))
    }));

    const origPeak = Math.max(...intervals.map(i => i.campus_demand_kw));
    const newPeak = Math.max(...shiftedDemand);
    const peakCut = Number((origPeak - newPeak).toFixed(1));

    // Solar shift percentage
    const totalSolarGenerated = solarProfile.reduce((a, b) => a + b, 0);
    const solarShiftAchievedPct = Number(((shiftedKwh * 0.65 / (totalSolarGenerated || 1)) * 100).toFixed(1));

    return {
      shiftedIntervals,
      metrics: {
        original_peak: origPeak,
        shifted_peak: newPeak,
        peak_reduction_kw: peakCut,
        reduction_percentage: Number(((peakCut / origPeak) * 100).toFixed(1)),
        total_shifted_kwh: Number(shiftedKwh.toFixed(1)),
        solar_shift_pct: Math.min(100, solarShiftAchievedPct),
        energy_conserved: true
      }
    };
  }
}

export const simulator = new LoadShiftSimulator();
