export interface SatelliteInfo {
  key: string;
  talker: string;
  prn: string;
  elevation: number | null;
  azimuth: number | null;
  snr: number | null;
  used: boolean;
}

export interface GnssState {
  messageCount: number;
  errorCount: number;
  lastUpdateMs: number | null;
  lastSentenceType: string | null;
  talkersSeen: Set<string>;
  utcTime: Date | null;
  fixQuality: number | null;
  rmcActive: boolean | null;
  gsaFixType: number | null;
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  hdop: number | null;
  speedKnots: number | null;
  speedKmh: number | null;
  courseDeg: number | null;
  satsUsedCount: number | null;
  satsInViewTotal: number;
  satsInViewByTalker: Map<string, number>;
  usedKeys: Set<string>;
  sats: Map<string, SatelliteInfo>;
}