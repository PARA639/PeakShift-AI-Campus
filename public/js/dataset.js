export class SmartMeterDataset {
  constructor() {
    this.isLoaded = false;
    this.dailyProfiles = {};
    this.availableDates = [];
  }

  async load() {
    if (this.isLoaded) return;
    const response = await fetch('/data/Peak_Shift_AI_Synthetic_Smart_Meter_1hour_90days.csv');
    const text = await response.text();
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);

    const dateMap = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCSVLine(lines[i]);
      if (cols.length < 7) continue;

      const ts = cols[0];
      const date = ts.substring(0, 10);
      const hour = parseInt(ts.substring(11, 13), 10);
      const bld = cols[1];
      const activePower = parseFloat(cols[6]) || 0;
      const voltage = parseFloat(cols[4]) || 415;
      const freq = parseFloat(cols[9]) || 50.0;

      if (!dateMap[date]) {
        dateMap[date] = {
          date,
          hours: Array.from({ length: 24 }, (_, h) => ({
            hour: h,
            timestamp: `${String(h).padStart(2, '0')}:00`,
            campus_demand_kw: 0,
            voltage_V_LL: voltage,
            frequency_Hz: freq,
            buildings: {}
          }))
        };
      }

      const hrObj = dateMap[date].hours[hour];
      hrObj.buildings[bld] = activePower;
      hrObj.campus_demand_kw += activePower;
    }

    Object.keys(dateMap).forEach(d => {
      const day = dateMap[d];
      let maxKw = 0;
      let pkHour = 0;
      let totalKwh = 0;

      day.hours.forEach(h => {
        h.campus_demand_kw = Number(h.campus_demand_kw.toFixed(1));
        totalKwh += h.campus_demand_kw;
        if (h.campus_demand_kw > maxKw) {
          maxKw = h.campus_demand_kw;
          pkHour = h.hour;
        }
      });

      this.dailyProfiles[d] = {
        date: d,
        intervals: day.hours,
        peak_kw: Number(maxKw.toFixed(1)),
        peak_hour: pkHour,
        total_kwh: Number(totalKwh.toFixed(0))
      };
    });

    this.availableDates = Object.keys(this.dailyProfiles).sort();
    this.isLoaded = true;
  }

  getDayProfile(dateStr) {
    return this.dailyProfiles[dateStr] || this.dailyProfiles[this.availableDates[0]];
  }

  parseCSVLine(text) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ',' && !inQuotes) {
        result.push(cur);
        cur = '';
      } else cur += c;
    }
    result.push(cur);
    return result;
  }
}

export const smartMeterDataset = new SmartMeterDataset();
