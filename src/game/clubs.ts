/** Club launch profiles at full power, based on published PGA Tour launch-monitor averages
 * (ball speed, launch angle, spin). Carry distances come out of the physics model. */
export interface Club {
  id: string;
  name: string;
  /** Full-swing ball speed, m/s. */
  ballSpeed: number;
  launchDeg: number;
  backspinRpm: number;
  isPutter?: boolean;
}

const MPH = 0.44704;

export const CLUBS: Club[] = [
  { id: "1W", name: "Driver", ballSpeed: 167 * MPH, launchDeg: 10.9, backspinRpm: 2686 },
  { id: "3W", name: "3 Wood", ballSpeed: 158 * MPH, launchDeg: 9.2, backspinRpm: 3655 },
  { id: "5W", name: "5 Wood", ballSpeed: 152 * MPH, launchDeg: 9.4, backspinRpm: 4350 },
  { id: "3I", name: "3 Iron", ballSpeed: 142 * MPH, launchDeg: 10.4, backspinRpm: 4630 },
  { id: "4I", name: "4 Iron", ballSpeed: 137 * MPH, launchDeg: 11.0, backspinRpm: 4836 },
  { id: "5I", name: "5 Iron", ballSpeed: 132 * MPH, launchDeg: 12.1, backspinRpm: 5361 },
  { id: "6I", name: "6 Iron", ballSpeed: 127 * MPH, launchDeg: 14.1, backspinRpm: 6231 },
  { id: "7I", name: "7 Iron", ballSpeed: 120 * MPH, launchDeg: 16.3, backspinRpm: 7097 },
  { id: "8I", name: "8 Iron", ballSpeed: 115 * MPH, launchDeg: 18.1, backspinRpm: 7998 },
  { id: "9I", name: "9 Iron", ballSpeed: 109 * MPH, launchDeg: 20.4, backspinRpm: 8647 },
  { id: "PW", name: "Pitching Wedge", ballSpeed: 102 * MPH, launchDeg: 24.2, backspinRpm: 9304 },
  { id: "GW", name: "Gap Wedge", ballSpeed: 95 * MPH, launchDeg: 27, backspinRpm: 9700 },
  { id: "SW", name: "Sand Wedge", ballSpeed: 88 * MPH, launchDeg: 30, backspinRpm: 10000 },
  { id: "LW", name: "Lob Wedge", ballSpeed: 75 * MPH, launchDeg: 36, backspinRpm: 10000 },
  { id: "PT", name: "Putter", ballSpeed: 9, launchDeg: 0, backspinRpm: 0, isPutter: true },
];

export const clubById = (id: string): Club => {
  const club = CLUBS.find((c) => c.id === id);
  if (!club) throw new Error(`unknown club ${id}`);
  return club;
};
