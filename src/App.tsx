/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Play, 
  Pause, 
  Trash2, 
  Settings, 
  Moon, 
  Sun, 
  X, 
  Zap, 
  Eraser, 
  Clock, 
  Volume2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateTTS } from './services/gemini';
import { AlarmRecord } from './types';

// Helper: Base64 to WAV Data URI
function base64ToWavDataURI(base64: string, sampleRate = 24000) {
  try {
    const binary = atob(base64);
    const len = binary.length;
    const buffer = new ArrayBuffer(44 + len);
    const view = new DataView(buffer);
    const writeString = (o: number, s: string) => { 
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); 
    };
    writeString(0, 'RIFF'); 
    view.setUint32(4, 36 + len, true); 
    writeString(8, 'WAVE'); 
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); 
    view.setUint16(20, 1, true); 
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); 
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); 
    view.setUint16(34, 16, true); 
    writeString(36, 'data'); 
    view.setUint32(40, len, true);
    const pcm = new Uint8Array(buffer, 44);
    for (let i = 0; i < len; i++) pcm[i] = binary.charCodeAt(i);
    const bytes = new Uint8Array(buffer);
    let binaryString = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binaryString += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
    }
    return 'data:audio/wav;base64,' + btoa(binaryString);
  } catch (e) { 
    return ""; 
  }
}

export default function App() {
  // State
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('gemini_api_key') || "");
  const [records, setRecords] = useState<AlarmRecord[]>(() => JSON.parse(localStorage.getItem('tts_alarms') || "[]"));
  const [inputText, setInputText] = useState<string>(() => localStorage.getItem('tts_draft') || "");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isNightMode, setIsNightMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [activePlaybackId, setActivePlaybackId] = useState<string | null>(null);
  const [isPlayingQueue, setIsPlayingQueue] = useState(false);
  const [playlistQueue, setPlaylistQueue] = useState<AlarmRecord[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());

  // Refs
  const mainPlayerRef = useRef<HTMLAudioElement | null>(null);
  const silentTrackerRef = useRef<HTMLAudioElement | null>(null);
  const textScrollRef = useRef<HTMLDivElement | null>(null);
  const wakeLockRef = useRef<any>(null);
  const fadeIntervalRef = useRef<any>(null);
  const autoCloseTimerRef = useRef<any>(null);
  const isUserScrollingRef = useRef(false);

  // Persistence
  useEffect(() => {
    localStorage.setItem('tts_alarms', JSON.stringify(records));
  }, [records]);

  useEffect(() => {
    localStorage.setItem('tts_draft', inputText);
  }, [inputText]);

  useEffect(() => {
    localStorage.setItem('gemini_api_key', apiKey);
  }, [apiKey]);

  // Clock & Alarm Checker
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);
      
      const hhmm = now.getHours().toString().padStart(2, '0') + now.getMinutes().toString().padStart(2, '0');
      const seconds = now.getSeconds();

      // Only check at the start of a minute
      if (seconds === 0) {
        records.forEach(r => {
          if (r.enabled && r.time === hhmm) {
            startPlayback(r);
          }
        });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [records]);

  // Audio Unlock
  useEffect(() => {
    const unlock = () => {
      if (silentTrackerRef.current) {
        silentTrackerRef.current.play().catch(() => {});
      }
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('click', unlock);
    return () => {
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('click', unlock);
    };
  }, []);

  // Wake Lock
  useEffect(() => {
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && isNightMode) {
        try {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        } catch (err) {
          console.error(`Wake Lock error: ${err}`);
        }
      } else if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };
    requestWakeLock();
  }, [isNightMode]);

  // Playback Logic
  const startPlayback = (record: AlarmRecord, fromQueue = false) => {
    if (mainPlayerRef.current) {
      mainPlayerRef.current.pause();
      mainPlayerRef.current.currentTime = 0;
    }
    if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);

    if (!fromQueue) {
      setPlaylistQueue([]);
      setIsPlayingQueue(false);
    }

    const dataUri = base64ToWavDataURI(record.audioBase64);
    if (!dataUri || !mainPlayerRef.current) return;

    const audio = mainPlayerRef.current;
    audio.src = dataUri;
    audio.playbackRate = 0.85;
    audio.preservesPitch = true;
    audio.load();

    setActivePlaybackId(record.id);

    // Fade In
    const targetVolume = record.volume || 0.3;
    audio.volume = targetVolume / 3;
    let step = 0;
    const fadeSteps = 50;
    const stepVol = (targetVolume - audio.volume) / fadeSteps;
    
    fadeIntervalRef.current = setInterval(() => {
      step++;
      if (audio && !audio.paused && step <= fadeSteps) {
        audio.volume = Math.min(targetVolume, audio.volume + stepVol);
      } else if (step > fadeSteps) {
        clearInterval(fadeIntervalRef.current);
      }
    }, 100);

    let repeatCount = 0;
    const playLoop = () => {
      audio.play().catch(e => console.warn("Playback blocked", e));
      
      audio.onended = () => {
        repeatCount++;
        if (repeatCount < (record.repeats || 1)) {
          setTimeout(playLoop, (record.interval || 5) * 1000);
        } else {
          if (fromQueue && playlistQueue.length > 0) {
            // This is handled by a separate queue effect or callback
          } else {
            autoCloseTimerRef.current = setTimeout(() => {
              setActivePlaybackId(null);
            }, 10000);
          }
        }
      };
    };

    playLoop();
  };

  const stopPlayback = () => {
    if (mainPlayerRef.current) {
      mainPlayerRef.current.pause();
      mainPlayerRef.current.currentTime = 0;
    }
    if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current);
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    setActivePlaybackId(null);
    setIsPlayingQueue(false);
    setPlaylistQueue([]);
  };

  const togglePlay = (record: AlarmRecord) => {
    if (activePlaybackId === record.id) {
      stopPlayback();
    } else {
      startPlayback(record);
    }
  };

  // Generation
  const handleGenerate = async () => {
    if (!apiKey) {
      setShowSettings(true);
      return;
    }
    if (!inputText.trim() || isGenerating) return;

    setIsGenerating(true);
    try {
      const audioBase64 = await generateTTS(inputText, apiKey);
      const durationSec = Math.round(atob(audioBase64).length / 48000);
      
      const newRecord: AlarmRecord = {
        id: Date.now().toString(),
        text: inputText,
        audioBase64,
        durationSec,
        time: "0000",
        enabled: false,
        volume: 0.3,
        repeats: 3,
        interval: 5
      };

      setRecords(prev => [newRecord, ...prev]);
      setInputText("");
    } catch (err: any) {
      alert(`生成失敗: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAllPlay = () => {
    const offAlarms = [...records].filter(r => !r.enabled).sort((a, b) => a.time.localeCompare(b.time));
    if (offAlarms.length === 0) {
      alert("目前沒有設定為 OFF 的鬧鐘可供播放！");
      return;
    }
    setPlaylistQueue(offAlarms);
    setIsPlayingQueue(true);
  };

  // Queue Effect
  useEffect(() => {
    if (isPlayingQueue && !activePlaybackId && playlistQueue.length > 0) {
      const next = playlistQueue[0];
      setPlaylistQueue(prev => prev.slice(1));
      startPlayback(next, true);
    }
  }, [isPlayingQueue, activePlaybackId, playlistQueue]);

  // Render Helpers
  const sortedRecords = useMemo(() => {
    return [...records].sort((a, b) => a.time.localeCompare(b.time));
  }, [records]);

  const activeRecord = useMemo(() => {
    return records.find(r => r.id === activePlaybackId);
  }, [records, activePlaybackId]);

  return (
    <div className="min-h-screen bg-black text-white font-light overflow-x-hidden">
      {/* Hidden Audio Elements */}
      <audio ref={silentTrackerRef} loop playsinline src="data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA" className="hidden" />
      <audio ref={mainPlayerRef} playsinline className="hidden" />

      {/* Night Mode Overlay */}
      <AnimatePresence>
        {isNightMode && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[400] bg-black flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="absolute top-12 flex flex-col items-center gap-3">
              <AlertCircle className="text-amber-500 w-8 h-8" />
              <p className="text-amber-500/80 text-xs md:text-sm tracking-widest leading-relaxed max-w-[280px]">
                請保持充電並不要關閉螢幕。<br/>
                畫面已進入省電模式，時間到一定會響起。
              </p>
            </div>
            
            <div className="text-[3.5rem] md:text-[5rem] font-black text-indigo-500/50 font-mono tracking-tighter mt-10 tabular-nums">
              {currentTime.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}
            </div>

            <div className="mt-8 flex flex-col items-center gap-4">
              {sortedRecords.filter(r => r.enabled).slice(0, 3).map(r => (
                <div key={r.id} className="flex items-center gap-2 text-2xl text-white/50 font-mono tracking-wider">
                  <Clock className="w-5 h-5 opacity-70" />
                  {r.time.slice(0,2)}:{r.time.slice(2,4)}
                </div>
              ))}
              {sortedRecords.filter(r => r.enabled).length === 0 && (
                <div className="text-white/30 italic text-sm tracking-widest uppercase">無啟動中的鬧鐘</div>
              )}
            </div>
            
            <button 
              onClick={() => setIsNightMode(false)}
              className="absolute bottom-10 px-8 py-4 border border-white/20 text-white/60 rounded-full text-sm font-bold tracking-widest hover:bg-white/10"
            >
              退出夜間模式
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <div className="w-full max-w-3xl mx-auto px-2 pt-2 pb-24 flex flex-col gap-3 min-h-screen relative">
        
        {/* 1. Input / Playback Section */}
        <div className="relative h-[40vh] min-h-[300px] shrink-0">
          <AnimatePresence mode="wait">
            {!activePlaybackId ? (
              <motion.div 
                key="input"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-[#1a1a1a] rounded-[24px] border border-white/10 overflow-hidden shadow-2xl flex flex-col h-full"
              >
                <div className="relative w-full flex-1 bg-black">
                  <textarea 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    className="absolute inset-0 w-full h-full p-4 bg-transparent focus:outline-none resize-none text-lg text-white/80 placeholder:text-white/10 font-normal leading-relaxed tracking-wide" 
                    placeholder="輸入文字...&#10;支援：小美：你好&#10;支援：小明：你好"
                  />
                </div>
                
                <div className="p-1.5 bg-white/5 border-t border-white/10 flex items-center justify-between gap-1.5 shrink-0">
                  <button 
                    onClick={handleAllPlay}
                    className="px-2 py-1.5 bg-indigo-600/20 rounded-lg border border-indigo-500/30 text-[12px] font-bold text-indigo-300 min-w-[60px] text-center flex items-center justify-center gap-1 hover:bg-indigo-600 hover:text-white transition-colors"
                  >
                    <Play className="w-3 h-3" /> All
                  </button>
                  
                  <button 
                    onClick={() => {
                      if(confirm('確定要清空文字嗎？')) setInputText("");
                    }}
                    className="flex-1 py-1.5 rounded-lg bg-black border border-white/10 text-white/60 flex justify-center items-center h-9 text-xs font-bold gap-1 active:bg-white/10"
                  >
                    <Eraser className="w-3 h-3" /> 清空
                  </button>

                  <button 
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className="flex-[2] py-1.5 rounded-lg text-[13px] font-bold bg-zinc-200 text-zinc-800 active:scale-95 transition-all flex items-center justify-center gap-1.5 h-9 disabled:opacity-50"
                  >
                    {isGenerating ? <div className="animate-spin"><Zap className="w-4 h-4" /></div> : <Zap className="w-4 h-4" />}
                    <span>{isGenerating ? "連線中..." : "生成"}</span>
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="playback"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="relative h-full bg-[#1a1a1a] rounded-[24px] border border-white/10 overflow-hidden shadow-2xl flex flex-col"
              >
                <button 
                  onClick={stopPlayback}
                  className="absolute top-2 right-2 z-50 p-2 text-white/50 hover:text-white transition-colors bg-black/20 rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>

                <div 
                  ref={textScrollRef}
                  className="flex-1 py-16 px-6 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-thumb-white/20"
                  onScroll={() => {
                    isUserScrollingRef.current = true;
                    setTimeout(() => { isUserScrollingRef.current = false; }, 3000);
                  }}
                >
                  <h2 className="text-[17px] font-normal leading-relaxed text-left whitespace-pre-wrap break-words select-text">
                    {activeRecord?.text.replace(/ \.\.\. /g, '。')}
                  </h2>
                </div>

                <div className="absolute bottom-4 right-4 z-50">
                  <button 
                    onClick={() => {
                      if(mainPlayerRef.current) {
                        if(mainPlayerRef.current.paused) mainPlayerRef.current.play();
                        else mainPlayerRef.current.pause();
                      }
                    }}
                    className="w-12 h-12 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20"
                  >
                    {mainPlayerRef.current?.paused ? <Play className="w-6 h-6 fill-white" /> : <Pause className="w-6 h-6 fill-white" />}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 2. Alarm List */}
        <div className="flex flex-col gap-1.5 w-full">
          {sortedRecords.map(r => (
            <div 
              key={r.id} 
              className={`bg-[#1a1a1a] rounded-[16px] border p-2 flex flex-col gap-1.5 transition-all ${r.enabled ? 'border-white/20 shadow-md' : 'border-white/5 opacity-80'}`}
            >
              <div className="flex items-center gap-1.5 w-full">
                <input 
                  type="text" 
                  inputmode="numeric" 
                  maxlength={4} 
                  value={r.time} 
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const val = e.target.value.padStart(4, '0');
                    setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, time: val } : rec));
                  }}
                  className="w-12 h-9 bg-black border border-white/10 rounded-lg text-white font-mono text-center outline-none focus:border-indigo-500 text-base tracking-wider font-bold shrink-0" 
                />
                
                <button 
                  onClick={() => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, enabled: !rec.enabled } : rec))}
                  className={`w-8 h-6 ml-2 shrink-0 rounded-md font-bold text-[9px] transition-all ${r.enabled ? 'bg-green-500 text-white' : 'bg-white/10 text-white/30'}`}
                >
                  {r.enabled ? 'ON' : 'OFF'}
                </button>

                <div className="flex-1"></div> 

                <div className="flex items-center bg-black border border-white/10 rounded-lg w-10 h-8 shrink-0">
                  <input 
                    type="number" 
                    min="1" 
                    value={r.repeats} 
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, repeats: parseInt(e.target.value) || 1 } : rec))}
                    className="bg-transparent text-indigo-300 font-bold w-full text-center outline-none text-[13px]" 
                  />
                </div>

                <div className="flex items-center bg-black border border-white/10 rounded-lg w-14 h-8 px-1 gap-0.5 shrink-0">
                  <input 
                    type="number" 
                    min="0" 
                    value={r.interval} 
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, interval: parseInt(e.target.value) || 0 } : rec))}
                    className="bg-transparent text-amber-300 font-bold w-full text-center outline-none text-[13px]" 
                  />
                  <span className="text-[8px] text-white/40">秒</span>
                </div>

                <button 
                  onClick={() => {
                    if(activePlaybackId === r.id) stopPlayback();
                    setRecords(prev => prev.filter(rec => rec.id !== r.id));
                  }}
                  className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center hover:bg-white/20 transition-colors opacity-90 hover:opacity-100 text-sm shrink-0"
                >
                  <Trash2 className="w-4 h-4 text-white/60" />
                </button>
              </div>

              <div className="bg-black/90 rounded-lg p-1.5 flex items-center gap-2 border border-white/5 shadow-inner relative overflow-hidden">
                {activePlaybackId === r.id && (
                  <motion.div 
                    layoutId="progress"
                    className="absolute bottom-0 left-0 h-0.5 bg-indigo-500 w-full"
                    initial={{ scaleX: 0, originX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: r.durationSec, ease: "linear" }}
                  />
                )}
                
                <div className="flex items-center gap-2 shrink-0 z-10 w-[4.5rem]">
                  <button 
                    onClick={() => togglePlay(r)}
                    className={`flex items-center justify-center transition-all bg-transparent hover:scale-110 active:scale-95 ${activePlaybackId === r.id ? 'text-green-500 opacity-100 drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]' : 'text-orange-500 opacity-80 hover:opacity-100'}`}
                  >
                    {activePlaybackId === r.id ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
                  </button>
                  <span className="text-xs font-bold text-white drop-shadow-sm font-mono tracking-tighter">{r.durationSec}s</span>
                </div>

                <div className="flex-1 min-w-0 text-[10px] text-white/60 truncate font-light z-10 leading-tight">
                  {r.text.replace(/\n/g, ' ')}
                </div>

                <div className="w-32 sm:w-40 flex flex-col gap-0.5 shrink-0 z-10">
                  <div className="flex items-center gap-1">
                    <Volume2 className="w-3 h-3 text-white/40" />
                    <input 
                      type="range" 
                      min="0" 
                      max="1" 
                      step="0.01" 
                      value={r.volume} 
                      onChange={(e) => setRecords(prev => prev.map(rec => rec.id === r.id ? { ...rec, volume: parseFloat(e.target.value) } : rec))}
                      className="flex-1 h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white" 
                    />
                  </div>
                  <div className="flex justify-between text-[8px] font-bold text-white/50 px-1 font-mono tracking-tighter">
                    <span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 3. Bottom Controls */}
        <div className="flex gap-1.5 shrink-0 mt-2">
          <div className="flex-1 flex items-center justify-between px-3 py-1.5 bg-[#1a1a1a] rounded-xl border border-white/5">
            <div className="flex items-center gap-2 text-[10px] text-green-500/80 tracking-widest font-bold">
              <CheckCircle2 className="w-3 h-3" />
              <span>就緒 ({records.filter(r => r.enabled).length}項)</span>
            </div>
            <button 
              onClick={() => setShowSettings(true)}
              className="px-3 py-1 bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 rounded-lg hover:bg-indigo-600 hover:text-white transition-colors text-xs font-bold flex items-center gap-1"
            >
              <Settings className="w-3 h-3" /> ikey
            </button>
          </div>
          <button 
            onClick={() => setIsNightMode(true)}
            className="px-4 py-1.5 rounded-xl border bg-[#1a1a1a] border-white/5 text-white/60 hover:text-white text-xs font-bold flex items-center gap-1"
          >
            <Moon className="w-3 h-3" /> 夜間
          </button>
        </div>

      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[500] bg-black/95 flex flex-col items-center justify-center backdrop-blur-xl px-4"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl relative"
            >
              <h3 className="text-white text-lg font-bold mb-2">設定 API Key</h3>
              <p className="text-white/40 text-xs mb-4">
                請輸入 Google Gemini API 金鑰。<br/>
                <span className="text-amber-500">注意：請確保金鑰未設定「網站限制」(None)。</span>
              </p>
              
              <div className="relative w-full mb-4">
                <input 
                  type="password" 
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full bg-black border border-white/20 rounded-xl px-4 py-3 text-white outline-none focus:border-indigo-500 font-mono text-sm" 
                  placeholder="AIzaSy..."
                />
              </div>

              <div className="flex flex-col gap-2">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="w-full py-3 bg-indigo-600 text-white rounded-xl font-bold active:scale-95 transition-all text-sm"
                >
                  儲存並開始
                </button>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="w-full py-3 bg-white/5 text-white/40 rounded-xl text-sm hover:text-white"
                >
                  取消
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
