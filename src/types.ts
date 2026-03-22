export interface AlarmRecord {
  id: string;
  text: string;
  audioBase64: string;
  durationSec: number;
  time: string; // HHmm
  enabled: boolean;
  volume: number;
  repeats: number;
  interval: number;
}

export interface AppState {
  apiKey: string;
  records: AlarmRecord[];
  isGenerating: boolean;
  isNightMode: boolean;
  activePlaybackId: string | null;
  playlistQueue: AlarmRecord[];
  isPlayingQueue: boolean;
}
